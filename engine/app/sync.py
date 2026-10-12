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
REASON_BY_STATUS = {403: "blocked", 409: "epoch_mismatch", 503: "paused"}


@dataclass
class Peer:
    url: str
    id: Optional[str] = None  # learned from the first reply if not given in PEERS
    reachable: bool = False
    reason: Optional[str] = "never_contacted"
    last_sync: Optional[float] = None


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
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def _http_post(self, url: str, payload: dict):
        try:
            r = self._client.post(url, json=payload)
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
        return 200, {
            "node_id": node.config.node_id,
            "epoch": node.epoch,
            "events": node.store.events_missing_from(vv, MAX_EVENTS_PER_SYNC),
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
        status, body = self._post(peer.url + "/sync", {
            "sender": node.config.node_id, "epoch": epoch, "vv": node.store.version_vector()})
        if status != 200:
            return self._mark(peer, False, REASON_BY_STATUS.get(status, "unreachable"))

        peer.id = body["node_id"]
        if peer.id in node.blocked or node.paused:
            return self._mark(peer, False, "blocked" if peer.id in node.blocked else "self_paused")

        applied = node.apply_remote(body["events"], epoch)
        if epoch == node.epoch:
            self._learn(peer.id, body["vv"])
        return self._mark(peer, True, None, applied)

    def sync_all(self) -> list[dict]:
        return [self.sync_peer(peer) for peer in self.peers]

    def _mark(self, peer: Peer, reachable: bool, reason: Optional[str], applied: int = 0) -> dict:
        peer.reachable, peer.reason = reachable, reason
        if reachable:
            peer.last_sync = time.monotonic()
        return {"id": peer.id or peer.url, "reachable": reachable, "reason": reason,
                "applied": applied}

    def _learn(self, peer_id: str, vv: dict) -> None:
        with self._lock:
            known = self.known.setdefault(peer_id, {})
            for origin, seq in vv.items():
                known[origin] = max(known.get(origin, 0), int(seq))

    def forget(self) -> None:
        """Drop everything learned about peers (used when this node is reset)."""
        with self._lock:
            self.known.clear()
        for peer in self.peers:
            peer.reachable, peer.reason, peer.last_sync = False, "never_contacted", None

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
