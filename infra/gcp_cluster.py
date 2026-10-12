"""Deploy engine nodes to Google Cloud (Compute Engine), so the cluster spans two providers.

    python infra/gcp_cluster.py ip sin                     reserve the node's address, print it
    python infra/gcp_cluster.py up sin --peer mum=http://13.200.213.148:8001 --peer hyd=...
    python infra/gcp_cluster.py status
    python infra/gcp_cluster.py down

Typical mixed-cloud layout: mum and hyd on AWS, sin on Google Cloud. A node is the same Docker
image wherever it runs; peers find each other by public address, so nothing here is specific
to one provider. The admin token is shared with the AWS side (infra/.admin_token).

Needs the Google Cloud CLI, logged in, with a project that has billing and the Compute Engine
API enabled:  gcloud auth login ; gcloud config set project <id>
NOTE: written to mirror the AWS script but not yet run against a real project.
"""
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aws_cluster import REPO, admin_token  # reuse the shared token and repo URL

NODES = {  # node id -> (region, zone, port)
    "mum": ("asia-south1", "asia-south1-a", 8001),       # Mumbai
    "hyd": ("asia-south2", "asia-south2-a", 8002),       # Delhi (GCP has no Hyderabad region)
    "sin": ("asia-southeast1", "asia-southeast1-a", 8003),  # Singapore
}
MACHINE_TYPE = "e2-micro"
FIREWALL = "codeastra-node"
LABEL = "project=codeastra"


def gcloud(*args, check=True):
    result = subprocess.run(["gcloud", *args, "--quiet"], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"gcloud {' '.join(args[:3])} failed:\n{result.stderr.strip()}")
    return result


def startup_script(node, port, peers, token):
    return f"""#!/bin/bash
set -x
apt-get update
apt-get install -y docker.io git
systemctl enable --now docker
git clone --depth 1 {REPO} /opt/app
cd /opt/app
docker build -f engine/Dockerfile -t codeastra-engine .
set +x   # do not echo the next command: it contains the admin token
docker run -d --name node --restart unless-stopped -p {port}:{port} -v codeastra-data:/data \\
  -e NODE_ID={node} -e PORT={port} -e PEERS="{peers}" -e MODE=crdt -e DB_PATH=/data/{node}.db \\
  -e ADMIN_TOKEN="{token}" codeastra-engine
set -x
"""


def address(node):
    region = NODES[node][0]
    name = f"codeastra-{node}"
    described = gcloud("compute", "addresses", "describe", name, f"--region={region}",
                       "--format=value(address)", check=False)
    if described.returncode != 0:
        gcloud("compute", "addresses", "create", name, f"--region={region}")
        described = gcloud("compute", "addresses", "describe", name, f"--region={region}",
                           "--format=value(address)")
    return described.stdout.strip()


def up(node, peers):
    region, zone, port = NODES[node]
    ip = address(node)
    print(f"{node}: address {ip} ({region})")

    exists = gcloud("compute", "firewall-rules", "describe", FIREWALL, check=False)
    if exists.returncode != 0:
        ports = ",".join(f"tcp:{p}" for _, _, p in NODES.values())
        gcloud("compute", "firewall-rules", "create", FIREWALL, f"--allow={ports}",
               "--target-tags=codeastra", "--source-ranges=0.0.0.0/0")
        print("firewall rule created (the admin token is the protection)")

    name = f"codeastra-{node}"
    if gcloud("compute", "instances", "describe", name, f"--zone={zone}", check=False
              ).returncode == 0:
        print(f"{node}: already exists; run `down` first to change its configuration")
        return
    script = startup_script(node, port, ",".join(f"{k}={v}" for k, v in sorted(peers.items())),
                            admin_token())
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(script)
    gcloud("compute", "instances", "create", name, f"--zone={zone}",
           f"--machine-type={MACHINE_TYPE}", "--image-family=debian-12",
           "--image-project=debian-cloud", "--tags=codeastra", f"--labels={LABEL}",
           f"--address={ip}", f"--metadata-from-file=startup-script={f.name}")
    print(f"{node}: created; it needs a few minutes to build and start -> http://{ip}:{port}")


def status():
    found = False
    for node, (region, zone, port) in NODES.items():
        r = gcloud("compute", "instances", "describe", f"codeastra-{node}", f"--zone={zone}",
                   "--format=json", check=False)
        if r.returncode != 0:
            continue
        found = True
        info = json.loads(r.stdout)
        ip = info["networkInterfaces"][0]["accessConfigs"][0].get("natIP", "?")
        try:
            with urllib.request.urlopen(f"http://{ip}:{port}/healthz", timeout=4) as resp:
                healthy = json.loads(resp.read()).get("ok") is True
        except Exception:
            healthy = False
        print(f"{node:4} {zone:18} {info['status']:10} http://{ip}:{port}  healthy={healthy}")
    if not found:
        print("Nothing deployed on Google Cloud.")


def down():
    for node, (region, zone, _) in NODES.items():
        name = f"codeastra-{node}"
        if gcloud("compute", "instances", "delete", name, f"--zone={zone}", check=False
                  ).returncode == 0:
            print(f"deleted instance {name}")
        if gcloud("compute", "addresses", "delete", name, f"--region={region}", check=False
                  ).returncode == 0:
            print(f"released address {name}")
    if gcloud("compute", "firewall-rules", "delete", FIREWALL, check=False).returncode == 0:
        print("deleted firewall rule")
    print("Teardown finished.")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "ip" and len(args) == 1 and args[0] in NODES:
        print(address(args[0]))
    elif cmd == "up" and args and args[0] in NODES:
        peers, it = {}, iter(args[1:])
        for a in it:
            if a != "--peer":
                sys.exit("Usage: up <node> [--peer id=url ...]")
            node_id, _, url = next(it, "").partition("=")
            if node_id not in NODES or not url.startswith("http"):
                sys.exit("Usage: --peer <mum|hyd|sin>=http://<ip>:<port>")
            peers[node_id] = url.rstrip("/")
        up(args[0], peers)
    elif cmd == "status":
        status()
    elif cmd == "down":
        down()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
