"""Three nodes wired together in-process (no sockets, no timers), so every failure scenario is
deterministic. Sync rounds are triggered by hand."""
import random

import pytest
from fastapi.testclient import TestClient

from engine.app import sync as sync_module
from engine.app.config import Config
from engine.app.main import create_app

NODES = ("mum", "hyd", "sin")
REPORT = {
    "incident_type": "flood", "severity": 3,
    "location": {"lat": 19.076, "lon": 72.877},
    "description": "Water rising", "reporter": "citizen-1",
}


class Cluster:
    def __init__(self):
        self.c = {}
        for node in NODES:
            peers = [f"{p}=http://{p}" for p in NODES if p != node]
            app = create_app(Config(node_id=node, port=0, peers=peers, db_path=":memory:"),
                             post=self.post, start_sync=False)
            self.c[node] = TestClient(app)

    def post(self, url, payload):
        """Stands in for the network: delivers a node-to-node call directly."""
        host, path = url[len("http://"):].split("/", 1)
        r = self.c[host].post("/" + path, json=payload)
        return r.status_code, r.json()

    def node(self, name):
        return self.c[name].app.state.node

    def sync(self, rounds=3):
        for _ in range(rounds):
            for name in NODES:
                self.node(name).sync.sync_all()

    def cut(self, a, b):
        self.c[a].post("/admin/block", json={"peer": b})
        self.c[b].post("/admin/block", json={"peer": a})

    def heal(self):
        for a in NODES:
            for b in NODES:
                if a != b:
                    self.c[a].post("/admin/unblock", json={"peer": b})

    def hashes(self):
        return {n: self.c[n].get("/state-hash").json()["hash"] for n in NODES}

    def converged(self):
        return len(set(self.hashes().values())) == 1

    def event_ids(self, name):
        return set(self.c[name].get("/events", params={"ids_only": "true"}).json()["event_ids"])

    def durability(self, name, rid):
        return self.c[name].get(f"/reports/{rid}").json()["durability"]

    def peer(self, name, peer_id):
        return next(p for p in self.c[name].get("/status").json()["peers"] if p["id"] == peer_id)


@pytest.fixture
def cluster():
    return Cluster()


def test_report_replicates_to_all_nodes(cluster):
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    assert cluster.c["hyd"].get(f"/reports/{rid}").status_code == 404
    cluster.sync()
    for name in NODES:
        assert cluster.c[name].get(f"/reports/{rid}").json()["description"] == "Water rising"
    assert cluster.converged()


def test_durability_goes_local_replicated_confirmed(cluster):
    cluster.cut("mum", "sin")
    cluster.cut("hyd", "sin")
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    assert cluster.durability("mum", rid) == "local"
    cluster.sync()
    assert cluster.durability("mum", rid) == "replicated"   # Hyderabad has it, Singapore not
    assert cluster.durability("hyd", rid) == "replicated"
    cluster.heal()
    cluster.sync()
    for name in NODES:
        assert cluster.durability(name, rid) == "confirmed"


def test_partition_concurrent_edit_then_heal(cluster):
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    cluster.cut("mum", "hyd")
    cluster.cut("mum", "sin")

    acked = [
        cluster.c["mum"].patch(f"/reports/{rid}", json={
            "description": "road flooded", "severity": 4}).json()["event_id"],
        cluster.c["hyd"].patch(f"/reports/{rid}", json={
            "description": "water knee high", "severity": 5}).json()["event_id"],
    ]
    cluster.sync()
    assert cluster.hashes()["mum"] != cluster.hashes()["hyd"]      # the regions disagree
    assert cluster.hashes()["hyd"] == cluster.hashes()["sin"]      # the majority side agrees
    assert cluster.c["mum"].get(f"/reports/{rid}").json()["description"] == "road flooded"
    assert cluster.peer("mum", "hyd")["reachable"] is False
    assert cluster.peer("mum", "hyd")["pending_out"] == 1

    cluster.heal()
    cluster.sync()
    assert cluster.converged()
    ledgers = [cluster.c[n].get("/conflicts").json() for n in NODES]
    assert ledgers[0] == ledgers[1] == ledgers[2]
    by_field = {c["field"]: c for c in ledgers[0]["conflicts"]}
    assert by_field["description"]["status"] == "needs_operator"
    assert {c["value"] for c in by_field["description"]["candidates"]} == {
        "road flooded", "water knee high"}                         # both versions kept
    assert by_field["severity"]["status"] == "auto_resolved"
    for name in NODES:
        assert cluster.c[name].get(f"/reports/{rid}").json()["severity"] == 5
        assert set(acked) <= cluster.event_ids(name)               # no acknowledged write lost


def test_nodes_converge_through_a_third_node(cluster):
    """Mumbai and Hyderabad cannot talk, but both reach Singapore."""
    cluster.cut("mum", "hyd")
    a = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    b = cluster.c["hyd"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    assert cluster.converged()
    assert cluster.c["hyd"].get(f"/reports/{a}").status_code == 200
    assert cluster.c["mum"].get(f"/reports/{b}").status_code == 200


def test_one_sided_block_cuts_both_directions(cluster):
    cluster.c["mum"].post("/admin/block", json={"peer": "hyd"})
    cluster.c["mum"].post("/admin/block", json={"peer": "sin"})
    rid = cluster.c["hyd"].post("/reports", json=REPORT).json()["report_id"]
    mine = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    assert cluster.c["mum"].get(f"/reports/{rid}").status_code == 404
    assert cluster.c["hyd"].get(f"/reports/{mine}").status_code == 404
    assert cluster.peer("hyd", "mum")["reason"] == "blocked"


def test_crash_and_recover(cluster):
    before = cluster.c["hyd"].post("/reports", json=REPORT).json()["report_id"]
    cluster.c["hyd"].post("/admin/pause")
    assert cluster.c["hyd"].post("/reports", json=REPORT).status_code == 503
    during = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    assert cluster.peer("mum", "hyd")["reason"] == "paused"
    assert cluster.durability("mum", during) == "replicated"       # Singapore only

    cluster.c["hyd"].post("/admin/resume")
    cluster.sync()
    assert cluster.converged()
    assert cluster.c["hyd"].get(f"/reports/{during}").status_code == 200
    assert cluster.c["mum"].get(f"/reports/{before}").status_code == 200  # nothing lost in crash


def test_wrong_clock_cannot_override_a_later_edit(cluster):
    cluster.c["hyd"].post("/admin/clock", json={"offset_ms": 3_600_000})   # one hour fast
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    cluster.c["hyd"].patch(f"/reports/{rid}", json={"description": "from the fast clock"})
    cluster.sync()
    # Mumbai has SEEN Hyderabad's edit and now writes a newer one with a "slower" clock.
    cluster.c["mum"].patch(f"/reports/{rid}", json={"description": "the real latest"})
    cluster.sync()
    assert cluster.converged()
    for name in NODES:
        assert cluster.c[name].get(f"/reports/{rid}").json()["description"] == "the real latest"
    assert cluster.c["mum"].get("/conflicts").json()["conflicts"] == []


def test_operator_decision_replicates(cluster):
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    cluster.cut("mum", "hyd")
    cluster.cut("mum", "sin")
    mine = cluster.c["mum"].patch(f"/reports/{rid}", json={"description": "A"}).json()
    cluster.c["hyd"].patch(f"/reports/{rid}", json={"description": "B"})
    cluster.heal()
    cluster.sync()
    (entry,) = cluster.c["sin"].get("/conflicts").json()["conflicts"]
    r = cluster.c["sin"].post(f"/conflicts/{entry['conflict_id']}/resolve", json={
        "chosen_event_id": mine["event_id"], "operator": "asha"})
    assert r.status_code == 200
    cluster.sync()
    assert cluster.converged()
    for name in NODES:
        (seen,) = cluster.c[name].get("/conflicts").json()["conflicts"]
        assert seen["status"] == "operator_resolved"
        assert cluster.c[name].get(f"/reports/{rid}").json()["description"] == "A"


def test_resetting_nodes_one_at_a_time_does_not_bring_data_back(cluster):
    cluster.c["mum"].post("/reports", json=REPORT)
    cluster.sync()
    cluster.c["mum"].post("/admin/reset")
    cluster.sync()                                   # the others still hold the old data
    assert cluster.c["mum"].get("/reports").json()["reports"] == []
    assert cluster.peer("mum", "hyd")["reason"] == "epoch_mismatch"
    cluster.c["hyd"].post("/admin/reset")
    cluster.c["sin"].post("/admin/reset")
    cluster.sync()
    assert cluster.converged()
    for name in NODES:
        assert cluster.c[name].get("/status").json()["event_count"] == 0
    rid = cluster.c["hyd"].post("/reports", json=REPORT).json()["report_id"]
    cluster.sync()
    assert cluster.c["mum"].get(f"/reports/{rid}").status_code == 200   # syncing works again


def test_events_out_of_order_or_duplicated_are_safe(cluster):
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    for i in range(3):
        cluster.c["mum"].patch(f"/reports/{rid}", json={"description": f"edit {i}"})
    events = cluster.c["mum"].get("/events").json()["events"]
    hyd = cluster.node("hyd")
    assert hyd.apply_remote([events[2], events[3]], hyd.epoch) == 0   # gap: seq 1 and 2 missing
    assert hyd.apply_remote(list(reversed(events)), hyd.epoch) == 4   # any order in one batch
    assert hyd.apply_remote(events, hyd.epoch) == 0                   # duplicates ignored
    assert cluster.event_ids("hyd") == cluster.event_ids("mum")


def test_long_outage_catches_up_in_batches(cluster, monkeypatch):
    monkeypatch.setattr(sync_module, "MAX_EVENTS_PER_SYNC", 5)
    cluster.cut("mum", "hyd")
    cluster.cut("mum", "sin")
    for i in range(23):
        cluster.c["mum"].post("/reports", json=dict(REPORT, description=f"report {i}"))
    cluster.heal()
    cluster.sync(rounds=1)
    assert 0 < cluster.c["hyd"].get("/status").json()["event_count"] < 23
    cluster.sync(rounds=6)
    assert cluster.converged()
    assert cluster.c["sin"].get("/status").json()["event_count"] == 23


def test_sync_now_endpoint(cluster):
    cluster.c["mum"].post("/reports", json=REPORT)
    result = cluster.c["hyd"].post("/admin/sync-now").json()
    assert {p["id"] for p in result["peers"]} == {"mum", "sin"}
    assert sum(p["applied"] for p in result["peers"]) == 1


def test_random_faults_always_converge_without_losing_acknowledged_writes():
    """A small in-process version of the chaos tester: random writes, partitions, crashes and
    clock skew, then heal and check the invariants."""
    for seed in range(25):
        rng = random.Random(seed)
        cluster = Cluster()
        acked, reports = set(), []
        for _ in range(60):
            name = rng.choice(NODES)
            roll = rng.random()
            if roll < 0.25:
                r = cluster.c[name].post("/reports", json=dict(
                    REPORT, severity=rng.randint(1, 5)))
                if r.status_code == 201:
                    acked.add(r.json()["event_id"])
                    reports.append(r.json()["report_id"])
            elif roll < 0.60 and reports:
                field = rng.choice(["severity", "status", "description", "location"])
                value = {
                    "severity": rng.randint(1, 5),
                    "status": rng.choice(["open", "acknowledged", "in_progress", "resolved"]),
                    "description": f"text {rng.randint(1, 4)}",
                    "location": {"lat": 19.0 + rng.choice([0.0, 0.001, 0.2]), "lon": 72.8},
                }[field]
                r = cluster.c[name].patch(f"/reports/{rng.choice(reports)}", json={field: value})
                if r.status_code == 200:
                    acked.add(r.json()["event_id"])
            elif roll < 0.70:
                cluster.cut(*rng.sample(NODES, 2))
            elif roll < 0.76:
                cluster.heal()
            elif roll < 0.82:
                cluster.c[name].post("/admin/pause")
            elif roll < 0.88:
                cluster.c[name].post("/admin/resume")
            elif roll < 0.92:
                cluster.c[name].post("/admin/clock", json={
                    "offset_ms": rng.choice([-3_600_000, 0, 3_600_000])})
            else:
                cluster.node(name).sync.sync_all()

        for name in NODES:
            cluster.c[name].post("/admin/resume")
        cluster.heal()
        cluster.sync(rounds=4)

        assert cluster.converged(), f"seed {seed}: nodes did not converge"
        ledgers = [cluster.c[n].get("/conflicts").json() for n in NODES]
        assert ledgers[0] == ledgers[1] == ledgers[2], f"seed {seed}: ledgers differ"
        for name in NODES:
            assert acked <= cluster.event_ids(name), f"seed {seed}: {name} lost a write"
            for report in cluster.c[name].get("/reports").json()["reports"]:
                assert report["durability"] == "confirmed", f"seed {seed}"
