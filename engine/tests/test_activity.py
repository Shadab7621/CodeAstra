"""Activity log: what a region records, and that Atlas problems never reach the request path."""
from fastapi.testclient import TestClient

from engine.app.activity import ActivityLog
from engine.app.config import Config
from engine.app.main import create_app

REPORT = {
    "incident_type": "medical", "severity": 3, "location": {"lat": 19.076, "lon": 72.877},
    "description": "Supply record", "reporter": "citizen-1",
}


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        self.rows = sorted(self.rows, key=lambda r: r[key], reverse=direction < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __iter__(self):
        return iter([dict(r) for r in self.rows])


class FakeCollection:
    """The few pymongo collection calls the activity log uses."""

    def __init__(self):
        self.docs = []
        self.broken = False

    def create_index(self, *_args, **_kwargs):
        pass

    def insert_many(self, docs, ordered=False):
        if self.broken:
            raise ConnectionError("atlas unreachable")
        self.docs.extend(docs)

    def find(self, query, projection=None):
        if self.broken:
            raise ConnectionError("atlas unreachable")
        rows = [d for d in self.docs if all(d.get(k) == v for k, v in query.items())]
        hidden = set(projection or {})
        return FakeCursor([{k: v for k, v in d.items() if k not in hidden} for d in rows])


def node(node_id="mum", collection=None):
    app = create_app(Config(node_id=node_id, port=0, peers=[], db_path=":memory:"),
                     start_sync=False)
    if collection is not None:
        app.state.node.activity = ActivityLog(node_id, collection=collection)
    return TestClient(app), app.state.node


def test_logs_without_atlas_come_from_memory():
    client, _ = node()
    client.post("/reports", json=REPORT)
    data = client.get("/logs").json()
    assert data["source"] == "memory" and data["storage"]["backend"] == "memory"
    kinds = [e["kind"] for e in data["entries"]]
    assert "write" in kinds and "startup" in kinds
    assert data["entries"][0]["t"] >= data["entries"][-1]["t"]  # newest first


def test_entries_are_shipped_to_atlas_and_read_back_from_it():
    coll = FakeCollection()
    client, state = node(collection=coll)
    client.post("/reports", json=REPORT)
    client.post("/admin/block", json={"peer": "hyd"})
    assert state.activity.flush()
    stored = {d["kind"] for d in coll.docs}
    assert {"write", "link"} <= stored
    assert all(d["region"] == "mum" and "at" in d for d in coll.docs)

    data = client.get("/logs").json()
    assert data["source"] == "atlas" and data["storage"]["connected"] is True
    assert any(e["kind"] == "link" and "cut" in e["message"] for e in data["entries"])
    assert all("_id" not in e and "at" not in e for e in data["entries"])
    assert [e["kind"] for e in client.get("/logs", params={"kind": "link"}).json()["entries"]] \
        == ["link"]


def test_any_node_serves_another_regions_log_from_atlas():
    coll = FakeCollection()
    mum, mum_state = node("mum", coll)
    hyd, hyd_state = node("hyd", coll)
    mum.post("/reports", json=REPORT)
    assert mum_state.activity.flush() and hyd_state.activity.flush()
    entries = hyd.get("/logs", params={"region": "mum"}).json()["entries"]
    assert entries and all(e["region"] == "mum" for e in entries)
    assert any(e["kind"] == "write" for e in entries)
    assert hyd.get("/logs", params={"region": "nowhere"}).status_code == 400


def test_clusters_sharing_one_database_do_not_mix():
    coll = FakeCollection()
    app = create_app(Config(node_id="mum", port=0, peers=[], db_path=":memory:", cluster="cloud"),
                     start_sync=False)
    cloud, cloud_state = TestClient(app), app.state.node
    cloud_state.activity = ActivityLog("mum", collection=coll, cluster="cloud")
    local, local_state = node("mum", coll)
    cloud.post("/reports", json=REPORT)
    local.post("/admin/block", json={"peer": "hyd"})
    assert cloud_state.activity.flush() and local_state.activity.flush()
    assert {e["kind"] for e in cloud.get("/logs").json()["entries"]} == {"write"}
    assert {e["kind"] for e in local.get("/logs").json()["entries"]} == {"link"}


def test_logs_stay_readable_while_paused():
    client, _ = node()
    client.post("/admin/pause")
    assert client.get("/reports").status_code == 503
    data = client.get("/logs").json()
    assert any(e["kind"] == "pause" and e["level"] == "bad" for e in data["entries"])


def test_atlas_outage_falls_back_to_memory_and_never_fails_a_request():
    coll = FakeCollection()
    coll.broken = True
    client, state = node(collection=coll)
    assert client.post("/reports", json=REPORT).status_code == 201
    data = client.get("/logs").json()
    assert data["source"] == "memory"
    assert data["storage"]["connected"] is False and data["storage"]["error"]
    assert any(e["kind"] == "write" for e in data["entries"])

    coll.broken = False  # Atlas comes back: the queued entries are delivered
    assert state.activity.flush(timeout=5)
    assert any(d["kind"] == "write" for d in coll.docs)


def test_conflict_and_recovery_are_logged_across_a_partition():
    from engine.tests.test_sync import Cluster, REPORT as SYNC_REPORT
    cluster = Cluster()
    cluster.sync()
    rid = cluster.c["mum"].post("/reports", json=SYNC_REPORT).json()["report_id"]
    cluster.sync()
    cluster.cut("mum", "hyd")
    cluster.cut("mum", "sin")
    cluster.sync(rounds=1)
    cluster.c["mum"].patch(f"/reports/{rid}", json={"severity": 4})
    cluster.c["hyd"].patch(f"/reports/{rid}", json={"severity": 5})
    cluster.heal()
    cluster.sync(rounds=6)

    entries = cluster.c["mum"].get("/logs", params={"limit": 200}).json()["entries"]
    kinds = {e["kind"] for e in entries}
    assert {"write", "link", "sync", "conflict", "recovery"} <= kinds
    conflict = next(e for e in entries if e["kind"] == "conflict")
    assert "Kept 5" in conflict["message"]
    recovery = next(e for e in entries if e["kind"] == "recovery")
    assert recovery["message"].startswith("Link to ")
