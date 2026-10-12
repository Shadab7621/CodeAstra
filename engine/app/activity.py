"""Activity log: a readable record of what each region did, kept in MongoDB Atlas.

This is observability, not replication. The SQLite event log stays the source of truth and the
node never waits for Atlas: entries go into a short in-memory buffer first and a background
thread ships them to Atlas in batches. If Atlas is unreachable (or no URI is configured) the
node keeps working and `/logs` serves the buffer instead.
"""
import queue
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Optional

BUFFER_SIZE = 500          # entries kept in memory per node
QUEUE_LIMIT = 5000         # entries waiting for Atlas; the oldest are dropped beyond this
BATCH_SIZE = 100
RETENTION_DAYS = 14        # Atlas deletes older entries by itself (TTL index)
COLLECTION = "activity_logs"

LEVELS = ("info", "warn", "bad")


class ActivityLog:
    def __init__(self, node_id: str, uri: str = "", collection=None):
        """`collection` lets tests supply a stand-in for the Atlas collection."""
        self.node_id = node_id
        self._buffer: deque = deque(maxlen=BUFFER_SIZE)
        self._queue: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._seq = 0
        self._collection = collection
        self._client = None
        self._connected = False
        self._error: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        if self._collection is None and uri:
            try:
                import pymongo
                self._client = pymongo.MongoClient(
                    uri, serverSelectionTimeoutMS=4000, connectTimeoutMS=4000,
                    socketTimeoutMS=8000)
                self._collection = self._client.get_default_database(
                    default="DisasterSync")[COLLECTION]
            except Exception as exc:  # bad URI or driver missing: fall back to memory only
                self._error = type(exc).__name__
        if self._collection is not None:
            self._thread = threading.Thread(target=self._ship, daemon=True,
                                            name=f"activity-{node_id}")
            self._thread.start()

    # ---- writing ---------------------------------------------------------------------------

    def record(self, kind: str, message: str, level: str = "info", **detail) -> dict:
        """Never raises and never blocks: logging must not be able to break a request."""
        now = time.time()
        with self._lock:
            self._seq += 1
            entry = {
                "id": uuid.uuid4().hex,
                "region": self.node_id,
                "seq": self._seq,
                "t": now,
                "ts": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="milliseconds"),
                "kind": kind,
                "level": level if level in LEVELS else "info",
                "message": message,
                "detail": detail,
            }
            self._buffer.append(entry)
        if self._collection is not None:
            if self._queue.qsize() >= QUEUE_LIMIT:
                try:
                    self._queue.get_nowait()
                    self._queue.task_done()
                except queue.Empty:
                    pass
            self._queue.put(entry)
        return entry

    def _ship(self) -> None:
        try:
            self._collection.create_index([("region", 1), ("t", -1)])
            self._collection.create_index("at", expireAfterSeconds=RETENTION_DAYS * 86400)
        except Exception as exc:
            self._error = type(exc).__name__
        while not self._stop.is_set():
            try:
                first = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            batch = [first]
            while len(batch) < BATCH_SIZE:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            docs = [{"_id": e["id"], **{k: v for k, v in e.items() if k != "id"},
                     "at": datetime.fromtimestamp(e["t"], timezone.utc)} for e in batch]
            delay = 1.0
            while not self._stop.is_set():
                try:
                    self._collection.insert_many(docs, ordered=False)
                    self._connected, self._error = True, None
                    break
                except Exception as exc:
                    if type(exc).__name__ == "BulkWriteError":  # duplicates from a retry
                        self._connected, self._error = True, None
                        break
                    self._connected, self._error = False, type(exc).__name__
                    self._stop.wait(delay)
                    delay = min(delay * 2, 10.0)
            for _ in batch:
                self._queue.task_done()

    def flush(self, timeout: float = 3.0) -> bool:
        """Wait until everything queued has been handed to Atlas. For tests and shutdown."""
        end = time.time() + timeout
        while self._queue.unfinished_tasks and time.time() < end:
            time.sleep(0.02)
        return self._queue.unfinished_tasks == 0

    def close(self) -> None:
        self.flush(2.0)
        self._stop.set()
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass

    # ---- reading ---------------------------------------------------------------------------

    def storage(self) -> dict:
        return {
            "backend": "atlas" if self._collection is not None else "memory",
            "connected": self._connected,
            "queued": self._queue.unfinished_tasks,
            "error": self._error,
        }

    def entries(self, region: Optional[str] = None, limit: int = 100,
                kind: Optional[str] = None) -> tuple[list[dict], str]:
        """(newest-first entries, where they came from: 'atlas' or 'memory')."""
        region = region or self.node_id
        limit = max(1, min(limit, 500))
        if self._collection is not None:
            try:
                query = {"region": region}
                if kind:
                    query["kind"] = kind
                rows = self._collection.find(query, {"at": 0}).sort("t", -1).limit(limit)
                out = []
                for row in rows:
                    row["id"] = row.pop("_id")
                    out.append(row)
                self._connected, self._error = True, None
                return out, "atlas"
            except Exception as exc:
                self._connected, self._error = False, type(exc).__name__
        if region != self.node_id:
            return [], "memory"
        with self._lock:
            rows = [e for e in self._buffer if not kind or e["kind"] == kind]
        return list(reversed(rows))[:limit], "memory"
