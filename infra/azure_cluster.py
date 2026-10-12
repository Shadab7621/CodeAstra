"""Deploy an engine node to Microsoft Azure, so the cluster spans more than one provider.

    python infra/azure_cluster.py up sin --public --peer mum=http://13.200.213.148:8001 --peer hyd=...
    python infra/azure_cluster.py status
    python infra/azure_cluster.py logs sin
    python infra/azure_cluster.py update sin          pull new code and restart, same address and data
    python infra/azure_cluster.py down

Typical mixed-cloud layout: mum and hyd on AWS, sin on Azure (Southeast Asia, i.e. Singapore).
It is the same Docker image wherever it runs, and the admin token is shared with the AWS side
(infra/.admin_token).

Needs the Azure CLI logged in (az login) and the Microsoft.Compute and Microsoft.Network
providers registered. Each node lives in its own resource group tagged project=codeastra, so
`down` removes everything it created by deleting that group.

Student subscriptions allow only a few regions; the defaults below are ones that were allowed.
No SSH port is opened. The node port is open to everyone and protected by the admin token.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aws_cluster import REPO, admin_token, mongo_uri  # shared token, repo URL, Atlas URI

NODES = {  # node id -> (azure region, port). Only sin is a true Singapore location.
    "sin": ("southeastasia", 8003),
    "mum": ("uaenorth", 8001),        # nearest allowed region to Mumbai on a student plan
    "hyd": ("koreacentral", 8002),
}
# Tried in order until one is available to the subscription in that region. A student
# subscription in southeastasia was found to allow only ARM sizes (the "p" ones), so those
# come first; the engine image is multi-architecture and runs on both.
FALLBACK_SIZES = ["Standard_B2pts_v2", "Standard_B2pls_v2", "Standard_B2ps_v2",
                  "Standard_B1s", "Standard_B2s", "Standard_B1ms", "Standard_B2ats_v2",
                  "Standard_D2s_v3", "Standard_D2as_v5"]
IMAGE_X86 = "Canonical:ubuntu-24_04-lts:server:latest"
IMAGE_ARM = "Canonical:ubuntu-24_04-lts:server-arm64:latest"


def image_for(size: str) -> str:
    """ARM sizes (Standard_B2pts_v2, D2ps_v5, ...) need the arm64 image."""
    return IMAGE_ARM if re.match(r"Standard_[A-Za-z]+\d+p", size) else IMAGE_X86
AZ = shutil.which("az") or r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"


def az(*args, check=True, as_json=False):
    result = subprocess.run([AZ, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"az {' '.join(args[:3])} failed:\n{(result.stderr or result.stdout).strip()}")
    if as_json:
        return json.loads(result.stdout) if result.stdout.strip() else None
    return result


def group(node):
    return f"codeastra-{node}"


def startup_script(node, port, peers, token, mongo=""):
    mongo_flag = f'\\\n  -e MONGODB_URI="{mongo}" ' if mongo else " "
    return f"""#!/bin/bash
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io git
systemctl enable --now docker
git clone --depth 1 {REPO} /opt/app
cd /opt/app
docker build -f engine/Dockerfile -t codeastra-engine .
set +x   # do not echo the next command: it contains the admin token
docker run -d --name node --restart unless-stopped -p {port}:{port} -v codeastra-data:/data \\
  -e NODE_ID={node} -e PORT={port} -e PEERS="{peers}" -e MODE=crdt -e DB_PATH=/data/{node}.db \\
  -e ADMIN_TOKEN="{token}" {mongo_flag}codeastra-engine
set -x
sleep 15
echo "DIAG docker ps:"; docker ps -a
ss -ltn | grep ":{port} " && echo "DIAG listening on {port}" || echo "DIAG NOT LISTENING on {port}"
curl -s -m 5 http://127.0.0.1:{port}/healthz && echo "DIAG local healthcheck ok" || echo "DIAG local healthcheck FAILED"
"""


def up(node, peers, size):
    region, port = NODES[node]
    rg = group(node)
    az("group", "create", "--name", rg, "--location", region, "--tags", "project=codeastra")

    vm = f"codeastra-{node}"
    if az("vm", "show", "-g", rg, "-n", vm, check=False).returncode == 0:
        print(f"{node}: already exists; run `down` first to change its configuration")
        return

    ip = az("network", "public-ip", "create", "-g", rg, "-n", f"{vm}-ip", "--location", region,
            "--sku", "Standard", "--allocation-method", "Static", "--tags", "project=codeastra",
            "--query", "publicIp.ipAddress", "--output", "tsv").stdout.strip()
    print(f"{node}: address {ip} ({region})")

    script = startup_script(node, port, ",".join(f"{k}={v}" for k, v in sorted(peers.items())),
                            admin_token(), mongo_uri())
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(script)
    chosen = None
    for candidate in ([size] if size else FALLBACK_SIZES):
        print(f"{node}: trying size {candidate} ...")
        result = az("vm", "create", "-g", rg, "-n", vm, "--location", region,
                    "--image", image_for(candidate),
                    "--size", candidate, "--public-ip-address", f"{vm}-ip",
                    "--admin-username", "azureuser", "--generate-ssh-keys",
                    "--nsg-rule", "NONE", "--custom-data", f.name,
                    "--tags", "project=codeastra", "--output", "none", check=False)
        if result.returncode == 0:
            chosen = candidate
            break
        message = (result.stderr or result.stdout).lower()
        if not any(w in message for w in ("skunotavailable", "not available", "quota",
                                          "capacity", "not allowed", "restricted")):
            sys.exit(f"az vm create failed:\n{(result.stderr or result.stdout).strip()}")
        az("vm", "delete", "-g", rg, "-n", vm, "--yes", check=False)   # clear a partial attempt
    if not chosen:
        sys.exit("No VM size was available in this region for this subscription.")
    az("vm", "open-port", "-g", rg, "-n", vm, "--port", str(port), "--priority", "900",
       "--output", "none")
    print(f"{node}: created ({chosen}); it needs a few minutes to build and start "
          f"-> http://{ip}:{port}")


def status():
    found = False
    for node, (region, port) in NODES.items():
        info = az("vm", "show", "-d", "-g", group(node), "-n", f"codeastra-{node}",
                  "--query", "{state:powerState, ip:publicIps, size:hardwareProfile.vmSize}",
                  "--output", "json", check=False)
        if info.returncode != 0:
            continue
        found = True
        data = json.loads(info.stdout)
        try:
            with urllib.request.urlopen(f"http://{data['ip']}:{port}/healthz", timeout=4) as r:
                healthy = json.loads(r.read()).get("ok") is True
        except Exception:
            healthy = False
        print(f"{node:4} {region:15} {data['state']:14} http://{data['ip']}:{port}  "
              f"{data['size']}  healthy={healthy}")
    if not found:
        print("Nothing deployed on Azure.")


def logs(node):
    out = az("vm", "boot-diagnostics", "get-boot-log", "-g", group(node), "-n",
             f"codeastra-{node}", check=False).stdout
    lines = [l.encode("ascii", "replace").decode() for l in out.replace("\r", "").split("\n")]
    print("\n".join([l for l in lines if "DIAG" in l or "cloud-init" in l][-40:])
          or "(no boot log yet)")


# Rebuilds the container from the latest code, keeping the node's settings, address and data.
UPDATE_SCRIPT = r"""set -e
cd /opt/app
git pull -q
docker build -q -f engine/Dockerfile -t codeastra-engine .
ENVFILE=$(mktemp)
docker inspect node --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(NODE_ID|PORT|PEERS|MODE|DB_PATH|ADMIN_TOKEN)=' > "$ENVFILE"
MONGO='__MONGODB_URI__'
if [ -n "$MONGO" ]; then echo "MONGODB_URI=$MONGO" >> "$ENVFILE"; fi
PORT=$(grep '^PORT=' "$ENVFILE" | cut -d= -f2)
docker rm -f node
docker run -d --name node --restart unless-stopped -p "$PORT:$PORT" -v codeastra-data:/data \
  --env-file "$ENVFILE" codeastra-engine
rm -f "$ENVFILE"
sleep 8
curl -s -m 5 "http://127.0.0.1:$PORT/healthz" && echo " node is healthy" || echo " node did not answer"
"""


def update(node):
    """Pull the newest code onto the existing server and restart the node. No port is touched."""
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, newline="\n") as f:
        f.write(UPDATE_SCRIPT.replace("__MONGODB_URI__", mongo_uri()))
    print(f"{node}: updating in place (takes a minute or two) ...")
    try:
        result = az("vm", "run-command", "invoke", "-g", group(node), "-n", f"codeastra-{node}",
                    "--command-id", "RunShellScript", "--scripts", f"@{f.name}",
                    "--query", "value[0].message", "--output", "tsv")
    finally:
        os.unlink(f.name)  # it holds the Atlas password
    tail = [l for l in result.stdout.replace("\r", "").split("\n") if l.strip()][-6:]
    print("\n".join(l.encode("ascii", "replace").decode() for l in tail))


def down():
    for node in NODES:
        rg = group(node)
        if az("group", "exists", "--name", rg, check=False).stdout.strip() == "true":
            az("group", "delete", "--name", rg, "--yes", "--no-wait", check=False)
            print(f"deleting resource group {rg} (finishes in the background)")
    print("Teardown requested.")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "up" and args and args[0] in NODES:
        peers, size, it = {}, None, iter(args[1:])
        for a in it:
            if a == "--public":
                continue                       # always public; kept for symmetry with AWS
            if a == "--size":
                size = next(it, None)
            elif a == "--peer":
                node_id, _, url = next(it, "").partition("=")
                if node_id not in ("mum", "hyd", "sin") or not url.startswith("http"):
                    sys.exit("Usage: --peer <mum|hyd|sin>=http://<ip>:<port>")
                peers[node_id] = url.rstrip("/")
            else:
                sys.exit("Usage: up <node> [--public] [--size SKU] [--peer id=url ...]")
        up(args[0], peers, size)
    elif cmd == "status":
        status()
    elif cmd == "logs" and len(args) == 1 and args[0] in NODES:
        logs(args[0])
    elif cmd == "update" and len(args) == 1 and args[0] in NODES:
        update(args[0])
    elif cmd == "down":
        down()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
