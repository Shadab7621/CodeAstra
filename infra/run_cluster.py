"""Start engine nodes on this machine (ports 8001-8003). Ctrl+C stops them.

    python infra/run_cluster.py                      engine cluster, keep existing data
    python infra/run_cluster.py --fresh              start with empty databases
    python infra/run_cluster.py --baseline           also the last-writer-wins baseline (9001-9003)
    python infra/run_cluster.py --baseline --fast    sync every 100 ms (used by the benchmark)
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODES = {"mum": 1, "hyd": 2, "sin": 3}   # node id -> port suffix
HOST = "127.0.0.1"


def launch(procs, kind, node, port, peers, env_extra):
    env = dict(os.environ, NODE_ID=node, PORT=str(port), PEERS=peers, MODE=kind,
               DB_PATH=str(ROOT / "data" / f"{node}.db"), **env_extra)
    target = ("engine.app.main:create_app" if kind == "crdt" else "baseline_lww.app:create_app")
    procs.append(subprocess.Popen(
        [sys.executable, "-m", "uvicorn", target, "--factory", "--host", HOST,
         "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=env))
    print(f"{kind:4} {node}: http://{HOST}:{port}   (API docs at /docs)")


def main() -> None:
    data = ROOT / "data"
    data.mkdir(exist_ok=True)
    if "--fresh" in sys.argv:
        for node in NODES:
            (data / f"{node}.db").unlink(missing_ok=True)
    extra = {"SYNC_INTERVAL_MS": "100"} if "--fast" in sys.argv else {}

    procs = []
    for base, kind in ((8000, "crdt"), (9000, "lww")):
        if kind == "lww" and "--baseline" not in sys.argv:
            continue
        for node, n in NODES.items():
            peers = ",".join(f"{p}=http://{HOST}:{base + pn}" for p, pn in NODES.items()
                             if p != node)
            launch(procs, kind, node, base + n, peers, extra)

    print("Cluster running. Press Ctrl+C to stop.")
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.terminate()


if __name__ == "__main__":
    main()
