"""Append-only, hash-chained event log on SQLite.

Events are never updated or deleted (except a test reset). Each event carries the hash of the
previous event from the same origin (`prev_hash`) and its own hash (`event_hash`), forming a
chain per origin. Anyone holding the log can recompute the chain, so editing, inserting or
removing a stored event is detectable, and a peer that sends a forged event is rejected.
"""
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

from .hlc import HLC

GENESIS = "0" * 64  # prev_hash of the first event from an origin

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id   TEXT PRIMARY KEY,
    report_id  TEXT NOT NULL,
    origin     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    hlc_wall   INTEGER NOT NULL,
    hlc_counter INTEGER NOT NULL,
    hlc_node   TEXT NOT NULL,
    op         TEXT NOT NULL,
    fields     TEXT NOT NULL,
    client_ts  TEXT NOT NULL,
    vv         TEXT NOT NULL,
    prev_hash  TEXT NOT NULL DEFAULT '',
    event_hash TEXT NOT NULL DEFAULT '',
    UNIQUE (origin, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_report ON events (report_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

_HASHED_KEYS = ("event_id", "report_id", "origin", "seq", "hlc", "op", "fields",
                "client_ts", "vv", "prev_hash")


def compute_event_hash(event: dict) -> str:
    """SHA-256 over the canonical form of everything that defines the event."""
    payload = {k: event[k] for k in _HASHED_KEYS}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def seal_event(event: dict, prev_hash: str = GENESIS) -> dict:
    """Returns a copy of `event` with prev_hash and event_hash filled in."""
    sealed = dict(event)
    sealed["prev_hash"] = prev_hash
    sealed["event_hash"] = compute_event_hash(sealed)
    return sealed


def _row_to_event(row: sqlite3.Row) -> dict:
    return {
        "event_id": row["event_id"],
        "report_id": row["report_id"],
        "origin": row["origin"],
        "seq": row["seq"],
        "hlc": {"wall": row["hlc_wall"], "counter": row["hlc_counter"], "node": row["hlc_node"]},
        "op": row["op"],
        "fields": json.loads(row["fields"]),
        "client_ts": row["client_ts"],
        "vv": json.loads(row["vv"]),
        "prev_hash": row["prev_hash"],
        "event_hash": row["event_hash"],
    }


class EventStore:
    def __init__(self, node_id: str, db_path: str):
        self.node_id = node_id
        self._lock = threading.RLock()
        self._db_path = db_path
        self._conn = self._connect()
        self.version = 0  # bumped on every change; lets callers cache the merged view
        row = self._conn.execute("SELECT value FROM meta WHERE key = 'epoch'").fetchone()
        self.epoch = int(row["value"]) if row else 0  # counts resets; survives restarts
        self.violations: list[dict] = []  # events rejected for failing the integrity check
        self.violation_count = 0

    def _connect(self) -> sqlite3.Connection:
        if self._db_path != ":memory:":
            os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        # Databases created before hash chaining get the new columns; their old events are
        # reported as "legacy" (unverifiable) instead of being rejected.
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(events)")}
        for column in ("prev_hash", "event_hash"):
            if column not in existing:
                conn.execute(f"ALTER TABLE events ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        conn.commit()
        return conn

    # ---- reads ---------------------------------------------------------------------------

    def version_vector(self) -> dict[str, int]:
        """Highest seq seen per origin. Describes everything this node has."""
        with self._lock:
            rows = self._conn.execute("SELECT origin, MAX(seq) AS m FROM events GROUP BY origin")
            return {r["origin"]: r["m"] for r in rows}

    def event_count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    def event_ids(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute("SELECT event_id FROM events ORDER BY event_id")
            return [r["event_id"] for r in rows]

    def events_for_report(self, report_id: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE report_id = ? "
                "ORDER BY hlc_wall, hlc_counter, hlc_node",
                (report_id,),
            )
            return [_row_to_event(r) for r in rows]

    def all_events(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events ORDER BY hlc_wall, hlc_counter, hlc_node"
            )
            return [_row_to_event(r) for r in rows]

    def has_report(self, report_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM events WHERE report_id = ? LIMIT 1", (report_id,)
            ).fetchone()
            return row is not None

    def events_missing_from(self, vv: dict, limit: int) -> list[dict]:
        """Events a peer with version vector `vv` does not have yet, oldest first per origin.

        Capped at `limit`; because each origin is sent in seq order, a capped reply is still a
        gap-free prefix and the peer simply asks again."""
        with self._lock:
            out: list[dict] = []
            for origin, top in sorted(self.version_vector().items()):
                have = int(vv.get(origin, 0))
                if top <= have or len(out) >= limit:
                    continue
                rows = self._conn.execute(
                    "SELECT * FROM events WHERE origin = ? AND seq > ? ORDER BY seq LIMIT ?",
                    (origin, have, limit - len(out)),
                )
                out.extend(_row_to_event(r) for r in rows)
            return out

    def events_by_report(self) -> dict[str, list[dict]]:
        grouped: dict[str, list[dict]] = {}
        for event in self.all_events():
            grouped.setdefault(event["report_id"], []).append(event)
        return grouped

    def max_hlc(self) -> Optional[HLC]:
        """Newest timestamp in the log, so a restarted node never stamps events in the past."""
        with self._lock:
            row = self._conn.execute(
                "SELECT hlc_wall, hlc_counter, hlc_node FROM events "
                "ORDER BY hlc_wall DESC, hlc_counter DESC, hlc_node DESC LIMIT 1"
            ).fetchone()
            return HLC(row["hlc_wall"], row["hlc_counter"], row["hlc_node"]) if row else None

    # ---- integrity -----------------------------------------------------------------------

    def _stored_hash(self, origin: str, seq: int) -> Optional[str]:
        """event_hash of (origin, seq), or None if that event is not stored."""
        row = self._conn.execute(
            "SELECT event_hash FROM events WHERE origin = ? AND seq = ?", (origin, seq)
        ).fetchone()
        return None if row is None else row["event_hash"]

    def heads(self) -> dict[str, dict]:
        """Newest (seq, hash) per origin. Two nodes with the same seq must show the same hash."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT e.origin, e.seq, e.event_hash FROM events e JOIN "
                "(SELECT origin, MAX(seq) AS m FROM events GROUP BY origin) t "
                "ON e.origin = t.origin AND e.seq = t.m ORDER BY e.origin"
            )
            return {r["origin"]: {"seq": r["seq"], "hash": r["event_hash"]} for r in rows}

    def verify_chain(self) -> dict:
        """Recompute every hash and every link from stored data."""
        with self._lock:
            rows = self._conn.execute("SELECT * FROM events ORDER BY origin, seq").fetchall()
        origins: dict[str, dict] = {}
        expected_prev: dict[str, str] = {}
        last_seq: dict[str, int] = {}
        for row in rows:
            e = _row_to_event(row)
            o = e["origin"]
            info = origins.setdefault(o, {"events": 0, "ok": True, "first_bad_seq": None,
                                          "legacy_events": 0, "head_seq": 0, "head_hash": ""})
            info["events"] += 1
            info["head_seq"], info["head_hash"] = e["seq"], e["event_hash"]
            problem = None
            if e["seq"] != last_seq.get(o, 0) + 1:
                problem = "missing event before this one"
            if e["event_hash"] == "":
                info["legacy_events"] += 1       # written before hash chaining existed
                expected_prev[o] = GENESIS
            else:
                if compute_event_hash(e) != e["event_hash"]:
                    problem = problem or "content does not match its hash"
                elif e["prev_hash"] != expected_prev.get(o, GENESIS):
                    problem = problem or "broken link to the previous event"
                expected_prev[o] = e["event_hash"]
            last_seq[o] = e["seq"]
            if problem and info["ok"]:
                info["ok"], info["first_bad_seq"], info["problem"] = False, e["seq"], problem
        return {
            "ok": all(i["ok"] for i in origins.values()),
            "events_checked": len(rows),
            "legacy_events": sum(i["legacy_events"] for i in origins.values()),
            "origins": origins,
            "rejected_events": self.violation_count,
        }

    def _check_remote(self, event: dict) -> Optional[str]:
        """Why a received event must not be stored, or None if it is sound."""
        if not event.get("event_hash") or "prev_hash" not in event:
            return "event has no hash chain fields"
        if compute_event_hash(event) != event["event_hash"]:
            return "content does not match its hash"
        if event["seq"] == 1:
            expected = GENESIS
        else:
            previous = self._stored_hash(event["origin"], event["seq"] - 1)
            if previous is None:
                return "previous event from this origin is missing"
            expected = previous or GENESIS        # '' = a legacy event, chain restarts after it
        if event["prev_hash"] != expected:
            return "broken link to the previous event"
        return None

    def _reject(self, event: dict, reason: str) -> None:
        self.violation_count += 1
        self.violations.append({
            "origin": event.get("origin"), "seq": event.get("seq"),
            "event_id": event.get("event_id"), "reason": reason,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        del self.violations[:-50]  # keep the most recent 50

    # ---- writes --------------------------------------------------------------------------

    def append_local(self, report_id: str, op: str, fields: dict, hlc: HLC) -> dict:
        """Create an event authored by this node. Assigns seq, version vector and hash chain."""
        with self._lock:
            vv = self.version_vector()
            seq = vv.get(self.node_id, 0) + 1
            vv[self.node_id] = seq  # vv describes everything this node had seen, itself included
            previous = self._stored_hash(self.node_id, seq - 1) if seq > 1 else None
            event = seal_event({
                "event_id": str(uuid.uuid4()),
                "report_id": report_id,
                "origin": self.node_id,
                "seq": seq,
                "hlc": hlc.to_dict(),
                "op": op,
                "fields": fields,
                "client_ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "vv": vv,
            }, prev_hash=previous or GENESIS)
            self._insert(event)
            return event

    def insert_remote(self, event: dict) -> bool:
        """Store an event received from a peer. Returns False if it is already present or if
        it fails the integrity check (forged, altered or unlinked); rejections are recorded."""
        with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM events WHERE event_id = ?", (event["event_id"],)
            ).fetchone()
            if exists:
                return False
            problem = self._check_remote(event)
            if problem:
                self._reject(event, problem)
                return False
            self._insert(event)
            return True

    def _insert(self, e: dict) -> None:
        self._conn.execute(
            "INSERT INTO events (event_id, report_id, origin, seq, hlc_wall, hlc_counter, "
            "hlc_node, op, fields, client_ts, vv, prev_hash, event_hash) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                e["event_id"], e["report_id"], e["origin"], e["seq"],
                e["hlc"]["wall"], e["hlc"]["counter"], e["hlc"]["node"],
                e["op"], json.dumps(e["fields"], sort_keys=True), e["client_ts"],
                json.dumps(e["vv"], sort_keys=True), e["prev_hash"], e["event_hash"],
            ),
        )
        self._conn.commit()
        self.version += 1

    def reset(self) -> None:
        """Wipe everything. Tests only (POST /admin/reset)."""
        with self._lock:
            self._conn.execute("DELETE FROM events")
            self._conn.execute(
                "INSERT INTO meta (key, value) VALUES ('epoch', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(self.epoch + 1),),
            )
            self._conn.commit()
            self.epoch += 1
            self.version += 1
            self.violations.clear()
            self.violation_count = 0
