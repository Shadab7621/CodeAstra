"""The baseline must be a fair opponent: it replicates and converges, and it loses concurrent
edits the way a last-writer-wins store does (that is the behaviour being compared)."""
import time

from fastapi.testclient import TestClient

from baseline_lww.app import create_app

NODES = ("mum", "hyd", "sin")
REPORT = {"incident_type": "flood", "severity": 3, "location": {"lat": 19.0, "lon": 72.8},
          "description": "base", "reporter": "t"}


class Net:
    def __init__(self):
        self.c = {}
        for n in NODES:
            peers = {p: f"http://{p}" for p in NODES if p != n}
            self.c[n] = TestClient(create_app(n, peers, fetch=self.fetch, start_sync=False))

    def fetch(self, url):
        host, rest = url[len("http://"):].split("/", 1)
        r = self.c[host].get("/" + rest)
        return r.status_code, r.json()

    def sync(self, rounds=3):
        for _ in range(rounds):
            for n in NODES:
                self.c[n].app.state.node.sync_all()

    def hashes(self):
        return {n: self.c[n].get("/state-hash").json()["hash"] for n in NODES}


def test_replicates_and_converges():
    net = Net()
    rid = net.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    net.sync()
    assert net.c["sin"].get(f"/reports/{rid}").json()["description"] == "base"
    assert len(set(net.hashes().values())) == 1


def test_concurrent_edits_to_different_fields_lose_one_of_them():
    net = Net()
    rid = net.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    net.sync()
    for n in ("hyd", "sin"):
        net.c["mum"].post("/admin/block", json={"peer": n})
    net.c["mum"].patch(f"/reports/{rid}", json={"description": "mumbai edit"})
    time.sleep(0.01)
    net.c["hyd"].patch(f"/reports/{rid}", json={"severity": 5})
    net.c["mum"].post("/admin/unblock", json={"peer": "hyd"})
    net.c["mum"].post("/admin/unblock", json={"peer": "sin"})
    net.sync()

    assert len(set(net.hashes().values())) == 1          # converged, as claimed
    final = net.c["sin"].get(f"/reports/{rid}").json()
    edits_kept = (final["description"] == "mumbai edit") + (final["severity"] == 5)
    assert edits_kept == 1                               # one acknowledged edit vanished
    assert net.c["sin"].get("/conflicts").json() == {"conflicts": []}   # and left no trace


def test_a_fast_clock_overrides_a_causally_later_edit():
    net = Net()
    rid = net.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    net.sync()
    net.c["hyd"].post("/admin/clock", json={"offset_ms": 3_600_000})
    net.c["hyd"].patch(f"/reports/{rid}", json={"description": "old, from the fast clock"})
    net.sync()
    net.c["mum"].patch(f"/reports/{rid}", json={"description": "newest, written after seeing it"})
    net.sync()
    assert net.c["mum"].get(f"/reports/{rid}").json()["description"].startswith("old")


def test_pause_block_and_reset_behave_like_the_engine():
    net = Net()
    net.c["hyd"].post("/admin/pause")
    assert net.c["hyd"].get("/reports").status_code == 503
    net.c["hyd"].post("/admin/resume")
    rid = net.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    net.sync()
    net.c["mum"].post("/admin/reset")
    net.sync()                                            # others still hold old data
    assert net.c["mum"].get("/reports").json()["reports"] == []
    for n in ("hyd", "sin"):
        net.c[n].post("/admin/reset")
    net.sync()
    assert all(net.c[n].get("/reports").json()["reports"] == [] for n in NODES)
    assert net.c["sin"].get(f"/reports/{rid}").status_code == 404
