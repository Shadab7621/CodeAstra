"""Append-only event log on SQLite. Events are never updated or deleted (except a test reset)."""
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

from .hlc import HLC

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
    UNIQUE (origin, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_report ON events (report_id);
"""


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
    }


class EventStore:
    def __init__(self, node_id: str, db_path: str):
        self.node_id = node_id
        self._lock = threading.RLock()
        self._db_path = db_path
        self._conn = self._connect()
        self.version = 0  # bumped on every change; lets callers cache the merged view

    def _connect(self) -> sqlite3.Connection:
        if self._db_path != ":memory:":
            import os
            os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
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

    def events_after(self, origin: str, after_seq: int) -> list[dict]:
        """Events from one origin newer than after_seq. Used by the sync protocol."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE origin = ? AND seq > ? ORDER BY seq",
                (origin, after_seq),
            )
            return [_row_to_event(r) for r in rows]

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

    # ---- writes --------------------------------------------------------------------------

    def append_local(self, report_id: str, op: str, fields: dict, hlc: HLC) -> dict:
        """Create an event authored by this node. Assigns seq and the version vector."""
        with self._lock:
            vv = self.version_vector()
            seq = vv.get(self.node_id, 0) + 1
            vv[self.node_id] = seq  # vv describes everything this node had seen, itself included
            event = {
                "event_id": str(uuid.uuid4()),
                "report_id": report_id,
                "origin": self.node_id,
                "seq": seq,
                "hlc": hlc.to_dict(),
                "op": op,
                "fields": fields,
                "client_ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "vv": vv,
            }
            self._insert(event)
            return event

    def insert_remote(self, event: dict) -> bool:
        """Store an event received from a peer. Idempotent: returns False if already present."""
        with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM events WHERE event_id = ?", (event["event_id"],)
            ).fetchone()
            if exists:
                return False
            self._insert(event)
            return True

    def _insert(self, e: dict) -> None:
        self._conn.execute(
            "INSERT INTO events (event_id, report_id, origin, seq, hlc_wall, hlc_counter, "
            "hlc_node, op, fields, client_ts, vv) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                e["event_id"], e["report_id"], e["origin"], e["seq"],
                e["hlc"]["wall"], e["hlc"]["counter"], e["hlc"]["node"],
                e["op"], json.dumps(e["fields"], sort_keys=True), e["client_ts"],
                json.dumps(e["vv"], sort_keys=True),
            ),
        )
        self._conn.commit()
        self.version += 1

    def reset(self) -> None:
        """Wipe everything. Tests only (POST /admin/reset)."""
        with self._lock:
            self._conn.execute("DELETE FROM events")
            self._conn.commit()
            self.version += 1
