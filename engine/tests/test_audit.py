"""Tamper-evident log: a hash chain per origin, verified on demand and on every received event."""
import json
import sqlite3

import pytest

from engine.app.hlc import HLC
from engine.app.store import GENESIS, EventStore, compute_event_hash, seal_event
from test_sync import NODES, REPORT, Cluster


def clock(n=0):
    return HLC(1000 + n, 0, "mum")


def store_with_events(node="mum", count=4):
    store = EventStore(node, ":memory:")
    for i in range(count):
        op = "create" if i == 0 else "update"
        fields = {"description": f"edit {i}"}
        store.append_local("r1", op, fields, HLC(1000 + i, 0, node))
    return store


def test_events_form_a_hash_chain_and_verify():
    store = store_with_events(count=4)
    events = sorted(store.all_events(), key=lambda e: e["seq"])
    assert events[0]["prev_hash"] == GENESIS
    for earlier, later in zip(events, events[1:]):
        assert later["prev_hash"] == earlier["event_hash"]
    assert all(e["event_hash"] == compute_event_hash(e) for e in events)

    report = store.verify_chain()
    assert report["ok"] is True
    assert report["events_checked"] == 4
    assert report["origins"]["mum"]["head_seq"] == 4
    assert store.heads()["mum"] == {"seq": 4, "hash": events[-1]["event_hash"]}


def test_editing_a_stored_event_is_detected():
    store = store_with_events(count=4)
    store._conn.execute(
        "UPDATE events SET fields = ? WHERE origin = 'mum' AND seq = 2",
        (json.dumps({"description": "quietly changed"}),))
    store._conn.commit()
    report = store.verify_chain()
    assert report["ok"] is False
    assert report["origins"]["mum"]["first_bad_seq"] == 2
    assert "hash" in report["origins"]["mum"]["problem"]


def test_removing_a_stored_event_is_detected():
    store = store_with_events(count=4)
    store._conn.execute("DELETE FROM events WHERE origin = 'mum' AND seq = 2")
    store._conn.commit()
    report = store.verify_chain()
    assert report["ok"] is False
    assert report["origins"]["mum"]["first_bad_seq"] == 3


def test_rewriting_an_event_and_its_hash_breaks_the_next_link():
    """An attacker who also recomputes the edited event's own hash is still caught, because
    the following event points at the old hash."""
    store = store_with_events(count=4)
    row = store._conn.execute("SELECT * FROM events WHERE origin='mum' AND seq=2").fetchone()
    event = {k: row[k] for k in row.keys()}
    forged = {
        "event_id": event["event_id"], "report_id": event["report_id"], "origin": "mum",
        "seq": 2, "hlc": {"wall": event["hlc_wall"], "counter": event["hlc_counter"],
                          "node": event["hlc_node"]},
        "op": event["op"], "fields": {"description": "forged"},
        "client_ts": event["client_ts"], "vv": json.loads(event["vv"]),
        "prev_hash": event["prev_hash"],
    }
    forged["event_hash"] = compute_event_hash(forged)
    store._conn.execute(
        "UPDATE events SET fields = ?, event_hash = ? WHERE origin='mum' AND seq=2",
        (json.dumps(forged["fields"]), forged["event_hash"]))
    store._conn.commit()
    report = store.verify_chain()
    assert report["ok"] is False
    assert report["origins"]["mum"]["first_bad_seq"] == 3


def test_forged_remote_event_is_rejected_and_the_honest_one_still_applies():
    source = store_with_events("mum", count=3)
    receiver = EventStore("hyd", ":memory:")
    genuine = sorted(source.all_events(), key=lambda e: e["seq"])

    assert receiver.insert_remote(genuine[0]) is True
    forged = dict(genuine[1], fields={"description": "forged by a bad peer"})
    assert receiver.insert_remote(forged) is False
    assert receiver.violation_count == 1
    assert "hash" in receiver.violations[-1]["reason"]
    assert receiver.version_vector() == {"mum": 1}          # nothing was applied

    assert receiver.insert_remote(genuine[1]) is True       # the real one is accepted later
    assert receiver.insert_remote(genuine[2]) is True
    assert receiver.verify_chain()["ok"] is True


def test_remote_event_with_a_broken_link_is_rejected():
    source = store_with_events("mum", count=3)
    receiver = EventStore("hyd", ":memory:")
    genuine = sorted(source.all_events(), key=lambda e: e["seq"])
    receiver.insert_remote(genuine[0])
    relinked = seal_event({k: v for k, v in genuine[1].items()
                           if k not in ("prev_hash", "event_hash")}, prev_hash="f" * 64)
    assert receiver.insert_remote(relinked) is False
    assert "link" in receiver.violations[-1]["reason"]


def test_unsealed_remote_event_is_rejected():
    source = store_with_events("mum", count=1)
    plain = {k: v for k, v in source.all_events()[0].items()
             if k not in ("prev_hash", "event_hash")}
    receiver = EventStore("hyd", ":memory:")
    assert receiver.insert_remote(plain) is False
    assert "no hash" in receiver.violations[-1]["reason"]


def test_replicas_hold_identical_chains():
    cluster = Cluster()
    for i, name in enumerate(NODES):
        rid = cluster.c[name].post("/reports", json=REPORT).json()["report_id"]
        cluster.c[name].patch(f"/reports/{rid}", json={"description": f"from {name} {i}"})
    cluster.sync()
    heads = [cluster.c[n].get("/audit/heads").json()["heads"] for n in NODES]
    assert heads[0] == heads[1] == heads[2]
    assert set(heads[0]) == set(NODES)
    for name in NODES:
        verdict = cluster.c[name].get("/audit/verify").json()
        assert verdict["ok"] is True and verdict["events_checked"] == 6


def test_a_poisoned_peer_cannot_corrupt_a_replica_and_the_replica_self_heals(monkeypatch):
    cluster = Cluster()
    rid = cluster.c["mum"].post("/reports", json=REPORT).json()["report_id"]
    mum = cluster.node("mum")
    honest = mum.store.events_missing_from

    def poisoned(vv, limit):
        out = honest(vv, limit)
        return [dict(e, fields=dict(e["fields"], description="POISONED")) for e in out]

    monkeypatch.setattr(mum.store, "events_missing_from", poisoned)
    cluster.node("hyd").sync.sync_peer(cluster.node("hyd").sync.peers[0])   # pulls from mum
    hyd = cluster.c["hyd"].get("/status").json()
    assert hyd["integrity"]["rejected_events"] >= 1
    assert cluster.c["hyd"].get(f"/reports/{rid}").status_code == 404       # not applied

    monkeypatch.setattr(mum.store, "events_missing_from", honest)           # peer behaves again
    cluster.sync()
    assert cluster.c["hyd"].get(f"/reports/{rid}").json()["description"] == "Water rising"
    assert cluster.converged()


def test_database_created_before_hash_chaining_is_migrated(tmp_path):
    path = str(tmp_path / "old.db")
    old = sqlite3.connect(path)
    old.executescript("""
        CREATE TABLE events (event_id TEXT PRIMARY KEY, report_id TEXT NOT NULL,
          origin TEXT NOT NULL, seq INTEGER NOT NULL, hlc_wall INTEGER NOT NULL,
          hlc_counter INTEGER NOT NULL, hlc_node TEXT NOT NULL, op TEXT NOT NULL,
          fields TEXT NOT NULL, client_ts TEXT NOT NULL, vv TEXT NOT NULL,
          UNIQUE (origin, seq));
    """)
    old.execute("INSERT INTO events VALUES ('e1','r1','mum',1,5,0,'mum','create',?,?,?)",
                (json.dumps({"description": "legacy"}), "2026-01-01T00:00:00+00:00",
                 json.dumps({"mum": 1})))
    old.commit()
    old.close()

    store = EventStore("mum", path)
    before = store.verify_chain()
    assert before["ok"] is True and before["legacy_events"] == 1

    store.append_local("r1", "update", {"description": "new"}, HLC(10, 0, "mum"))
    after = store.verify_chain()
    assert after["ok"] is True and after["events_checked"] == 2
    assert after["legacy_events"] == 1
