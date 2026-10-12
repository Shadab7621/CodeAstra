"""Show that rewriting history behind the application's back is detected.

Needs the Docker cluster running (docker compose up -d --build). It changes one stored event
inside the Hyderabad container's database, asks the node to verify its log, then restores the
original content and verifies again.

    python infra/tamper_demo.py
"""
import json
import subprocess
import sys
import urllib.request

NODE_URL = "http://127.0.0.1:8002"
CONTAINER = "codeastra-hyd"
DB = "/data/hyd.db"


def get(path):
    with urllib.request.urlopen(NODE_URL + path, timeout=5) as r:
        return json.loads(r.read())


def post(path, body):
    req = urllib.request.Request(NODE_URL + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def sql(statement, params):
    code = ("import sqlite3,sys,json; c=sqlite3.connect(%r); "
            "c.execute(sys.argv[1], json.loads(sys.argv[2])); c.commit()" % DB)
    r = subprocess.run(["docker", "exec", CONTAINER, "python", "-c", code,
                        statement, json.dumps(params)], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(r.stderr.strip() or "docker exec failed (is the cluster running?)")


def show(label):
    v = get("/audit/verify")
    origin = v["origins"].get("hyd", {})
    print(f"{label}: ok={v['ok']}  events={v['events_checked']}"
          + (f"  first bad event: seq {origin.get('first_bad_seq')} ({origin.get('problem')})"
             if not v["ok"] else ""))
    return v


def main():
    body = {"incident_type": "fire", "severity": 4, "location": {"lat": 19.1, "lon": 72.9},
            "description": "Warehouse fire, 3 injured", "reporter": "tamper-demo"}
    created = post("/reports", body)  # an event authored by Hyderabad
    print("1. Created a report on Hyderabad:", created["report_id"])
    show("2. Log verification before tampering")

    events = [e for e in get("/events")["events"] if e["event_id"] == created["event_id"]]
    original = json.dumps(events[0]["fields"], sort_keys=True)
    forged = dict(events[0]["fields"], description="Minor smoke, no injuries")
    print("3. Editing the stored event directly in the database (bypassing the application)...")
    sql("UPDATE events SET fields = ? WHERE event_id = ?",
        [json.dumps(forged, sort_keys=True), created["event_id"]])
    bad = show("4. Log verification after tampering ")

    print("5. Restoring the original content...")
    sql("UPDATE events SET fields = ? WHERE event_id = ?", [original, created["event_id"]])
    good = show("6. Log verification after restoring")
    if bad["ok"] or not good["ok"]:
        sys.exit("Unexpected result: tampering was not detected, or restore failed.")
    print("\nTampering was detected, and the log is intact again.")


if __name__ == "__main__":
    main()
