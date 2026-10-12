"""One test per merge rule in docs/00_CONTRACT.md section 3.4, plus convergence properties."""
import random

from engine.app.merge import (STATUS_ORDER, concurrent, distance_m, happened_before, merge_all,
                              merge_report, state_hash)

MUMBAI = {"lat": 19.0760, "lon": 72.8777}
NEAR_MUMBAI = {"lat": 19.0770, "lon": 72.8777}   # about 110 m away
FAR_MUMBAI = {"lat": 19.2000, "lon": 72.8777}    # about 14 km away


def ev(eid, origin, seq, vv, fields, op="update", wall=0, report="r1"):
    return {
        "event_id": eid, "report_id": report, "origin": origin, "seq": seq,
        "hlc": {"wall": wall, "counter": 0, "node": origin},
        "op": op, "fields": fields, "vv": vv,
        "client_ts": f"2026-10-12T10:00:{wall % 60:02d}+00:00",
    }


def create(severity=3, status="open", description="first", location=MUMBAI):
    return ev("c", "mum", 1, {"mum": 1}, op="create", wall=100, fields={
        "incident_type": "flood", "severity": severity, "status": status,
        "location": location, "description": description, "reporter": "citizen-1"})


def on_mum(fields, eid="m2", wall=200):
    """Mumbai edits after the create, without having seen Hyderabad's edit."""
    return ev(eid, "mum", 2, {"mum": 2}, fields, wall=wall)


def on_hyd(fields, eid="h1", wall=210):
    """Hyderabad edits after the create, without having seen Mumbai's edit."""
    return ev(eid, "hyd", 1, {"mum": 1, "hyd": 1}, fields, wall=wall)


def after_both(fields, eid="s1", wall=300, op="update"):
    """Singapore writes after seeing both concurrent edits."""
    return ev(eid, "sin", 1, {"mum": 2, "hyd": 1, "sin": 1}, fields, op=op, wall=wall)


def merged(*events):
    return merge_report("r1", list(events))


# ---- causality helpers ---------------------------------------------------------------------

def test_causality_from_version_vectors():
    c, m, h, s = create(), on_mum({"severity": 4}), on_hyd({"severity": 5}), after_both({})
    assert happened_before(c, m) and happened_before(c, h)
    assert concurrent(m, h)
    assert happened_before(m, s) and happened_before(h, s)
    assert not concurrent(c, m)


def test_distance():
    assert 100 < distance_m(MUMBAI, NEAR_MUMBAI) < 130
    assert distance_m(MUMBAI, FAR_MUMBAI) > 10_000


# ---- basics --------------------------------------------------------------------------------

def test_single_create_gives_report():
    report, conflicts = merged(create())
    assert report["incident_type"] == "flood" and report["reporter"] == "citizen-1"
    assert report["severity"] == 3 and report["status"] == "open"
    assert report["location"] == MUMBAI and report["description"] == "first"
    assert report["conflicts"] == [] and conflicts == []


def test_updates_without_create_are_not_visible_yet():
    report, conflicts = merged(on_hyd({"severity": 5}))
    assert report is None and conflicts == []


def test_sequential_edit_replaces_value_without_conflict():
    report, conflicts = merged(create(), on_mum({"description": "second"}))
    assert report["description"] == "second" and conflicts == []


# ---- severity: highest wins, escalate only ---------------------------------------------------

def test_severity_concurrent_highest_wins_and_is_recorded():
    report, conflicts = merged(create(), on_mum({"severity": 4}), on_hyd({"severity": 5}))
    assert report["severity"] == 5
    (entry,) = conflicts
    assert entry["field"] == "severity" and entry["status"] == "auto_resolved"
    assert entry["resolution"] == {"policy": "severity: highest wins", "chosen_value": 5}
    assert {c["value"] for c in entry["candidates"]} == {4, 5}
    assert report["conflicts"] == []  # auto-resolved entries do not need the operator


def test_severity_does_not_decrease_on_a_later_lower_write():
    report, conflicts = merged(create(severity=5), on_mum({"severity": 2}))
    assert report["severity"] == 5 and conflicts == []


# ---- status: most advanced wins, never backwards ---------------------------------------------

def test_status_concurrent_most_advanced_wins():
    report, conflicts = merged(create(), on_mum({"status": "acknowledged"}),
                               on_hyd({"status": "resolved"}))
    assert report["status"] == "resolved"
    assert conflicts[0]["resolution"]["policy"] == "status: most advanced wins"


def test_status_never_goes_backwards():
    report, _ = merged(create(status="resolved"), on_mum({"status": "open"}))
    assert report["status"] == "resolved"


# ---- description: keep both, ask the operator ------------------------------------------------

def test_description_concurrent_difference_needs_operator_and_keeps_both():
    report, conflicts = merged(create(), on_mum({"description": "road flooded"}),
                               on_hyd({"description": "water knee high"}))
    (entry,) = conflicts
    assert entry["status"] == "needs_operator" and entry["resolution"] is None
    assert {c["value"] for c in entry["candidates"]} == {"road flooded", "water knee high"}
    assert report["conflicts"] == [entry["conflict_id"]]
    assert report["description"] == "water knee high"  # shown meanwhile: the later timestamp


def test_description_concurrent_same_text_is_not_a_conflict():
    report, conflicts = merged(create(), on_mum({"description": "same"}),
                               on_hyd({"description": "same"}))
    assert report["description"] == "same" and conflicts == []


def test_later_edit_that_saw_both_supersedes_the_conflict():
    report, conflicts = merged(create(), on_mum({"description": "A"}),
                               on_hyd({"description": "B"}), after_both({"description": "C"}))
    assert report["description"] == "C" and report["conflicts"] == []
    (entry,) = conflicts  # still in the ledger, as history
    assert entry["status"] == "auto_resolved"
    assert entry["resolution"] == {"policy": "superseded by a later edit", "chosen_value": "C"}


def test_causally_later_edit_wins_even_with_an_older_wall_clock():
    late_but_wrong_clock = after_both({"description": "newest"}, wall=1)
    report, _ = merged(create(), on_mum({"description": "A"}), on_hyd({"description": "B"}),
                       late_but_wrong_clock)
    assert report["description"] == "newest"


# ---- location: latest wins, conflict when far apart ------------------------------------------

def test_location_concurrent_nearby_latest_wins():
    report, conflicts = merged(create(), on_mum({"location": MUMBAI}, wall=200),
                               on_hyd({"location": NEAR_MUMBAI}, wall=210))
    assert report["location"] == NEAR_MUMBAI
    (entry,) = conflicts
    assert entry["status"] == "auto_resolved"
    assert entry["resolution"]["policy"] == "location: latest wins"


def test_location_concurrent_far_apart_needs_operator():
    create_elsewhere = create(location=NEAR_MUMBAI)
    report, conflicts = merged(create_elsewhere, on_mum({"location": MUMBAI}, wall=200),
                               on_hyd({"location": FAR_MUMBAI}, wall=210))
    assert report["location"] == FAR_MUMBAI
    (entry,) = conflicts
    assert entry["status"] == "needs_operator"
    assert report["conflicts"] == [entry["conflict_id"]]


# ---- operator decisions ----------------------------------------------------------------------

def test_operator_resolves_description_conflict():
    resolve = after_both({"description": "road flooded", "_meta": {"operator": "asha"}},
                         op="operator_resolve")
    report, conflicts = merged(create(), on_mum({"description": "road flooded"}),
                               on_hyd({"description": "water knee high"}), resolve)
    assert report["description"] == "road flooded" and report["conflicts"] == []
    (entry,) = conflicts
    assert entry["status"] == "operator_resolved"
    assert entry["resolution"]["chosen_value"] == "road flooded"
    assert entry["resolution"]["operator"] == "asha"


def test_operator_can_lower_severity():
    resolve = after_both({"severity": 3, "_meta": {"operator": "asha"}}, op="operator_resolve")
    report, conflicts = merged(create(severity=1), on_mum({"severity": 3}),
                               on_hyd({"severity": 5}), resolve)
    assert report["severity"] == 3
    assert conflicts[0]["status"] == "operator_resolved"


def test_escalation_after_operator_decision_still_applies():
    resolve = after_both({"severity": 2, "_meta": {"operator": "asha"}}, op="operator_resolve")
    later = ev("m3", "mum", 3, {"mum": 3, "hyd": 1, "sin": 1}, {"severity": 4}, wall=400)
    report, _ = merged(create(severity=5), on_mum({"severity": 3}), on_hyd({"severity": 4}),
                       resolve, later)
    assert report["severity"] == 4


def test_write_the_operator_had_not_seen_reopens_the_conflict():
    resolve = after_both({"description": "A", "_meta": {"operator": "asha"}},
                         op="operator_resolve")
    unseen = ev("m3", "mum", 3, {"mum": 3}, {"description": "Z"}, wall=250)
    report, conflicts = merged(create(), on_mum({"description": "A"}),
                               on_hyd({"description": "B"}), resolve, unseen)
    assert len(report["conflicts"]) == 1
    assert any(c["status"] == "needs_operator" for c in conflicts)


# ---- convergence -----------------------------------------------------------------------------

def test_result_does_not_depend_on_arrival_order():
    events = [create(), on_mum({"description": "A", "severity": 4}),
              on_hyd({"description": "B", "status": "resolved", "location": FAR_MUMBAI}),
              after_both({"severity": 2})]
    expected = merged(*events)
    rng = random.Random(7)
    for _ in range(20):
        rng.shuffle(events)
        assert merged(*events) == expected


def _simulate(seed: int, steps: int = 60):
    """Three nodes write and sync at random, with one badly skewed clock. Returns each node's
    events after a final full sync, plus every event ever written."""
    rng = random.Random(seed)
    nodes = {n: {} for n in ("mum", "hyd", "sin")}
    skew = {"mum": 0, "hyd": 3_600_000, "sin": -50_000}
    report_ids, counter = [], 0

    def seen(node):
        vv = {}
        for e in nodes[node].values():
            vv[e["origin"]] = max(vv.get(e["origin"], 0), e["seq"])
        return vv

    def write(node, step):
        nonlocal counter
        counter += 1
        vv = seen(node)
        vv[node] = vv.get(node, 0) + 1
        newest = max((e["hlc"]["wall"] for e in nodes[node].values()), default=0)
        wall = max(newest + 1, step * 1000 + skew[node])
        known = [r for r in report_ids if any(
            e["report_id"] == r and e["op"] == "create" for e in nodes[node].values())]
        if not known or rng.random() < 0.2:
            rid = f"r{len(report_ids)}"
            report_ids.append(rid)
            e = ev(f"e{counter:04d}", node, vv[node], vv, op="create", wall=wall, report=rid,
                   fields={"incident_type": "fire", "severity": rng.randint(1, 5),
                           "status": "open", "location": MUMBAI, "description": "d0",
                           "reporter": "x"})
        else:
            field = rng.choice(["severity", "status", "description", "location"])
            value = {"severity": rng.randint(1, 5),
                     "status": rng.choice(list(STATUS_ORDER)),
                     "description": f"d{rng.randint(1, 4)}",
                     "location": rng.choice([MUMBAI, NEAR_MUMBAI, FAR_MUMBAI])}[field]
            e = ev(f"e{counter:04d}", node, vv[node], vv, {field: value}, wall=wall,
                   report=rng.choice(known))
        nodes[node][e["event_id"]] = e

    for step in range(steps):
        if rng.random() < 0.65:
            write(rng.choice(list(nodes)), step)
        else:
            a, b = rng.sample(list(nodes), 2)
            nodes[a].update(nodes[b])
    everything = {}
    for held in nodes.values():
        everything.update(held)
    return nodes, everything


def _by_report(events):
    grouped = {}
    for e in events:
        grouped.setdefault(e["report_id"], []).append(e)
    return grouped


def test_random_histories_converge_and_keep_the_invariants():
    for seed in range(40):
        _, everything = _simulate(seed)
        events = list(everything.values())
        reports, conflicts = merge_all(_by_report(events))
        digest = state_hash(reports, [e["event_id"] for e in events])

        # Same events in any order give the same state and the same hash.
        rng = random.Random(seed)
        for _ in range(3):
            rng.shuffle(events)
            again, again_conflicts = merge_all(_by_report(events))
            assert (again, again_conflicts) == (reports, conflicts)
            assert state_hash(again, [e["event_id"] for e in events]) == digest

        for report in reports:
            mine = [e for e in events if e["report_id"] == report["report_id"]]
            # Escalate-only: the result is the highest value anyone ever wrote.
            assert report["severity"] == max(
                e["fields"]["severity"] for e in mine if "severity" in e["fields"])
            assert report["status"] == max(
                (e["fields"]["status"] for e in mine if "status" in e["fields"]),
                key=STATUS_ORDER.get)
            # No silent overwrite: every concurrent disagreement is in the ledger.
            for field in ("severity", "status", "description", "location"):
                writes = [e for e in mine if field in e["fields"]]
                recorded = {c["event_id"] for entry in conflicts
                            if entry["report_id"] == report["report_id"]
                            and entry["field"] == field for c in entry["candidates"]}
                for a in writes:
                    for b in writes:
                        if concurrent(a, b) and a["fields"][field] != b["fields"][field]:
                            assert {a["event_id"], b["event_id"]} <= recorded


# ---- explanations: which value won and why ----------------------------------------------------

def test_explanation_names_winner_and_rule():
    _, conflicts = merged(create(), on_mum({"severity": 4}), on_hyd({"severity": 5}))
    (entry,) = conflicts
    assert entry["winner"] == {"event_id": "h1", "origin": "hyd", "value": 5}
    text = entry["explanation"]
    assert "Mumbai set 4" in text and "Hyderabad set 5" in text
    assert "highest value wins" in text and "Kept 5 from Hyderabad" in text


def test_explanation_for_open_conflict_asks_for_operator():
    _, conflicts = merged(create(), on_mum({"description": "road flooded"}),
                          on_hyd({"description": "bridge washed out"}))
    (entry,) = conflicts
    assert entry["status"] == "needs_operator" and entry["winner"] is None
    assert "operator has to choose" in entry["explanation"]
