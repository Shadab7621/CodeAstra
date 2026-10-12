# CodeAstra

Cloud computing project on AWS.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
copy .env.example .env
aws configure --profile codeastra      # paste IAM user keys, region ap-south-1
.\.venv\Scripts\python.exe check_aws.py
```

## Run with Docker (recommended)

Needs Docker Desktop running. No Python install required.

```powershell
docker compose up -d --build        # build and start 3 nodes on ports 8001-8003
docker compose ps                   # all three should say "healthy"
docker compose logs -f mum          # follow one node's log
docker compose down                 # stop, keeps the data
docker compose down -v              # stop and wipe the data (fresh start)
```

Each node keeps its database in a Docker volume, so data survives restarts and crashes.
Check it end to end with `python infra\smoke_test.py` (needs the packages from `engine\requirements.txt`,
or use the venv below). Do not run Docker and `infra\run_cluster.py` at the same time: they use the same ports.

## Deploy to AWS (three regions)

Needs the AWS CLI profile `codeastra` with EC2 permission. Creates one small instance per
region (Mumbai, Hyderabad, Singapore), tagged `project=codeastra`.

```powershell
python infra\aws_cluster.py up --public mum hyd sin   # deploy; --public opens the node ports
python infra\aws_cluster.py status                    # state, address and health of each node
python infra\aws_cluster.py check                     # create a report, verify the token rules
python infra\aws_cluster.py token                     # the admin token (give it to the dashboard)
python infra\aws_cluster.py down                      # remove everything and stop the cost
```

Run the end-to-end test against the cloud cluster:

```powershell
$env:CLUSTER_URLS = "mum=http://<mum-ip>:8001,hyd=http://<hyd-ip>:8002,sin=http://<sin-ip>:8003"
$env:ADMIN_TOKEN  = (Get-Content infra\.admin_token).Trim()
python infra\smoke_test.py
```

The token (`infra\.admin_token`) is created on first deploy and is git-ignored. It protects
`/admin/*`, `/sync` and conflict resolution; creating and reading reports stays open.
Three small instances cost about three cents an hour, so run `down` when you are finished.

## Tamper-evident history

Every event is hash-chained to the previous one from the same node.

```powershell
python infra\tamper_demo.py          # edits a stored event behind the app's back, shows detection
curl http://127.0.0.1:8001/audit/verify     # recompute a node's whole chain
curl http://127.0.0.1:8001/audit/heads      # compare newest hashes across nodes
```

## Mixed cloud (AWS + Google Cloud)

The same Docker image runs on either provider, and nodes find each other by public address.
For example, Mumbai and Hyderabad on AWS and Singapore on Google Cloud:

```powershell
# one-time on the Google side: gcloud auth login ; gcloud config set project <id>
python infra\gcp_cluster.py ip sin                         # reserve Singapore's address
python infra\aws_cluster.py up --public --peer sin=http://<gcp-ip>:8003 mum hyd
python infra\gcp_cluster.py up sin --peer mum=http://<mum-ip>:8001 --peer hyd=http://<hyd-ip>:8002
python infra\gcp_cluster.py status                         # and: aws_cluster.py status
python infra\gcp_cluster.py down                           # stop the Google side
```

`infra\gcp_cluster.py` has not yet been run against a real Google Cloud project.

## Run the engine locally (without Docker)

```powershell
.\.venv\Scripts\python.exe -m pip install -r engine\requirements.txt
.\.venv\Scripts\python.exe infra\run_cluster.py --fresh     # 3 nodes on ports 8001-8003
```

In a second terminal:

```powershell
.\.venv\Scripts\python.exe infra\smoke_test.py              # replicate, partition, heal, crash
.\.venv\Scripts\python.exe -m pytest engine\tests -q        # unit and multi-node tests
```

Each node serves interactive API docs at `http://127.0.0.1:8001/docs` (and 8002, 8003).
The API contract is in `docs/00_CONTRACT.md`.

## Safety rules
- Use an IAM user (never root) with `ReadOnlyAccess` first.
- Set a billing alarm before creating resources.
- Never commit `.env`, keys, or `.pem` files.
