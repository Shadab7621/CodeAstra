"""Deploy engine nodes to AWS EC2, one small instance per region.

    python infra/aws_cluster.py up sin            deploy one node (port open to your IP only)
    python infra/aws_cluster.py up --public sin   same, port open to everyone (see below)
    python infra/aws_cluster.py up mum hyd sin    deploy the full cluster
    python infra/aws_cluster.py status            show instances, addresses and health
    python infra/aws_cluster.py check             create a report, and verify the token works
    python infra/aws_cluster.py logs <node>       boot log of a node (setup progress, self-check)
    python infra/aws_cluster.py token             print the admin token for the dashboard
    python infra/aws_cluster.py down              remove everything tagged project=codeastra

Safe by design:
- Uses the AWS CLI profile "codeastra" (never keys in code).
- Every node requires the secret in infra/.admin_token (header X-Admin-Token) for /admin/*,
  /sync and conflict resolution. Reading and creating reports stays open.
- Without --public, a node's port is open ONLY to your current public IP and the other nodes.
  Behind carrier NAT your IP can differ per connection, so --public exists: it opens the port
  to everyone and relies on the token. The token travels over plain HTTP (prototype limitation).
- No SSH. Every resource is tagged project=codeastra, so `down` finds and removes all of it.
- Elastic IPs give each node a stable address; `down` releases them.
Re-running `up` with a different set of nodes replaces instances whose config changed.
"""
import hashlib
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

PROFILE = "codeastra"
REPO = "https://github.com/Shadab7621/CodeAstra.git"
INSTANCE_TYPE = "t3.micro"
SG_NAME = "codeastra-node"
NODES = {  # node id -> (region, port)
    "mum": ("ap-south-1", 8001),
    "hyd": ("ap-south-2", 8002),
    "sin": ("ap-southeast-1", 8003),
}
USER_DATA_VERSION = "4"  # bump when user_data() changes so `up` replaces old instances
TAGS = [{"Key": "project", "Value": "codeastra"}]
TOKEN_FILE = Path(__file__).resolve().parent / ".admin_token"   # git-ignored
session = boto3.Session(profile_name=PROFILE)


def admin_token() -> str:
    """The shared secret for /admin/*, /sync and conflict resolution. Created once, reused."""
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    token = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(token)
    return token


def ec2(region):
    return session.client("ec2", region_name=region)


def tag_spec(resource_type, node):
    return {"ResourceType": resource_type, "Tags": TAGS + [
        {"Key": "node", "Value": node}, {"Key": "Name", "Value": f"codeastra-{node}"}]}


def my_ip() -> str:
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10) as r:
        return r.read().decode().strip()


def tagged_filters(node=None):
    f = [{"Name": "tag:project", "Values": ["codeastra"]}]
    if node:
        f.append({"Name": "tag:node", "Values": [node]})
    return f


def find_eip(client, node):
    found = client.describe_addresses(Filters=tagged_filters(node))["Addresses"]
    return found[0] if found else None


def find_instance(client, node):
    reservations = client.describe_instances(Filters=tagged_filters(node) + [
        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}
    ])["Reservations"]
    instances = [i for r in reservations for i in r["Instances"]]
    return instances[0] if instances else None


def tag_value(instance, key):
    return next((t["Value"] for t in instance.get("Tags", []) if t["Key"] == key), None)


def ensure_security_group(client):
    vpcs = client.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        sys.exit("No default VPC in this region; create one or extend this script.")
    vpc_id = vpcs[0]["VpcId"]
    groups = client.describe_security_groups(Filters=[
        {"Name": "group-name", "Values": [SG_NAME]}, {"Name": "vpc-id", "Values": [vpc_id]}
    ])["SecurityGroups"]
    if groups:
        return groups[0]["GroupId"]
    return client.create_security_group(
        GroupName=SG_NAME, Description="CodeAstra engine node", VpcId=vpc_id,
        TagSpecifications=[{"ResourceType": "security-group", "Tags": TAGS}])["GroupId"]


def allow(client, sg_id, port, cidr):
    try:
        client.authorize_security_group_ingress(GroupId=sg_id, IpPermissions=[{
            "IpProtocol": "tcp", "FromPort": port, "ToPort": port,
            "IpRanges": [{"CidrIp": cidr, "Description": "codeastra"}]}])
    except ClientError as e:
        if e.response["Error"]["Code"] != "InvalidPermission.Duplicate":
            raise


def user_data(node, port, peers, token):
    return f"""#!/bin/bash
set -x
dnf install -y docker git
systemctl enable --now docker
git clone --depth 1 {REPO} /opt/app
cd /opt/app
docker build -f engine/Dockerfile -t codeastra-engine .
set +x   # do not echo the next command: it contains the admin token
docker run -d --name node --restart unless-stopped -p {port}:{port} -v codeastra-data:/data \\
  -e NODE_ID={node} -e PORT={port} -e PEERS="{peers}" -e MODE=crdt -e DB_PATH=/data/{node}.db \\
  -e ADMIN_TOKEN="{token}" codeastra-engine
set -x

# Self-check, printed to the boot log (read it with: aws_cluster.py logs <node>).
sleep 15
echo "DIAG docker ps:"; docker ps -a
echo "DIAG container log:"; docker logs node 2>&1 | tail -20
ss -ltn | grep ":{port} " && echo "DIAG listening on {port}" || echo "DIAG NOT LISTENING on {port}"
curl -s -m 5 http://127.0.0.1:{port}/healthz && echo "DIAG local healthcheck ok" || echo "DIAG local healthcheck FAILED"
"""


def up(nodes, public=False, extra_peers=None):
    """extra_peers: {node id: url} for nodes that run elsewhere, e.g. on Google Cloud."""
    extra_peers = extra_peers or {}
    token = admin_token()
    if public:
        print("PUBLIC mode: node ports are open to everyone; the admin token is the protection.")
    else:
        ip = my_ip()
        print(f"Your public IP (the only outside address allowed in): {ip}")

    eips = {}
    for n in nodes:
        region, _ = NODES[n]
        client = ec2(region)
        eips[n] = find_eip(client, n) or client.allocate_address(
            Domain="vpc", TagSpecifications=[tag_spec("elastic-ip", n)])
        print(f"{n}: address {eips[n]['PublicIp']} ({region})")

    for n in nodes:
        region, port = NODES[n]
        client = ec2(region)
        peer_list = [f"{p}=http://{eips[p]['PublicIp']}:{NODES[p][1]}" for p in nodes if p != n]
        peer_list += [f"{k}={v}" for k, v in sorted(extra_peers.items())]
        peers = ",".join(peer_list)
        token_tag = hashlib.sha1(token.encode()).hexdigest()[:6]
        config_hash = hashlib.sha1(
            f"{USER_DATA_VERSION}|{peers}|{token_tag}".encode()).hexdigest()[:10]

        sg_id = ensure_security_group(client)
        allow(client, sg_id, port, "0.0.0.0/0" if public else f"{ip}/32")
        for p in nodes:
            if p != n:
                allow(client, sg_id, port, f"{eips[p]['PublicIp']}/32")
        for url in extra_peers.values():
            allow(client, sg_id, port, url.split("//")[1].split(":")[0] + "/32")

        instance = find_instance(client, n)
        if instance and tag_value(instance, "peers-hash") != config_hash:
            print(f"{n}: configuration changed, replacing the instance")
            client.terminate_instances(InstanceIds=[instance["InstanceId"]])
            client.get_waiter("instance_terminated").wait(InstanceIds=[instance["InstanceId"]])
            instance = None
        if instance:
            print(f"{n}: already running ({instance['InstanceId']})")
            continue

        ami = session.client("ssm", region_name=region).get_parameter(
            Name="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
        )["Parameter"]["Value"]
        spec = tag_spec("instance", n)
        spec["Tags"].append({"Key": "peers-hash", "Value": config_hash})
        created = client.run_instances(
            ImageId=ami, InstanceType=INSTANCE_TYPE, MinCount=1, MaxCount=1,
            SecurityGroupIds=[sg_id], UserData=user_data(n, port, peers, token),
            MetadataOptions={"HttpTokens": "required"},
            TagSpecifications=[spec, tag_spec("volume", n)])
        instance_id = created["Instances"][0]["InstanceId"]
        client.get_waiter("instance_running").wait(InstanceIds=[instance_id])
        client.associate_address(InstanceId=instance_id, AllocationId=eips[n]["AllocationId"])
        print(f"{n}: launched {instance_id}; it needs a few minutes to build and start")

    print("\nNext: python infra/aws_cluster.py status")


def health(url):
    try:
        with urllib.request.urlopen(url + "/healthz", timeout=4) as r:
            return json.loads(r.read()).get("ok") is True
    except Exception:
        return False


def deployed():
    rows = []
    for n, (region, port) in NODES.items():
        try:
            client = ec2(region)
            eip, instance = find_eip(client, n), find_instance(client, n)
        except ClientError as e:
            print(f"{n}: region {region} not usable yet ({e.response['Error']['Code']})")
            continue
        if eip or instance:
            rows.append((n, region, port, eip, instance))
    return rows


def status():
    rows = deployed()
    if not rows:
        print("Nothing deployed.")
    for n, region, port, eip, instance in rows:
        state = instance["State"]["Name"] if instance else "no instance"
        url = f"http://{eip['PublicIp']}:{port}" if eip else None
        up_ok = health(url) if url and instance else False
        print(f"{n:4} {region:15} {state:10} {url or '-':32} healthy={up_ok}")


def call(url, method="GET", body=None, token=None):
    """Returns (http status, parsed json or None)."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Admin-Token"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def check():
    rows = [r for r in deployed() if r[3] and r[4]]
    if not rows:
        sys.exit("No running nodes. Run `up` first.")
    token = admin_token()
    first = rows[0]
    url = f"http://{first[3]['PublicIp']}:{first[2]}"

    code, created = call(url + "/reports", "POST", {
        "incident_type": "flood", "severity": 3, "location": {"lat": 1.35, "lon": 103.8},
        "description": "cloud check", "reporter": "aws-check"})
    rid = created["report_id"]
    print(f"[{'PASS' if code == 201 else 'FAIL'}] create report on {first[0]} without a token ({code})")

    code, _ = call(url + "/admin/sync-now", "POST")
    print(f"[{'PASS' if code == 401 else 'FAIL'}] admin endpoint refuses a missing token ({code})")
    code, _ = call(url + "/admin/sync-now", "POST", token="wrong-token")
    print(f"[{'PASS' if code == 401 else 'FAIL'}] admin endpoint refuses a wrong token ({code})")
    code, _ = call(url + "/admin/sync-now", "POST", token=token)
    print(f"[{'PASS' if code == 200 else 'FAIL'}] admin endpoint accepts the real token ({code})")

    time.sleep(2)
    for n, _, port, eip, _ in rows:
        base = f"http://{eip['PublicIp']}:{port}"
        code, r = call(f"{base}/reports/{rid}")
        _, s = call(f"{base}/status")
        if code == 200 and s:
            peers = {p["id"]: p["reachable"] for p in s["peers"]}
            print(f"{n}: has the report ({r['durability']}); peers reachable: {peers}")
        else:
            print(f"{n}: report not visible yet (HTTP {code})")


def logs(node):
    """Print the boot log lines that matter (setup script progress and the DIAG self-check)."""
    region, _ = NODES[node]
    client = ec2(region)
    instance = find_instance(client, node)
    if not instance:
        sys.exit(f"{node}: no instance")
    out = client.get_console_output(InstanceId=instance["InstanceId"], Latest=True).get("Output")
    lines = [l.encode("ascii", "replace").decode() for l in (out or "").replace("\r", "").split("\n")]
    keep = [re.sub(r"ADMIN_TOKEN=\S+", "ADMIN_TOKEN=***", l)   # never print the secret
            for l in lines if "cloud-init[" in l and " #" not in l]  # skip docker build noise
    print("\n".join(keep[-60:]) or "(no output yet, the server is still booting)")


def down():
    for n, (region, _) in NODES.items():
        try:
            client = ec2(region)
            instances = [i for r in client.describe_instances(Filters=tagged_filters() + [
                {"Name": "instance-state-name", "Values": ["pending", "running", "stopping",
                                                             "stopped"]}])["Reservations"]
                         for i in r["Instances"]]
            ids = [i["InstanceId"] for i in instances]
            if ids:
                client.terminate_instances(InstanceIds=ids)
                client.get_waiter("instance_terminated").wait(InstanceIds=ids)
                print(f"{region}: terminated {len(ids)} instance(s)")
            for a in client.describe_addresses(Filters=tagged_filters())["Addresses"]:
                client.release_address(AllocationId=a["AllocationId"])
                print(f"{region}: released {a['PublicIp']}")
            for g in client.describe_security_groups(Filters=[
                    {"Name": "group-name", "Values": [SG_NAME]}])["SecurityGroups"]:
                client.delete_security_group(GroupId=g["GroupId"])
                print(f"{region}: deleted security group")
        except ClientError as e:
            print(f"{region}: skipped ({e.response['Error']['Code']})")
    print("Teardown finished.")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "up":
        public, names, extra = False, [], {}
        it = iter(args)
        for a in it:
            if a == "--public":
                public = True
            elif a == "--peer":                      # --peer sin=http://1.2.3.4:8003
                node_id, _, url = next(it, "").partition("=")
                if node_id not in NODES or not url.startswith("http"):
                    sys.exit("Usage: --peer <mum|hyd|sin>=http://<ip>:<port>")
                extra[node_id] = url.rstrip("/")
            else:
                names.append(a)
        if not names or any(a not in NODES for a in names):
            sys.exit("Usage: up [--public] [--peer id=url] <mum|hyd|sin> [more nodes]")
        up(names, public, extra)
    elif cmd == "status":
        status()
    elif cmd == "check":
        check()
    elif cmd == "token":
        print(admin_token())
    elif cmd == "logs" and len(args) == 1 and args[0] in NODES:
        logs(args[0])
    elif cmd == "down":
        down()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
