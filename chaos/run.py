"""Fault-injection benchmark: the engine versus a last-writer-wins baseline.

Start both clusters first:   python infra/run_cluster.py --baseline --fast
Then:                        python -m chaos.run --trials 10 --seed 1

Every trial resets a cluster, applies one failure scenario with randomised nodes and values,
heals, waits for the replicas to converge, then judges the result. The same scenarios and the
same random choices are applied to both clusters.

An acknowledged edit counts as SILENTLY LOST when its value is not in the final report, not in
any conflict-ledger entry for that field, and the system gave no warning when it accepted it.
"""
import argparse
import json
import random
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

NODES = ("mum", "hyd", "sin")
CLUSTERS = {
    "ours": {n: f"http://127.0.0.1:{8001 + i}" for i, n in enumerate(NODES)},
    "lww": {n: f"http://127.0.0.1:{9001 + i}" for i, n in enumerate(NODES)},
}
RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
SETTLE_S = 0.4          # time for in-flight sync rounds before the next step
CONVERGE_TIMEOUT_S = 15.0
STATUS_ORDER = ["open", "acknowledged", "in_progress", "resolved"]


class Cluster:
    def __init__(self, name):
        self.name, self.urls = name, CLUSTERS[name]
        self.http = httpx.Client(timeout=5.0)

    def call(self, node, method, path, body=None):
        r = self.http.request(method, self.urls[node] + path, json=body)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, None

    def reset(self):
        for n in NODES:
            self.call(n, "POST", "/admin/resume")
        for n in NODES:
            self.call(n, "POST", "/admin/reset")

    def hashes(self):
        out = {}
        for n in NODES:
            code, body = self.call(n, "GET", "/state-hash")
            out[n] = body["hash"] if code == 200 else None
        return out

    def converged(self):
        h = self.hashes()
        return None not in h.values() and len(set(h.values())) == 1

    def wait_converged(self):
        """Seconds until all replicas agree, or None on timeout."""
        start = time.monotonic()
        while time.monotonic() - start < CONVERGE_TIMEOUT_S:
            if self.converged():
                return time.monotonic() - start
            time.sleep(0.05)
        return None

    def cut(self, a, b):
        self.call(a, "POST", "/admin/block", {"peer": b})
        self.call(b, "POST", "/admin/block", {"peer": a})

    def isolate(self, node):
        for other in NODES:
            if other != node:
                self.cut(node, other)

    def heal(self):
        for a in NODES:
            for b in NODES:
                if a != b:
                    self.call(a, "POST", "/admin/unblock", {"peer": b})
            self.call(a, "POST", "/admin/resume")
            self.call(a, "POST", "/admin/clock", {"offset_ms": 0})

    def create(self, node, rng, ledger):
        body = {"incident_type": rng.choice(["flood", "fire", "road_blocked", "medical"]),
                "severity": rng.randint(1, 3), "location": {"lat": 19.0, "lon": 72.8},
                "description": f"base-{rng.randint(0, 999)}", "reporter": "bench"}
        code, r = self.call(node, "POST", "/reports", body)
        if code != 201:
            return None
        ledger["acked"].add(r["event_id"])
        return r["report_id"]

    def edit(self, node, report_id, field, value, ledger):
        code, r = self.call(node, "PATCH", f"/reports/{report_id}", {field: value})
        if code != 200:
            return False                      # not acknowledged: does not count against anyone
        ledger["acked"].add(r["event_id"])
        ledger["intents"][(report_id, field, node)] = {
            "value": value, "warned": bool(r.get("warnings"))}
        return True

    def final_state(self):
        code, body = self.call("mum", "GET", "/reports")
        reports = {r["report_id"]: r for r in body["reports"]} if code == 200 else {}
        code, body = self.call("mum", "GET", "/conflicts")
        entries = body["conflicts"] if code == 200 else []
        return reports, entries

    def surviving_events(self):
        code, body = self.call("mum", "GET", "/events?ids_only=true")
        return set(body["event_ids"]) if code == 200 else set()


def random_value(rng, field):
    if field == "severity":
        return rng.randint(1, 5)
    if field == "status":
        return rng.choice(STATUS_ORDER)
    return f"text-{rng.randint(0, 99999)}"


def new_ledger():
    return {"acked": set(), "intents": {}, "checks": []}


# ---- scenarios: each returns a ledger describing what was acknowledged --------------------

def setup(cluster, rng, ledger, reports=3):
    cluster.reset()
    cluster.wait_converged()
    ids = [cluster.create(rng.choice(NODES), rng, ledger) for _ in range(reports)]
    cluster.wait_converged()
    return [i for i in ids if i]


def edits_on_both_sides(cluster, rng, ledger, report_id, sides):
    """Each side edits the same report while cut off from the others."""
    for node in sides:
        for field in rng.sample(["description", "severity", "status"], rng.randint(1, 3)):
            cluster.edit(node, report_id, field, random_value(rng, field), ledger)
            if rng.random() < 0.3:    # a second edit to the same field, same side
                cluster.edit(node, report_id, field, random_value(rng, field), ledger)


def scenario_partition_edit(cluster, rng):
    ledger = new_ledger()
    ids = setup(cluster, rng, ledger)
    isolated = rng.choice(NODES)
    other = rng.choice([n for n in NODES if n != isolated])
    cluster.isolate(isolated)
    time.sleep(SETTLE_S)
    # One node per side, so the two sets of edits are truly concurrent. Two connected nodes
    # editing would be ordinary sequential edits, where the later one rightly replaces the first.
    edits_on_both_sides(cluster, rng, ledger, rng.choice(ids), (isolated, other))
    time.sleep(SETTLE_S)
    return ledger, ids


def scenario_pairwise_partition(cluster, rng):
    ledger = new_ledger()
    ids = setup(cluster, rng, ledger)
    a, b = rng.sample(NODES, 2)
    cluster.cut(a, b)                    # both can still reach the third node
    time.sleep(SETTLE_S)
    # The third node relays each side's edits to the other, so an edit can legitimately be
    # replaced by a later one that saw it. Each side therefore owns a different field here.
    target = rng.choice(ids)
    for node, field in ((a, "description"), (b, "severity")):
        for _ in range(rng.randint(1, 3)):
            cluster.edit(node, target, field, random_value(rng, field), ledger)
    time.sleep(SETTLE_S)
    return ledger, ids


def scenario_flapping_link(cluster, rng):
    ledger = new_ledger()
    ids = setup(cluster, rng, ledger)
    a, b = rng.sample(NODES, 2)
    target = rng.choice(ids)
    own_field = {a: "description", b: "severity"}   # each node owns a field: no legitimate
    for i in range(6):                               # supersession, so any loss is a real loss
        if i % 2 == 0:
            cluster.cut(a, b)
        else:
            for n, other in ((a, b), (b, a)):
                cluster.call(n, "POST", "/admin/unblock", {"peer": other})
        node = (a, b)[i % 2 == 1] if rng.random() < 0.5 else rng.choice((a, b))
        cluster.edit(node, target, own_field[node], random_value(rng, own_field[node]), ledger)
        time.sleep(0.05)
    return ledger, ids


def scenario_crash_recover(cluster, rng):
    ledger = new_ledger()
    ids = setup(cluster, rng, ledger)
    victim = rng.choice(NODES)
    cluster.call(victim, "POST", "/admin/pause")
    time.sleep(SETTLE_S)
    target = rng.choice(ids)
    own_field = {"mum": "description", "hyd": "severity", "sin": "status"}
    for node in NODES:                   # the paused node's writes fail (never acknowledged)
        cluster.edit(node, target, own_field[node], random_value(rng, own_field[node]), ledger)
    time.sleep(SETTLE_S)
    return ledger, ids


def scenario_clock_skew(cluster, rng):
    """A node with a fast clock writes first; a later edit by another node, made after it saw
    the first, must win. Last-writer-wins lets the fast clock override it."""
    ledger = new_ledger()
    ids = setup(cluster, rng, ledger)
    fast, slow = rng.sample(NODES, 2)
    target = rng.choice(ids)
    cluster.call(fast, "POST", "/admin/clock", {"offset_ms": 3_600_000})
    cluster.edit(fast, target, "description", "OLD-from-fast-clock", ledger)
    cluster.wait_converged()
    cluster.edit(slow, target, "description", "NEWEST-written-after-seeing-it", ledger)
    ledger["checks"].append(("causal_latest", target, "description",
                             "NEWEST-written-after-seeing-it"))
    # This edit is causally later, not concurrent, so it is judged by the causal check only.
    ledger["intents"].pop((target, "description", slow), None)
    ledger["intents"].pop((target, "description", fast), None)
    time.sleep(SETTLE_S)
    return ledger, ids


SCENARIOS = {
    "partition_edit": scenario_partition_edit,
    "pairwise_partition": scenario_pairwise_partition,
    "flapping_link": scenario_flapping_link,
    "crash_recover": scenario_crash_recover,
    "clock_skew": scenario_clock_skew,
}


# ---- judging -----------------------------------------------------------------------------

def judge(cluster, ledger, convergence_s):
    reports, entries = cluster.final_state()
    candidates = {}
    for e in entries:
        for c in e["candidates"]:
            candidates.setdefault((e["report_id"], e["field"]), []).append(c["value"])

    lost = 0
    for (report_id, field, _node), intent in ledger["intents"].items():
        final = reports.get(report_id, {}).get(field)
        visible = (final == intent["value"]
                   or intent["value"] in candidates.get((report_id, field), [])
                   or intent["warned"])
        lost += 0 if visible else 1

    stale = 0
    for kind, report_id, field, expected in ledger["checks"]:
        if kind == "causal_latest" and reports.get(report_id, {}).get(field) != expected:
            stale += 1

    survivors = cluster.surviving_events()
    events_lost = len(ledger["acked"] - survivors)
    return {
        "converged": convergence_s is not None,
        "convergence_ms": None if convergence_s is None else round(convergence_s * 1000),
        "intents": len(ledger["intents"]),
        "silently_lost": lost,
        "acked_events": len(ledger["acked"]),
        "events_lost": events_lost,
        "stale_wins": stale,
        "ok": convergence_s is not None and lost == 0 and stale == 0,
    }


def run_trial(cluster, scenario, seed):
    rng = random.Random(seed)
    ledger, _ids = SCENARIOS[scenario](cluster, rng)
    cluster.heal()
    convergence = cluster.wait_converged()
    return judge(cluster, ledger, convergence)


# ---- aggregation and output --------------------------------------------------------------

def pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else 0.0


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def summarise(trials):
    ms = [t["convergence_ms"] for t in trials if t["convergence_ms"] is not None]
    intents = sum(t["intents"] for t in trials)
    acked = sum(t["acked_events"] for t in trials)
    return {
        "trials": len(trials),
        "converged_pct": pct(sum(t["converged"] for t in trials), len(trials)),
        "silent_overwrites_pct": pct(sum(t["silently_lost"] for t in trials), intents),
        "acked_writes_lost_pct": pct(sum(t["events_lost"] for t in trials), acked),
        "stale_wins": sum(t["stale_wins"] for t in trials),
        "trials_with_silent_loss": sum(1 for t in trials if t["silently_lost"] or t["stale_wins"]),
        "convergence_ms_p50": percentile(ms, 0.5),
        "convergence_ms_p95": percentile(ms, 0.95),
        "intents_checked": intents,
    }


def charts(results):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed: skipping charts (pip install matplotlib)")
        return
    ours, base = results["systems"]["ours"], results["systems"]["lww_baseline"]
    fig, ax = plt.subplots(figsize=(6, 4))
    bars = ax.bar(["Last-writer-wins\nbaseline", "Our engine"],
                  [base["silent_overwrites_pct"], ours["silent_overwrites_pct"]],
                  color=["#b91c1c", "#15803d"])
    ax.set_ylabel("Acknowledged edits silently lost (%)")
    ax.set_title("Silent overwrites under partitions, crashes and clock skew")
    for bar in bars:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(), f"{bar.get_height():.1f}%",
                ha="center", va="bottom", fontweight="bold")
    ax.set_ylim(0, max(10, base["silent_overwrites_pct"] * 1.25))
    fig.tight_layout()
    fig.savefig(RESULTS_DIR / "silent_overwrites.png", dpi=150)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 4))
    labels = ["p50", "p95"]
    ax.bar([0 - 0.2, 1 - 0.2], [base["convergence_ms_p50"] or 0, base["convergence_ms_p95"] or 0],
           0.4, label="Baseline", color="#b91c1c")
    ax.bar([0 + 0.2, 1 + 0.2], [ours["convergence_ms_p50"] or 0, ours["convergence_ms_p95"] or 0],
           0.4, label="Our engine", color="#15803d")
    ax.set_xticks([0, 1], labels)
    ax.set_ylabel("Time to converge after healing (ms)")
    ax.set_title("Convergence time (local cluster, 100 ms sync)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(RESULTS_DIR / "convergence_time.png", dpi=150)
    plt.close(fig)
    print(f"charts written to {RESULTS_DIR}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--trials", type=int, default=10, help="trials per scenario per cluster")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--scenarios", nargs="*", default=list(SCENARIOS))
    args = parser.parse_args()

    clusters = {"ours": Cluster("ours"), "lww": Cluster("lww")}
    for c in clusters.values():
        for n in NODES:
            try:
                if c.call(n, "GET", "/healthz")[0] != 200:
                    raise RuntimeError
            except Exception:
                sys.exit(f"{c.name}/{n} is not reachable. Start both clusters with:\n"
                         "  python infra/run_cluster.py --baseline --fast")

    per_system = {"ours": [], "lww": []}
    scenario_rows = []
    started = time.monotonic()
    for scenario in args.scenarios:
        row = {"name": scenario, "runs": args.trials, "ours_pass": 0, "lww_pass": 0}
        for i in range(args.trials):
            seed = args.seed * 100_000 + i
            for name, cluster in clusters.items():
                trial = run_trial(cluster, scenario, seed)   # same seed for both systems
                trial["scenario"] = scenario
                per_system[name].append(trial)
                row["ours_pass" if name == "ours" else "lww_pass"] += int(trial["ok"])
        scenario_rows.append(row)
        print(f"{scenario:20} ours {row['ours_pass']}/{args.trials}   "
              f"baseline {row['lww_pass']}/{args.trials}")

    results = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "runs": args.trials * len(args.scenarios),
        "seed": args.seed,
        "elapsed_s": round(time.monotonic() - started),
        "setup": "local 3-node clusters, 100 ms sync, one laptop",
        "systems": {"ours": summarise(per_system["ours"]),
                    "lww_baseline": summarise(per_system["lww"])},
        "scenarios": scenario_rows,
    }
    RESULTS_DIR.mkdir(exist_ok=True)
    (RESULTS_DIR / "results.json").write_text(json.dumps(results, indent=2))
    charts(results)

    o, b = results["systems"]["ours"], results["systems"]["lww_baseline"]
    print("\n" + "=" * 62)
    print(f"{'':28}{'Our engine':>16}{'LWW baseline':>16}")
    print(f"{'Replicas converged':28}{o['converged_pct']:>15}%{b['converged_pct']:>15}%")
    print(f"{'Edits silently lost':28}{o['silent_overwrites_pct']:>15}%"
          f"{b['silent_overwrites_pct']:>15}%")
    print(f"{'Acked events missing':28}{o['acked_writes_lost_pct']:>15}%"
          f"{b['acked_writes_lost_pct']:>15}%")
    print(f"{'Causally-later edit beaten':28}{o['stale_wins']:>16}{b['stale_wins']:>16}")
    print(f"{'Converge p50 / p95 (ms)':28}"
          f"{str(o['convergence_ms_p50']) + ' / ' + str(o['convergence_ms_p95']):>16}"
          f"{str(b['convergence_ms_p50']) + ' / ' + str(b['convergence_ms_p95']):>16}")
    print("=" * 62)
    print(f"written to {RESULTS_DIR / 'results.json'}")


if __name__ == "__main__":
    main()
