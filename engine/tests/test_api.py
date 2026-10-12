import pytest
from fastapi.testclient import TestClient

from engine.app.config import Config
from engine.app.main import create_app
from engine.app.store import seal_event

REPORT = {
    "incident_type": "flood",
    "severity": 3,
    "location": {"lat": 19.076, "lon": 72.877},
    "description": "Water rising on main road",
    "reporter": "citizen-1",
}


@pytest.fixture
def client():
    app = create_app(Config(node_id="mum", port=8001, db_path=":memory:"))
    return TestClient(app)


def test_healthz_and_status(client):
    assert client.get("/healthz").json() == {"ok": True}
    s = client.get("/status").json()
    assert s["node_id"] == "mum"
    assert s["mode"] == "crdt"
    assert s["event_count"] == 0
    assert {p["id"] for p in s["peers"]} == {"hyd", "sin"}


def test_create_report_returns_contract_shape(client):
    r = client.post("/reports", json=REPORT)
    assert r.status_code == 201
    body = r.json()
    assert body["durability"] == "local"
    assert body["report_id"] and body["event_id"]


def test_create_validates_input(client):
    bad = dict(REPORT, severity=9)
    assert client.post("/reports", json=bad).status_code == 422
    bad = dict(REPORT, incident_type="earthquake")
    assert client.post("/reports", json=bad).status_code == 422


def test_patch_appends_event_and_history_is_ordered(client):
    rid = client.post("/reports", json=REPORT).json()["report_id"]
    r = client.patch(f"/reports/{rid}", json={"severity": 5})
    assert r.status_code == 200
    client.patch(f"/reports/{rid}", json={"status": "acknowledged"})
    events = client.get(f"/reports/{rid}/history").json()["events"]
    assert [e["op"] for e in events] == ["create", "update", "update"]
    hlcs = [(e["hlc"]["wall"], e["hlc"]["counter"]) for e in events]
    assert hlcs == sorted(hlcs)
    assert [e["seq"] for e in events] == [1, 2, 3]
    # vv records what the node had seen, itself included
    assert events[2]["vv"] == {"mum": 3}


def test_patch_unknown_report_is_404(client):
    r = client.patch("/reports/does-not-exist", json={"severity": 2})
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_patch_without_fields_is_400(client):
    rid = client.post("/reports", json=REPORT).json()["report_id"]
    assert client.patch(f"/reports/{rid}", json={}).status_code == 400


def test_get_reports_returns_merged_contract_shape(client):
    rid = client.post("/reports", json=REPORT).json()["report_id"]
    client.patch(f"/reports/{rid}", json={"severity": 5, "status": "acknowledged"})
    (report,) = client.get("/reports").json()["reports"]
    assert report == client.get(f"/reports/{rid}").json()
    assert report["report_id"] == rid
    assert report["severity"] == 5 and report["status"] == "acknowledged"
    assert report["incident_type"] == "flood" and report["reporter"] == "citizen-1"
    assert report["durability"] == "local"
    assert report["conflicts"] == [] and report["possible_duplicates"] == []
    assert set(report["last_updated"]) == {"wall", "counter", "node"}
    assert client.get("/reports/nope").status_code == 404


def test_lowering_severity_is_recorded_but_not_applied(client):
    rid = client.post("/reports", json=dict(REPORT, severity=5)).json()["report_id"]
    r = client.patch(f"/reports/{rid}", json={"severity": 2})
    assert r.status_code == 200 and len(r.json()["warnings"]) == 1
    assert client.get(f"/reports/{rid}").json()["severity"] == 5
    assert len(client.get(f"/reports/{rid}/history").json()["events"]) == 2
    assert client.patch(f"/reports/{rid}", json={"description": "x"}).json()["warnings"] == []


def test_conflict_ledger_and_operator_resolve(client):
    rid = client.post("/reports", json=REPORT).json()["report_id"]
    mine = client.patch(f"/reports/{rid}", json={"description": "road flooded"}).json()
    assert client.get("/conflicts").json() == {"conflicts": []}

    # Hyderabad edited the same field without having seen Mumbai's edit.
    theirs = seal_event({
        "event_id": "hyd-edit-1", "report_id": rid, "origin": "hyd", "seq": 1,
        "hlc": {"wall": 9_999_999_999_999, "counter": 0, "node": "hyd"},
        "op": "update", "fields": {"description": "water knee high"},
        "client_ts": "2026-10-12T10:00:00+00:00", "vv": {"mum": 1, "hyd": 1},
    })
    assert client.app.state.node.store.insert_remote(theirs) is True
    assert client.app.state.node.store.insert_remote(theirs) is False  # idempotent

    (entry,) = client.get("/conflicts").json()["conflicts"]
    assert entry["status"] == "needs_operator" and entry["field"] == "description"
    assert client.get(f"/reports/{rid}").json()["conflicts"] == [entry["conflict_id"]]

    url = f"/conflicts/{entry['conflict_id']}/resolve"
    assert client.post("/conflicts/nope/resolve", json={
        "chosen_event_id": "x", "operator": "asha"}).status_code == 404
    assert client.post(url, json={"chosen_event_id": "x", "operator": "asha"}).status_code == 400

    resolved = client.post(url, json={"chosen_event_id": mine["event_id"], "operator": "asha"})
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "operator_resolved"
    assert resolved.json()["resolution"]["operator"] == "asha"
    report = client.get(f"/reports/{rid}").json()
    assert report["description"] == "road flooded" and report["conflicts"] == []
    assert client.post(url, json={
        "chosen_event_id": mine["event_id"], "operator": "asha"}).status_code == 409


def test_restarted_node_keeps_stamping_forwards(tmp_path):
    cfg = Config(node_id="mum", port=8001, db_path=str(tmp_path / "mum.db"))
    first = TestClient(create_app(cfg))
    first.post("/admin/clock", json={"offset_ms": 3_600_000})  # clock an hour fast
    rid = first.post("/reports", json=REPORT).json()["report_id"]

    restarted = TestClient(create_app(cfg))  # same file, clock back to normal
    assert restarted.get(f"/reports/{rid}").json()["severity"] == 3  # data survived
    restarted.patch(f"/reports/{rid}", json={"description": "after restart"})
    events = restarted.get(f"/reports/{rid}/history").json()["events"]
    assert [e["op"] for e in events] == ["create", "update"]
    assert restarted.get(f"/reports/{rid}").json()["description"] == "after restart"


def test_token_protects_admin_sync_and_operator_endpoints():
    app = create_app(Config(node_id="mum", port=8001, db_path=":memory:", admin_token="s3cret"))
    c = TestClient(app)
    good = {"X-Admin-Token": "s3cret"}

    # Open: health, status, reading and creating reports, history, conflicts list.
    assert c.get("/healthz").status_code == 200
    assert c.get("/status").status_code == 200
    rid = c.post("/reports", json=REPORT).json()["report_id"]
    assert c.get(f"/reports/{rid}").status_code == 200
    assert c.patch(f"/reports/{rid}", json={"severity": 5}).status_code == 200
    assert c.get("/conflicts").status_code == 200

    # Protected: no header, or a wrong one, gives 401 and changes nothing.
    for headers in ({}, {"X-Admin-Token": "nope"}):
        assert c.post("/admin/pause", headers=headers).status_code == 401
        assert c.post("/admin/reset", headers=headers).status_code == 401
        assert c.post("/admin/clock", json={"offset_ms": 5}, headers=headers).status_code == 401
        assert c.post("/sync", json={"sender": "hyd", "epoch": 0, "vv": {}},
                      headers=headers).status_code == 401
        assert c.post("/conflicts/x/resolve", json={
            "chosen_event_id": "e", "operator": "o"}, headers=headers).status_code == 401
    assert c.get("/status").json()["paused"] is False
    assert c.get("/status").json()["clock_offset_ms"] == 0

    # With the token the same calls work, including resume while paused.
    assert c.post("/admin/pause", headers=good).status_code == 200
    assert c.get("/reports").status_code == 503
    assert c.post("/admin/resume").status_code == 401          # token still required
    assert c.post("/admin/resume", headers=good).status_code == 200
    assert c.post("/sync", json={"sender": "hyd", "epoch": 0, "vv": {}},
                  headers=good).status_code == 200
    # Browser pre-flight requests must not be rejected.
    assert c.options("/admin/pause", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-admin-token"}).status_code == 200


def test_refusals_are_readable_by_a_browser():
    """A 401 or 503 must carry the cross-origin header, or a browser sees only a network error
    and the dashboard cannot tell 'refused' or 'paused' from 'unreachable'."""
    app = create_app(Config(node_id="mum", port=8001, db_path=":memory:", admin_token="s3cret"))
    c = TestClient(app)
    origin = {"Origin": "http://127.0.0.1:4173"}

    refused = c.post("/admin/pause", headers=origin)
    assert refused.status_code == 401
    assert refused.headers.get("access-control-allow-origin") == "*"

    c.post("/admin/pause", headers={"X-Admin-Token": "s3cret"})
    paused = c.get("/status", headers=origin)
    assert paused.status_code == 503
    assert paused.headers.get("access-control-allow-origin") == "*"


def test_cluster_endpoint_lists_every_node():
    app = create_app(Config(node_id="mum", port=8001, db_path=":memory:",
                            peers=["hyd=http://10.0.0.2:8002", "sin=http://10.0.0.3:8003"]),
                     start_sync=False)
    c = TestClient(app, base_url="http://10.0.0.1:8001")
    body = c.get("/cluster").json()
    assert body["node_id"] == "mum"
    assert body["nodes"] == {"mum": "http://10.0.0.1:8001", "hyd": "http://10.0.0.2:8002",
                             "sin": "http://10.0.0.3:8003"}


def test_node_serves_the_dashboard_when_built(tmp_path, monkeypatch):
    ui = tmp_path / "dist"
    ui.mkdir()
    (ui / "index.html").write_text("<!doctype html><title>dash</title>")
    monkeypatch.setenv("DASHBOARD_DIR", str(ui))
    c = TestClient(create_app(Config(node_id="mum", port=8001, db_path=":memory:")))
    assert "dash" in c.get("/ui/").text
    assert c.get("/", follow_redirects=False).headers["location"] == "/ui/"
    c.post("/admin/pause")
    assert c.get("/ui/").status_code == 200      # the console stays reachable when a node is paused
    assert c.get("/cluster").status_code == 200
    assert c.get("/reports").status_code == 503


def test_no_token_configured_means_open(client):
    assert client.post("/admin/clock", json={"offset_ms": 1}).status_code == 200


def test_events_ids_only_lists_every_acknowledged_write(client):
    ids = [client.post("/reports", json=REPORT).json()["event_id"] for _ in range(3)]
    listed = client.get("/events", params={"ids_only": "true"}).json()["event_ids"]
    assert set(ids) <= set(listed)


def test_state_hash_changes_with_data(client):
    h0 = client.get("/state-hash").json()["hash"]
    client.post("/reports", json=REPORT)
    assert client.get("/state-hash").json()["hash"] != h0


def test_pause_returns_503_but_healthz_and_resume_work(client):
    client.post("/admin/pause")
    assert client.get("/status").status_code == 503
    assert client.get("/healthz").status_code == 200
    client.post("/admin/resume")
    assert client.get("/status").status_code == 200


def test_clock_offset_and_reset(client):
    client.post("/admin/clock", json={"offset_ms": 3_600_000})
    assert client.get("/status").json()["clock_offset_ms"] == 3_600_000
    client.post("/reports", json=REPORT)
    client.post("/admin/reset")
    s = client.get("/status").json()
    assert s["event_count"] == 0 and s["clock_offset_ms"] == 0


def test_block_and_unblock_peer(client):
    client.post("/admin/block", json={"peer": "hyd"})
    peers = {p["id"]: p for p in client.get("/status").json()["peers"]}
    assert peers["hyd"]["blocked"] is True
    client.post("/admin/unblock", json={"peer": "hyd"})
    peers = {p["id"]: p for p in client.get("/status").json()["peers"]}
    assert peers["hyd"]["blocked"] is False
    assert client.post("/admin/block", json={"peer": "mum"}).status_code == 400
