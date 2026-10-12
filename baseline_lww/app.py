"""Last-writer-wins replicated store: the comparison baseline.

It models how DynamoDB Global Tables (eventual mode) and Cosmos DB (default policy) settle
concurrent writes: each ITEM carries a wall-clock timestamp, replicas always keep the item
with the newest timestamp, and the other write is discarded without a trace.

It speaks the same HTTP API as the real engine, so the same tester and dashboard drive both.
Request validation is shared with the engine, so the two systems accept identical input.
Deliberately NOT a strawman: replication works, nodes converge, nothing crashes.
"""
import hashlib
import json
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Callable, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from engine.app.models import ClockBody, PeerBody, ReportCreate, ReportPatch

VALID_NODES = ("mum", "hyd", "sin")


class Baseline:
    def __init__(self, node_id: str, peers: dict, fetch: Optional[Callable] = None,
                 interval_s: float = 0.5):
        self.node_id = node_id
        self.peers = peers                    # node id -> base url
        self.interval_s = interval_s
        self.items: dict[str, dict] = {}      # report_id -> {data, ts, node, lineage}
        self.lock = threading.RLock()
        self.offset_ms = 0
        self.paused = False
        self.blocked: set[str] = set()
        self.epoch = 0
        self.reachable: dict[str, bool] = {}
        self._client = httpx.Client(timeout=2.0) if fetch is None else None
        self._fetch = fetch or self._http_fetch
        self._stop = threading.Event()

    def _http_fetch(self, url: str):
        try:
            r = self._client.get(url)
            return r.status_code, r.json()
        except (httpx.HTTPError, ValueError):
            return None, {}

    def now(self) -> int:
        return int(time.time() * 1000) + self.offset_ms

    # ---- replication: pull every peer's items, keep the newest timestamp per item ------

    def serve_state(self, sender: str, epoch: int):
        if sender in self.blocked:
            return 403, {"error": "blocked"}
        if epoch != self.epoch:
            return 409, {"error": "epoch_mismatch"}
        with self.lock:
            return 200, {"node_id": self.node_id, "items": self.items}

    def sync_peer(self, peer_id: str, url: str) -> None:
        if self.paused or peer_id in self.blocked:
            self.reachable[peer_id] = False
            return
        epoch = self.epoch
        status, body = self._fetch(f"{url}/baseline/state?sender={self.node_id}&epoch={epoch}")
        self.reachable[peer_id] = status == 200
        if status != 200 or self.paused or peer_id in self.blocked:
            return
        with self.lock:
            if epoch != self.epoch:
                return
            for report_id, theirs in body["items"].items():
                mine = self.items.get(report_id)
                if mine is None or (theirs["ts"], theirs["node"]) > (mine["ts"], mine["node"]):
                    self.items[report_id] = json.loads(json.dumps(theirs))  # last writer wins

    def sync_all(self):
        for peer_id, url in self.peers.items():
            self.sync_peer(peer_id, url)

    def start(self):
        for peer_id, url in self.peers.items():
            threading.Thread(target=self._loop, args=(peer_id, url), daemon=True).start()

    def _loop(self, peer_id, url):
        while not self._stop.wait(self.interval_s):
            try:
                self.sync_peer(peer_id, url)
            except Exception:
                self.reachable[peer_id] = False

    def stop(self):
        self._stop.set()

    # ---- views -----------------------------------------------------------------------------

    def state_hash(self) -> str:
        with self.lock:
            return hashlib.sha256(
                json.dumps(self.items, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()

    def survivors(self) -> list[str]:
        """Ids of writes still reflected somewhere in the current state."""
        with self.lock:
            return sorted({e for item in self.items.values() for e in item["lineage"]})

    def view(self, report_id: str, item: dict) -> dict:
        return {"report_id": report_id, **item["data"], "durability": "n/a", "conflicts": [],
                "possible_duplicates": [],
                "last_updated": {"wall": item["ts"], "counter": 0, "node": item["node"]}}


def create_app(node_id: Optional[str] = None, peers: Optional[dict] = None,
               fetch: Optional[Callable] = None, start_sync: bool = True,
               interval_s: Optional[float] = None) -> FastAPI:
    node_id = node_id or os.getenv("NODE_ID", "mum")
    if peers is None:
        peers = dict(p.split("=", 1) for p in os.getenv("PEERS", "").split(",") if "=" in p)
    if interval_s is None:
        interval_s = float(os.getenv("SYNC_INTERVAL_MS", "500")) / 1000
    node = Baseline(node_id, peers, fetch, interval_s)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if start_sync:
            node.start()
        yield
        node.stop()

    app = FastAPI(title=f"Baseline (last-writer-wins) node {node_id}", lifespan=lifespan)
    app.state.node = node
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])

    @app.middleware("http")
    async def pause_gate(request: Request, call_next):
        if node.paused and request.url.path not in ("/healthz", "/admin/resume"):
            return JSONResponse(status_code=503, content={"error": "paused"})
        return await call_next(request)

    def error(status, code, message):
        raise HTTPException(status_code=status, detail={"error": code, "message": message})

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"error": "http_error",
                                                                   "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content=detail)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/status")
    def status():
        return {
            "node_id": node.node_id, "mode": "lww", "epoch": node.epoch,
            "clock_offset_ms": node.offset_ms, "paused": node.paused,
            "event_count": len(node.survivors()), "state_hash": node.state_hash(),
            "peers": [{"id": p, "reachable": node.reachable.get(p, False),
                       "blocked": p in node.blocked} for p in node.peers],
        }

    @app.get("/state-hash")
    def state_hash():
        return {"node_id": node.node_id, "hash": node.state_hash(),
                "event_count": len(node.survivors())}

    @app.get("/events")
    def events(ids_only: bool = False):
        return {"node_id": node.node_id, "event_ids": node.survivors()}

    @app.get("/baseline/state")
    def baseline_state(sender: str = "", epoch: int = 0):
        code, payload = node.serve_state(sender, epoch)
        return JSONResponse(status_code=code, content=payload)

    @app.get("/reports")
    def list_reports():
        with node.lock:
            return {"reports": [node.view(r, i) for r, i in sorted(node.items.items())]}

    @app.get("/reports/{report_id}")
    def get_report(report_id: str):
        with node.lock:
            item = node.items.get(report_id)
        if item is None:
            error(404, "not_found", f"report {report_id} not found")
        return node.view(report_id, item)

    @app.post("/reports", status_code=201)
    def create_report(body: ReportCreate):
        report_id, event_id = str(uuid.uuid4()), str(uuid.uuid4())
        data = {"incident_type": body.incident_type.value, "severity": body.severity,
                "status": body.status.value, "location": body.location.model_dump(),
                "description": body.description, "reporter": body.reporter}
        with node.lock:
            node.items[report_id] = {"data": data, "ts": node.now(), "node": node.node_id,
                                     "lineage": [event_id]}
        return {"report_id": report_id, "event_id": event_id, "durability": "local"}

    @app.patch("/reports/{report_id}")
    def patch_report(report_id: str, body: ReportPatch):
        changes = body.model_dump(exclude_none=True, mode="json")
        if not changes:
            error(400, "bad_request", "no fields to update")
        event_id = str(uuid.uuid4())
        with node.lock:
            item = node.items.get(report_id)
            if item is None:
                error(404, "not_found", f"report {report_id} not found")
            node.items[report_id] = {   # the whole item is rewritten, as in a key-value store
                "data": {**item["data"], **changes}, "ts": node.now(), "node": node.node_id,
                "lineage": item["lineage"] + [event_id]}
        return {"event_id": event_id, "durability": "local", "warnings": []}

    @app.get("/conflicts")
    def conflicts():
        return {"conflicts": []}   # last-writer-wins keeps no record of what it discarded

    @app.get("/reports/{report_id}/history")
    def history(report_id: str):
        error(404, "not_found", "the baseline keeps no history")

    # ---- admin / fault injection: same shape as the engine ----------------------------------

    @app.post("/admin/block")
    def block(body: PeerBody):
        node.blocked.add(body.peer)
        return {"ok": True, "blocked": sorted(node.blocked)}

    @app.post("/admin/unblock")
    def unblock(body: PeerBody):
        node.blocked.discard(body.peer)
        return {"ok": True, "blocked": sorted(node.blocked)}

    @app.post("/admin/clock")
    def set_clock(body: ClockBody):
        node.offset_ms = body.offset_ms
        return {"ok": True, "clock_offset_ms": node.offset_ms}

    @app.post("/admin/pause")
    def pause():
        node.paused = True
        return {"ok": True, "paused": True}

    @app.post("/admin/resume")
    def resume():
        node.paused = False
        return {"ok": True, "paused": False}

    @app.post("/admin/reset")
    def reset():
        with node.lock:
            node.items.clear()
            node.epoch += 1
            node.blocked.clear()
            node.offset_ms = 0
        return {"ok": True, "epoch": node.epoch}

    @app.post("/admin/sync-now")
    def sync_now():
        node.sync_all()
        return {"ok": True}

    return app
