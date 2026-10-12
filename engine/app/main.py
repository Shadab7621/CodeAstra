"""Engine node: FastAPI app implementing docs/00_CONTRACT.md section 5.

Run a node with:  uvicorn engine.app.main:create_app --factory --port 8001
"""
import hmac
import os
import threading
import uuid
from contextlib import asynccontextmanager
from typing import Callable, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import VALID_NODES, Config
from .hlc import HLC, HybridClock
from .merge import STATUS_ORDER, merge_all, state_hash
from .models import ClockBody, PeerBody, ReportCreate, ReportPatch, ResolveBody, SyncBody
from .store import EventStore
from .sync import SyncManager


class NodeState:
    """Everything one running node holds in memory."""

    def __init__(self, config: Config, post: Optional[Callable] = None):
        self.config = config
        self.store = EventStore(config.node_id, config.db_path)
        self.clock = HybridClock(config.node_id)
        newest = self.store.max_hlc()
        if newest:
            self.clock.observe(newest)  # after a restart, keep stamping forwards
        self.paused = False
        self.blocked: set[str] = set()  # peer node ids we refuse to talk to
        self.lock = threading.RLock()   # guards reset against incoming events
        self._view = None
        self.sync = SyncManager(self, post)

    @property
    def epoch(self) -> int:
        """Number of resets. Nodes only sync with peers on the same epoch, so resetting the
        cluster one node at a time cannot copy old data back into a node already wiped."""
        return self.store.epoch

    def view(self) -> tuple[list[dict], list[dict], str, dict]:
        """(reports, conflicts, state hash, needs), recomputed only when the event log changed.

        needs maps report_id -> {origin: highest seq}: what a peer must hold to have the
        whole report."""
        version = self.store.version
        if self._view is None or self._view[0] != version:
            by_report = self.store.events_by_report()
            reports, conflicts = merge_all(by_report)
            digest = state_hash(reports, self.store.event_ids())
            needs = {}
            for report_id, events in by_report.items():
                top = needs[report_id] = {}
                for e in events:
                    top[e["origin"]] = max(top.get(e["origin"], 0), e["seq"])
            self._view = (version, reports, conflicts, digest, needs)
        return self._view[1], self._view[2], self._view[3], self._view[4]

    def report(self, report_id: str) -> Optional[dict]:
        return next((r for r in self.view()[0] if r["report_id"] == report_id), None)

    def conflict(self, conflict_id: str) -> Optional[dict]:
        return next((c for c in self.view()[1] if c["conflict_id"] == conflict_id), None)

    def durability(self, report_id: str) -> str:
        """local / replicated / confirmed, from what peers have told us they hold."""
        copies = self.sync.copies(self.view()[3].get(report_id, {}))
        if copies and copies >= len(self.sync.peers):
            return "confirmed"
        return "replicated" if copies else "local"

    def apply_remote(self, events: list[dict], epoch: int) -> int:
        """Store events received from a peer. Per origin they must arrive in order with no
        gaps; anything else is skipped and fetched again on the next round."""
        with self.lock:
            if epoch != self.epoch:
                return 0  # we were reset while the request was in flight
            have = self.store.version_vector()
            applied = 0
            for e in sorted(events, key=lambda e: (e["origin"], e["seq"])):
                if e["seq"] != have.get(e["origin"], 0) + 1:
                    continue
                if self.store.insert_remote(e):
                    self.clock.observe(HLC.from_dict(e["hlc"]))
                    have[e["origin"]] = e["seq"]
                    applied += 1
            return applied

    def reset(self) -> None:
        with self.lock:
            self.store.reset()
            self.blocked.clear()
            self.clock.offset_ms = 0
            self.sync.forget()


def create_app(config: Optional[Config] = None, post: Optional[Callable] = None,
               start_sync: bool = True) -> FastAPI:
    """post and start_sync let tests wire nodes together without real sockets or timers."""
    config = config or Config.from_env()
    state = NodeState(config, post)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if start_sync:
            state.sync.start()
        yield
        state.sync.stop()

    app = FastAPI(title=f"DisasterSync node {config.node_id}", lifespan=lifespan)
    app.state.node = state

    def needs_token(path: str) -> bool:
        """Sensitive endpoints: fault injection, node-to-node sync and operator decisions.
        Creating and reading reports stays open, so anyone can report an incident."""
        return (path.startswith("/admin/") or path == "/sync"
                or (path.startswith("/conflicts/") and path.endswith("/resolve")))

    @app.middleware("http")
    async def gate(request: Request, call_next):
        """Token check first, then crash simulation (a paused node returns 503)."""
        path = request.url.path
        if config.admin_token and request.method != "OPTIONS" and needs_token(path):
            supplied = request.headers.get("x-admin-token", "")
            if not hmac.compare_digest(supplied.encode(), config.admin_token.encode()):
                return JSONResponse(
                    status_code=401,
                    content={"error": "unauthorized",
                             "message": "missing or wrong X-Admin-Token header"},
                )
        open_while_paused = path in ("/healthz", "/admin/resume", "/", "/cluster") or path.startswith("/ui")
        if state.paused and not open_while_paused:
            return JSONResponse(
                status_code=503,
                content={"error": "paused", "message": "node is paused (simulated crash)"},
            )
        return await call_next(request)

    # Added after the gate so it wraps it: a 401 or 503 produced by the gate must still carry
    # the cross-origin headers, or a browser cannot read the status and reports a network error.
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    def error(status: int, code: str, message: str):
        raise HTTPException(status_code=status, detail={"error": code, "message": message})

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {
            "error": "http_error", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content=detail)

    # ---- health and status ---------------------------------------------------------------

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/cluster")
    def cluster(request: Request):
        """Where every node of this cluster can be reached. Lets a dashboard served by one
        node find the others without any configuration."""
        nodes = {config.node_id: str(request.base_url).rstrip("/")}
        for peer in state.sync.peers:
            if peer.id:
                nodes[peer.id] = peer.url
        return {"node_id": config.node_id, "nodes": nodes}

    # The dashboard, if its built files are present, is served by the node itself at /ui.
    ui_dir = os.getenv("DASHBOARD_DIR", "dashboard/dist")
    if os.path.isdir(ui_dir):
        app.mount("/ui", StaticFiles(directory=ui_dir, html=True), name="ui")

        @app.get("/", include_in_schema=False)
        def root():
            return RedirectResponse("/ui/")

    @app.get("/status")
    def status():
        return {
            "node_id": config.node_id,
            "mode": config.mode,
            "epoch": state.epoch,
            "clock_offset_ms": state.clock.offset_ms,
            "paused": state.paused,
            "event_count": state.store.event_count(),
            "state_hash": state.view()[2],
            "integrity": {"rejected_events": state.store.violation_count,
                          "recent": state.store.violations[-5:]},
            "peers": state.sync.peer_status(),
        }

    @app.get("/audit/verify")
    def audit_verify():
        """Recompute the whole hash chain from storage. ok=false means history was altered."""
        return {"node_id": config.node_id, **state.store.verify_chain(),
                "violations": state.store.violations[-20:]}

    @app.get("/audit/heads")
    def audit_heads():
        """Newest (seq, hash) per origin. Compare across nodes: same seq must mean same hash."""
        return {"node_id": config.node_id, "heads": state.store.heads()}

    @app.get("/state-hash")
    def get_state_hash():
        return {"node_id": config.node_id, "hash": state.view()[2],
                "event_count": state.store.event_count()}

    @app.get("/events")
    def events(ids_only: bool = False):
        if ids_only:
            return {"node_id": config.node_id, "event_ids": state.store.event_ids()}
        return {"node_id": config.node_id, "events": state.store.all_events()}

    # ---- replication (node to node) ------------------------------------------------------

    @app.post("/sync")
    def sync(body: SyncBody):
        code, payload = state.sync.handle_request(body.sender, body.epoch, body.vv)
        return JSONResponse(status_code=code, content=payload)

    # ---- reports -------------------------------------------------------------------------

    def present(report: dict) -> dict:
        return {**report, "durability": state.durability(report["report_id"])}

    @app.get("/reports")
    def list_reports():
        reports = sorted(
            state.view()[0], reverse=True,
            key=lambda r: (r["last_updated"]["wall"], r["last_updated"]["counter"],
                           r["last_updated"]["node"]))
        return {"reports": [present(r) for r in reports]}

    @app.get("/reports/{report_id}")
    def get_report(report_id: str):
        report = state.report(report_id)
        if report is None:
            error(404, "not_found", f"report {report_id} not found")
        return present(report)

    @app.post("/reports", status_code=201)
    def create_report(body: ReportCreate):
        report_id = str(uuid.uuid4())
        fields = {
            "incident_type": body.incident_type.value,
            "severity": body.severity,
            "status": body.status.value,
            "location": body.location.model_dump(),
            "description": body.description,
            "reporter": body.reporter,
        }
        event = state.store.append_local(report_id, "create", fields, state.clock.now())
        return {"report_id": report_id, "event_id": event["event_id"], "durability": "local"}

    @app.patch("/reports/{report_id}")
    def patch_report(report_id: str, body: ReportPatch):
        if not state.store.has_report(report_id):
            error(404, "not_found", f"report {report_id} not found")
        changes = body.model_dump(exclude_none=True, mode="json")
        if not changes:
            error(400, "bad_request", "no fields to update")
        event = state.store.append_local(report_id, "update", changes, state.clock.now())

        # The write is always recorded, but escalate-only rules may keep a higher value.
        warnings = []
        merged = state.report(report_id) or {}
        if "severity" in changes and merged.get("severity", 0) > changes["severity"]:
            warnings.append("severity can only escalate; the lower value was recorded but not "
                            "applied. An operator can override it from the conflict ledger.")
        if "status" in changes and (STATUS_ORDER.get(merged.get("status"), -1)
                                    > STATUS_ORDER[changes["status"]]):
            warnings.append("status can only advance; the earlier status was recorded but not "
                            "applied. An operator can override it from the conflict ledger.")
        return {"event_id": event["event_id"], "durability": "local", "warnings": warnings}

    @app.get("/reports/{report_id}/history")
    def history(report_id: str):
        events_ = state.store.events_for_report(report_id)
        if not events_:
            error(404, "not_found", f"report {report_id} not found")
        return {"events": events_}

    # ---- conflict ledger (contract 5.2) --------------------------------------------------

    @app.get("/conflicts")
    def list_conflicts():
        return {"conflicts": state.view()[1]}

    @app.post("/conflicts/{conflict_id}/resolve")
    def resolve_conflict(conflict_id: str, body: ResolveBody):
        entry = state.conflict(conflict_id)
        if entry is None:
            error(404, "not_found", f"conflict {conflict_id} not found (it may have changed; "
                                    "refresh the ledger)")
        if entry["status"] == "operator_resolved":
            error(409, "already_resolved", "an operator already resolved this conflict")
        chosen = next((c for c in entry["candidates"]
                       if c["event_id"] == body.chosen_event_id), None)
        if chosen is None:
            error(400, "bad_request", "chosen_event_id is not one of this conflict's candidates")

        fields = {
            entry["field"]: chosen["value"],
            "_meta": {"operator": body.operator, "conflict_id": conflict_id,
                      "chosen_event_id": body.chosen_event_id},
        }
        state.store.append_local(entry["report_id"], "operator_resolve", fields,
                                 state.clock.now())
        return state.conflict(conflict_id)

    # ---- admin / fault injection (contract 5.4) ------------------------------------------

    @app.post("/admin/block")
    def block(body: PeerBody):
        if body.peer not in VALID_NODES or body.peer == config.node_id:
            error(400, "bad_request", f"unknown peer {body.peer}")
        state.blocked.add(body.peer)
        return {"ok": True, "blocked": sorted(state.blocked)}

    @app.post("/admin/unblock")
    def unblock(body: PeerBody):
        state.blocked.discard(body.peer)
        return {"ok": True, "blocked": sorted(state.blocked)}

    @app.post("/admin/clock")
    def set_clock(body: ClockBody):
        state.clock.offset_ms = body.offset_ms
        return {"ok": True, "clock_offset_ms": state.clock.offset_ms}

    @app.post("/admin/pause")
    def pause():
        state.paused = True
        return {"ok": True, "paused": True}

    @app.post("/admin/resume")
    def resume():
        state.paused = False
        return {"ok": True, "paused": False}

    @app.post("/admin/reset")
    def reset():
        state.reset()
        return {"ok": True, "epoch": state.epoch}

    @app.post("/admin/sync-now")
    def sync_now():
        return {"ok": True, "peers": state.sync.sync_all()}

    return app
