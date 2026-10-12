"""Engine node: FastAPI app implementing docs/00_CONTRACT.md section 5.

Built so far: health/status, reports (create, patch, merged views, history), conflict ledger
with operator resolve, event ids, state hash, admin fault flags.
Coming next: sync between nodes, durability, peer reachability.
"""
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import VALID_NODES, Config
from .hlc import HybridClock
from .merge import STATUS_ORDER, merge_all, state_hash
from .models import ClockBody, PeerBody, ReportCreate, ReportPatch, ResolveBody
from .store import EventStore


class NodeState:
    """Everything one running node holds in memory."""

    def __init__(self, config: Config):
        self.config = config
        self.store = EventStore(config.node_id, config.db_path)
        self.clock = HybridClock(config.node_id)
        newest = self.store.max_hlc()
        if newest:
            self.clock.observe(newest)  # after a restart, keep stamping forwards
        self.paused = False
        self.blocked: set[str] = set()  # peer node ids we refuse to talk to
        self._view = None

    def view(self) -> tuple[list[dict], list[dict], str]:
        """(reports, conflicts, state hash), recomputed only when the event log changed."""
        version = self.store.version
        if self._view is None or self._view[0] != version:
            reports, conflicts = merge_all(self.store.events_by_report())
            digest = state_hash(reports, self.store.event_ids())
            self._view = (version, reports, conflicts, digest)
        return self._view[1], self._view[2], self._view[3]

    def report(self, report_id: str) -> Optional[dict]:
        return next((r for r in self.view()[0] if r["report_id"] == report_id), None)

    def conflict(self, conflict_id: str) -> Optional[dict]:
        return next((c for c in self.view()[1] if c["conflict_id"] == conflict_id), None)


def create_app(config: Optional[Config] = None) -> FastAPI:
    config = config or Config.from_env()
    state = NodeState(config)
    app = FastAPI(title=f"CodeAstra node {config.node_id}")
    app.state.node = state

    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @app.middleware("http")
    async def pause_gate(request: Request, call_next):
        """A paused node simulates a crash: everything except healthz/resume returns 503."""
        if state.paused and request.url.path not in ("/healthz", "/admin/resume"):
            return JSONResponse(
                status_code=503,
                content={"error": "paused", "message": "node is paused (simulated crash)"},
            )
        return await call_next(request)

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

    @app.get("/status")
    def status():
        peers = [
            {"id": n, "reachable": False, "last_sync_ms_ago": None,
             "pending_out": 0, "pending_in": 0, "blocked": n in state.blocked}
            for n in VALID_NODES if n != config.node_id
        ]
        return {
            "node_id": config.node_id,
            "mode": config.mode,
            "clock_offset_ms": state.clock.offset_ms,
            "paused": state.paused,
            "event_count": state.store.event_count(),
            "state_hash": state.view()[2],
            "peers": peers,
        }

    @app.get("/state-hash")
    def get_state_hash():
        return {"node_id": config.node_id, "hash": state.view()[2],
                "event_count": state.store.event_count()}

    @app.get("/events")
    def events(ids_only: bool = False):
        if ids_only:
            return {"node_id": config.node_id, "event_ids": state.store.event_ids()}
        return {"node_id": config.node_id, "events": state.store.all_events()}

    # ---- reports -------------------------------------------------------------------------

    def present(report: dict) -> dict:
        return {**report, "durability": "local"}  # real durability arrives with sync

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
        state.store.reset()
        state.blocked.clear()
        state.clock.offset_ms = 0
        return {"ok": True}

    @app.post("/admin/sync-now")
    def sync_now():
        return {"ok": True, "note": "sync loop arrives in the next chunk"}

    return app


# Run a node with:  uvicorn engine.app.main:create_app --factory --port 8001
