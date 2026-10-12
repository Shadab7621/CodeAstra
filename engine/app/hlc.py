"""Hybrid logical clock (HLC).

Order events by (wall, counter, node). The wall part follows the machine clock (plus a test
offset) but never goes backwards, so a node with a wrong clock cannot corrupt ordering.
"""
import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True, order=True)
class HLC:
    wall: int
    counter: int
    node: str

    def to_dict(self) -> dict:
        return {"wall": self.wall, "counter": self.counter, "node": self.node}

    @classmethod
    def from_dict(cls, d: dict) -> "HLC":
        return cls(int(d["wall"]), int(d["counter"]), str(d["node"]))


class HybridClock:
    def __init__(self, node_id: str, time_fn=None):
        self.node_id = node_id
        self.offset_ms = 0  # set via /admin/clock to simulate a wrong clock
        self._time_fn = time_fn or (lambda: int(time.time() * 1000))
        self._wall = 0
        self._counter = 0
        self._lock = threading.Lock()

    def _physical(self) -> int:
        return self._time_fn() + self.offset_ms

    def now(self) -> HLC:
        """Timestamp for a local event."""
        with self._lock:
            phys = self._physical()
            if phys > self._wall:
                self._wall, self._counter = phys, 0
            else:
                self._counter += 1
            return HLC(self._wall, self._counter, self.node_id)

    def observe(self, remote: HLC) -> None:
        """Merge a timestamp seen on a remote event, so later local events sort after it."""
        with self._lock:
            phys = self._physical()
            new_wall = max(self._wall, remote.wall, phys)
            if new_wall == self._wall == remote.wall:
                self._counter = max(self._counter, remote.counter) + 1
            elif new_wall == self._wall:
                self._counter += 1
            elif new_wall == remote.wall:
                self._counter = remote.counter + 1
            else:
                self._counter = 0
            self._wall = new_wall
