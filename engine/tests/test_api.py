import pytest
from fastapi.testclient import TestClient

from engine.app.config import Config
from engine.app.main import create_app

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
    theirs = {
        "event_id": "hyd-edit-1", "report_id": rid, "origin": "hyd", "seq": 1,
        "hlc": {"wall": 9_999_999_999_999, "counter": 0, "node": "hyd"},
        "op": "update", "fields": {"description": "water knee high"},
        "client_ts": "2026-10-12T10:00:00+00:00", "vv": {"mum": 1, "hyd": 1},
    }
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
