"""Start the three engine nodes on this machine (ports 8001-8003). Ctrl+C stops them.

    python infra/run_cluster.py            keep existing data
    python infra/run_cluster.py --fresh    start with empty databases
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODES = {"mum": 8001, "hyd": 8002, "sin": 8003}
HOST = "127.0.0.1"


def main() -> None:
    data = ROOT / "data"
    data.mkdir(exist_ok=True)
    if "--fresh" in sys.argv:
        for node in NODES:
            (data / f"{node}.db").unlink(missing_ok=True)

    procs = []
    for node, port in NODES.items():
        peers = ",".join(f"{p}=http://{HOST}:{pp}" for p, pp in NODES.items() if p != node)
        env = dict(os.environ, NODE_ID=node, PORT=str(port), PEERS=peers, MODE="crdt",
                   DB_PATH=str(data / f"{node}.db"))
        procs.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "engine.app.main:create_app", "--factory",
             "--host", HOST, "--port", str(port), "--log-level", "warning"],
            cwd=ROOT, env=env))
        print(f"{node}: http://{HOST}:{port}   (API docs at /docs)")

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
