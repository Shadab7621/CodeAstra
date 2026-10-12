"""End-to-end check against a RUNNING local cluster (start it with infra/run_cluster.py).

Walks the demo story over real HTTP: replicate, cut the link, edit both sides, heal, converge.
    python infra/smoke_test.py
"""
import os
import sys
import time

import httpx

# Defaults to a local cluster. For a remote one set, for example:
#   CLUSTER_URLS="mum=http://1.2.3.4:8001,hyd=http://5.6.7.8:8002,sin=http://9.9.9.9:8003"
#   ADMIN_TOKEN=<value from: python infra/aws_cluster.py token>
URL = {"mum": "http://127.0.0.1:8001", "hyd": "http://127.0.0.1:8002",
       "sin": "http://127.0.0.1:8003"}
if os.getenv("CLUSTER_URLS"):
    URL = dict(item.split("=", 1) for item in os.environ["CLUSTER_URLS"].split(","))
REPORT = {"incident_type": "flood", "severity": 3, "location": {"lat": 19.076, "lon": 72.877},
          "description": "Water rising", "reporter": "smoke-test"}
HEADERS = {"X-Admin-Token": os.environ["ADMIN_TOKEN"]} if os.getenv("ADMIN_TOKEN") else {}
http = httpx.Client(timeout=5.0, headers=HEADERS)
failures = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(label)


def hashes() -> dict:
    return {n: http.get(f"{u}/state-hash").json()["hash"] for n, u in URL.items()}


def wait_until(condition, timeout_s: float = 10.0) -> float:
    """Returns seconds taken, or -1 if the condition never held."""
    start = time.monotonic()
    while time.monotonic() - start < timeout_s:
        if condition():
            return time.monotonic() - start
        time.sleep(0.1)
    return -1


def partition(a: str, b: str, cut: bool) -> None:
    action = "block" if cut else "unblock"
    http.post(f"{URL[a]}/admin/{action}", json={"peer": b})
    http.post(f"{URL[b]}/admin/{action}", json={"peer": a})


def main() -> int:
    for n, u in URL.items():
        http.post(f"{u}/admin/resume")
    for n, u in URL.items():
        http.post(f"{u}/admin/reset")

    print("1. Replication")
    rid = http.post(f"{URL['mum']}/reports", json=REPORT).json()["report_id"]
    took = wait_until(lambda: http.get(f"{URL['hyd']}/reports/{rid}").status_code == 200)
    check("report created in Mumbai appears in Hyderabad", took >= 0, f"{took:.2f}s")
    took = wait_until(
        lambda: http.get(f"{URL['mum']}/reports/{rid}").json()["durability"] == "confirmed")
    check("durability reaches 'confirmed'", took >= 0, f"{took:.2f}s")

    print("2. Partition: Mumbai cut off from Hyderabad and Singapore")
    partition("mum", "hyd", True)
    partition("mum", "sin", True)
    time.sleep(0.7)
    a = http.patch(f"{URL['mum']}/reports/{rid}", json={"description": "road flooded"}).json()
    b = http.patch(f"{URL['hyd']}/reports/{rid}", json={"description": "water knee high"}).json()
    time.sleep(1.5)
    h = hashes()
    check("both sides accepted writes while cut off", "event_id" in a and "event_id" in b)
    check("the two sides disagree during the partition", h["mum"] != h["hyd"])
    peer = next(p for p in http.get(f"{URL['mum']}/status").json()["peers"] if p["id"] == "hyd")
    check("Mumbai reports Hyderabad as unreachable", peer["reachable"] is False, peer["reason"])
    check("Mumbai's edit is marked 'local' (at risk)",
          http.get(f"{URL['mum']}/reports/{rid}").json()["durability"] == "local")

    print("3. Heal")
    partition("mum", "hyd", False)
    partition("mum", "sin", False)
    took = wait_until(lambda: len(set(hashes().values())) == 1)
    check("all three nodes converge after healing", took >= 0, f"{took:.2f}s")
    for n, u in URL.items():
        ids = http.get(f"{u}/events", params={"ids_only": "true"}).json()["event_ids"]
        check(f"{n} holds both acknowledged edits", {a["event_id"], b["event_id"]} <= set(ids))
    conflicts = http.get(f"{URL['sin']}/conflicts").json()["conflicts"]
    kept = {c["value"] for e in conflicts for c in e["candidates"]}
    check("conflict ledger kept both versions",
          kept == {"road flooded", "water knee high"}, f"status={conflicts[0]['status']}")

    print("4. Crash and recovery")
    http.post(f"{URL['sin']}/admin/pause")
    rid2 = http.post(f"{URL['mum']}/reports", json=REPORT).json()["report_id"]
    time.sleep(1.2)
    http.post(f"{URL['sin']}/admin/resume")
    took = wait_until(lambda: http.get(f"{URL['sin']}/reports/{rid2}").status_code == 200)
    check("Singapore catches up after resuming", took >= 0, f"{took:.2f}s")

    print("\nRESULT:", "ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
