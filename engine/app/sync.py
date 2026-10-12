"""Replication between nodes.

Each node pulls from every peer on a timer: "here is what I have (my version vector), send me
what I am missing". Both sides run the same loop, so data flows in both directions, and any
node can relay another node's events (if Mumbai cannot reach Hyderabad but both reach
Singapore, they still converge).

Safety rules:
- Events from one origin are only ever applied in order, with no gaps. That keeps version
  vectors truthful, which the merge engine relies on to detect concurrent edits.
- Applying the same event twice does nothing.
- A node never syncs with a peer on a different epoch (see NodeState.reset).
"""
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import httpx

from .config import VALID_NODES

MAX_EVENTS_PER_SYNC = 500
REASON_BY_STATUS = {401: "unauthorized", 403: "blocked", 409: "epoch_mismatch", 503: "paused"}


@dataclass
class Peer:
    url: str
    id: Optional[str] = None  # learned from the first reply if not given in PEERS
    reachable: bool = False
    reason: Optional[str] = "never_contacted"
    last_sync: Optional[float] = None       # monotonic, for "x seconds ago"
    last_sync_wall: Optional[float] = None  # unix time, for display


def parse_peers(specs: list[str]) -> list[Peer]:
    """Accepts 'hyd=http://host:8002' (preferred) or a bare 'http://host:8002'."""
    peers = []
    for spec in specs:
        if "=" in spec and not spec.lower().startswith("http"):
            node_id, url = spec.split("=", 1)
            peers.append(Peer(url=url.strip().rstrip("/"), id=node_id.strip()))
        else:
            peers.append(Peer(url=spec.strip().rstrip("/")))
    return peers


class SyncManager:
    def __init__(self, node, post: Optional[Callable] = None):
        self.node = node
        self.peers = parse_peers(node.config.peers)
        self.known: dict[str, dict[str, int]] = {}  # peer id -> events we know that peer holds
        self.interval_s = float(os.getenv("SYNC_INTERVAL_MS", "500")) / 1000
        self._client = httpx.Client(timeout=2.0) if post is None else None
        self._post = post or self._http_post
        self._lock = threading.Lock()
        # Recovery reports: one entry per outage, from the link going down to catching up.
        self._ep_lock = threading.Lock()
        self._track: dict[str, dict] = {}  # peer url -> outage tracking
        self.episodes: list[dict] = []     # finished recovery reports, oldest first
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def _http_post(self, url: str, payload: dict, headers: Optional[dict] = None):
        try:
            r = self._client.post(url, json=payload, headers=headers)
            return r.status_code, r.json()
        except (httpx.HTTPError, ValueError):
            return None, {}

    # ---- serving a peer's pull -------------------------------------------------------------

    def handle_request(self, sender: str, epoch: int, vv: dict) -> tuple[int, dict]:
        node = self.node
        if sender in node.blocked:
            return 403, {"error": "blocked", "message": f"{node.config.node_id} blocks {sender}"}
        if epoch != node.epoch:
            return 409, {"error": "epoch_mismatch",
                         "message": f"sender epoch {epoch}, mine {node.epoch}"}
        self._learn(sender, vv)
        events = node.store.events_missing_from(vv, MAX_EVENTS_PER_SYNC)
        self._sent(sender, len(events))
        return 200, {
            "node_id": node.config.node_id,
            "epoch": node.epoch,
            "events": events,
            "vv": node.store.version_vector(),
        }

    # ---- pulling from a peer ---------------------------------------------------------------

    def sync_peer(self, peer: Peer) -> dict:
        node = self.node
        if node.paused:
            return self._mark(peer, False, "self_paused")
        if peer.id in node.blocked:
            return self._mark(peer, False, "blocked")

        epoch = node.epoch
        token = node.config.admin_token
        status, body = self._post(peer.url + "/sync", {
            "sender": node.config.node_id, "epoch": epoch, "vv": node.store.version_vector()},
            {"X-Admin-Token": token} if token else None)
        if status != 200:
            return self._mark(peer, False, REASON_BY_STATUS.get(status, "unreachable"))

        peer.id = body["node_id"]
        if peer.id in node.blocked or node.paused:
            return self._mark(peer, False, "blocked" if peer.id in node.blocked else "self_paused")

        self._reconnecting(peer)  # snapshot what this region holds before anything is replayed
        applied = node.apply_remote(body["events"], epoch)
        if applied:
            from .merge import NODE_NAMES
            name = NODE_NAMES.get(peer.id, peer.id)
            node.activity.record(
                "sync", f"Received {applied} change{'s' if applied != 1 else ''} from {name}",
                peer=peer.id, applied=applied)
            node.note_conflicts()
        if epoch == node.epoch:
            self._learn(peer.id, body["vv"])
        return self._mark(peer, True, None, applied)

    def sync_all(self) -> list[dict]:
        return [self.sync_peer(peer) for peer in self.peers]

    def _mark(self, peer: Peer, reachable: bool, reason: Optional[str], applied: int = 0) -> dict:
        was_reachable, first_contact = peer.reachable, peer.last_sync is None
        peer.reachable, peer.reason = reachable, reason
        if reachable != was_reachable:
            self._log_link(peer, reachable, reason, first_contact)
        if reachable:
            peer.last_sync = time.monotonic()
            peer.last_sync_wall = time.time()
        self._track_outage(peer, reachable, applied)
        return {"id": peer.id or peer.url, "reachable": reachable, "reason": reason,
                "applied": applied}

    def _log_link(self, peer: Peer, reachable: bool, reason: Optional[str],
                  first_contact: bool) -> None:
        from .merge import NODE_NAMES
        name = NODE_NAMES.get(peer.id, peer.id or peer.url)
        if reachable:
            text = f"Connected to {name}" if first_contact else f"Link to {name} is back"
            self.node.activity.record("sync", text, peer=peer.id, reachable=True)
        else:
            why = (reason or "unreachable").replace("_", " ")
            self.node.activity.record("sync", f"Lost contact with {name} ({why})", "warn",
                                      peer=peer.id, reachable=False, reason=reason)

    # ---- recovery reports ------------------------------------------------------------------
    # An episode starts when a link that was working goes down, snapshots the region ("before"),
    # snapshots it again when the link returns but before anything is replayed ("during", i.e.
    # what the region held while cut off), and finishes once nothing more is being exchanged
    # ("after"). The counts say what the reconnect actually did.

    def _tracker(self, peer: Peer) -> dict:
        return self._track.setdefault(peer.url, {
            "was_up": False, "down_at": None, "before": None, "conflict_ids": set(),
            "episode": None})

    def _track_outage(self, peer: Peer, reachable: bool, applied: int) -> None:
        with self._ep_lock:
            t = self._tracker(peer)
            starts_outage = not reachable and t["was_up"] and t["down_at"] is None
            episode = t["episode"] if reachable else None
        if starts_outage:
            before = self.node.snapshot()
            ids = {c["conflict_id"] for c in self.node.view()[1]}
            with self._ep_lock:
                t["down_at"], t["before"], t["conflict_ids"] = time.time(), before, ids
            return
        if not reachable:
            return
        finish = False
        with self._ep_lock:
            t["was_up"] = True
            if episode is not None:
                episode["received"] += applied
                if applied > 0 or episode.pop("_busy", False):
                    episode["_quiet"] = 0
                else:
                    episode["_quiet"] += 1
                finish = episode["_quiet"] >= 2  # two idle rounds in a row: caught up
        if finish:
            self._finish(peer, t)

    def _reconnecting(self, peer: Peer) -> None:
        with self._ep_lock:
            t = self._tracker(peer)
            if t["down_at"] is None or t["episode"] is not None:
                return
        during = self.node.snapshot()
        with self._ep_lock:
            t["episode"] = {
                "peer": peer.id, "status": "recovering",
                "outage_started_at": t["down_at"], "reconnected_at": time.time(),
                "before": t["before"], "during": during,
                "received": 0, "sent": 0, "_quiet": 0,
                "_violations": self.node.store.violation_count,
            }

    def _sent(self, sender: str, count: int) -> None:
        if not count:
            return
        with self._ep_lock:
            for peer in self.peers:
                episode = self._track.get(peer.url, {}).get("episode")
                if peer.id == sender and episode is not None:
                    episode["sent"] += count
                    episode["_busy"] = True

    def _finish(self, peer: Peer, t: dict) -> None:
        after = self.node.snapshot()
        conflicts = [c for c in self.node.view()[1] if c["conflict_id"] not in t["conflict_ids"]]
        with self._ep_lock:
            ep = t["episode"]
            if ep is None:
                return
            before_by_id = {r["report_id"]: r for r in ep["before"]["reports"]}
            added = sum(1 for r in after["reports"] if r["report_id"] not in before_by_id)
            changed = sum(1 for r in after["reports"]
                          if r["report_id"] in before_by_id and r != before_by_id[r["report_id"]])
            needs = sum(1 for c in conflicts if c["status"] == "needs_operator")
            failed = self.node.store.violation_count - ep.pop("_violations")
            ep.pop("_quiet", None)
            ep.pop("_busy", None)
            ep.update({
                "status": "recovered", "recovered_at": time.time(), "after": after,
                "outage_ms": int((ep["reconnected_at"] - ep["outage_started_at"]) * 1000),
                "conflicts": {"new": len(conflicts), "needs_operator": needs,
                              "auto_resolved": len(conflicts) - needs},
                "failed": failed,
                "changes": {"reports_added": added, "reports_changed": changed},
            })
            ep["summary"] = self._summary(ep)
            summary, tone = ep["summary"], ("warn" if needs or failed else "info")
            self.episodes.append(ep)
            del self.episodes[:-20]
            t["episode"], t["down_at"], t["before"], t["conflict_ids"] = None, None, None, set()
        self.node.activity.record("recovery", summary, tone, peer=ep["peer"],
                                  received=ep["received"], sent=ep["sent"],
                                  conflicts=ep["conflicts"]["new"], failed=ep["failed"])

    @staticmethod
    def _summary(ep: dict) -> str:
        from .merge import NODE_NAMES
        name = NODE_NAMES.get(ep["peer"], ep["peer"])
        seconds = max(1, round(ep["outage_ms"] / 1000))
        n = ep["conflicts"]
        conflict_text = ("no conflicts" if n["new"] == 0 else
                         f"{n['new']} conflict{'s' if n['new'] != 1 else ''} "
                         f"({n['auto_resolved']} auto-resolved, {n['needs_operator']} waiting "
                         "for an operator)")
        def changes(n: int) -> str:
            return f"{n} change{'s' if n != 1 else ''}"
        return (f"Link to {name} restored after {seconds} s. {changes(ep['received'])} received, "
                f"{ep['sent']} sent, {conflict_text}, {ep['failed']} failed.")

    def recovery(self) -> dict:
        """Finished recovery reports plus any in progress, newest last."""
        with self._ep_lock:
            open_ = [{k: v for k, v in t["episode"].items() if not k.startswith("_")}
                     for t in self._track.values() if t["episode"] is not None]
            return {"episodes": [dict(e) for e in self.episodes], "in_progress": open_}

    def _learn(self, peer_id: str, vv: dict) -> None:
        with self._lock:
            known = self.known.setdefault(peer_id, {})
            for origin, seq in vv.items():
                known[origin] = max(known.get(origin, 0), int(seq))

    def forget(self) -> None:
        """Drop everything learned about peers (used when this node is reset)."""
        with self._lock:
            self.known.clear()
        with self._ep_lock:
            self._track.clear()
            self.episodes.clear()
        for peer in self.peers:
            peer.reachable, peer.reason, peer.last_sync = False, "never_contacted", None
            peer.last_sync_wall = None

    # ---- what we know about peers ----------------------------------------------------------

    def copies(self, needs: dict[str, int]) -> int:
        """How many peers are known to hold everything in `needs` ({origin: highest seq})."""
        with self._lock:
            return sum(
                1 for peer in self.peers
                if peer.id and all(self.known.get(peer.id, {}).get(origin, 0) >= seq
                                   for origin, seq in needs.items())
            )

    def peer_status(self) -> list[dict]:
        node = self.node
        mine = node.store.version_vector()
        by_id = {p.id: p for p in self.peers if p.id}
        now = time.monotonic()
        rows = []
        with self._lock:
            for node_id in VALID_NODES:
                if node_id == node.config.node_id:
                    continue
                peer = by_id.get(node_id)
                known = self.known.get(node_id, {})
                blocked = node_id in node.blocked
                rows.append({
                    "id": node_id,
                    "reachable": bool(peer and peer.reachable and not blocked
                                      and not node.paused),
                    "reason": ("blocked" if blocked
                               else peer.reason if peer else "not_configured"),
                    "last_sync_ms_ago": (int((now - peer.last_sync) * 1000)
                                         if peer and peer.last_sync is not None else None),
                    "last_sync_at": peer.last_sync_wall if peer else None,
                    "pending_out": sum(max(0, seq - known.get(o, 0)) for o, seq in mine.items()),
                    "pending_in": sum(max(0, seq - mine.get(o, 0)) for o, seq in known.items()),
                    "blocked": blocked,
                })
        return rows

    # ---- background loop: one thread per peer, so a dead peer never delays the others ------

    def start(self) -> None:
        self._stop.clear()
        for peer in self.peers:
            thread = threading.Thread(target=self._loop, args=(peer,), daemon=True,
                                      name=f"sync-{peer.id or peer.url}")
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=3)
        self._threads.clear()

    def _loop(self, peer: Peer) -> None:
        while not self._stop.wait(self.interval_s):
            try:
                self.sync_peer(peer)
            except Exception:  # a bad reply from one peer must not kill the loop
                self._mark(peer, False, "unreachable")
