# DisasterSync

A replicated data service that keeps accepting writes when the link between regions breaks, then
merges every region back to one state with nothing silently lost, a visible conflict ledger, and a
hash-chained history that shows tampering. Runs on AWS and Azure.

Built for CodeAstra 2.0, Cloud Computing and Distributed Systems.

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

After replacing a node, its `epoch` starts at 0 while the others may be higher (every
`/admin/reset` raises it by one). Nodes on different epochs refuse to sync, so the dashboard shows
`epoch mismatch`. If the replaced node is empty, reset it until the epochs match; it then copies
everything from its peers. Never reset a node that holds data you need.

The token (`infra\.admin_token`) is created on first deploy and is git-ignored. It protects
`/admin/*`, `/sync` and conflict resolution; creating and reading reports stays open.
Three small instances cost about three cents an hour, so run `down` when you are finished.

## Dashboard

A React app with a landing page and a light and dark theme. The built files are committed in
`dashboard/dist`, so no Node.js is needed to show it:

```powershell
python infra\run_cluster.py --fresh --baseline --fast         # the local clusters
python -m http.server 4173 --directory dashboard\dist         # serve the dashboard
# open http://127.0.0.1:4173
```

Every node also serves the dashboard itself at `/ui/`. Locally that is
`http://127.0.0.1:8001/ui/`. On a cloud server it is `http://<server-address>:8001/ui/`, which
opens on any phone or laptop and finds the other regions on its own.

To change it: `cd dashboard`, `npm install`, `npm run dev` (hot reload), then `npm run build`.
After a rebuild, cloud servers pick it up with `python infra\aws_cluster.py up ...` (replaces the
instances) and `python infra\azure_cluster.py update sin` (in place).

- **Overview**: regions, records, conflict ledger and history check, with an Engine / Baseline switch.
- **Infrastructure**: the live deployment. Provider zones (AWS, Azure), each server's machine type,
  address, round-trip latency, chain head, and the replication links between regions.
- **Live tests**: the terminal smoke test, run from the browser against the selected cluster
  (local, or AWS and Azure). Twelve checks with timings, non-destructive, while the topology
  animates. On the cloud it needs the admin token in Settings.
- **Compare**: the same link failure run on our engine and on the last-writer-wins baseline.
- A **Local / Cloud** switch chooses which cluster the console talks to.
- Cut and restore links, simulate a crash or a fast clock, create and edit records, decide conflicts,
  verify the hash chains.
- Visual components (aurora background, spotlight cards, text effects) are from
  [React Bits](https://reactbits.dev), kept in `dashboard/src/reactbits` with their license
  (MIT + Commons Clause).
- **Settings** holds the cloud addresses and the admin token (token is kept for the browser session only).
- Handy URL options: `#overview`, `#infrastructure` or `#compare` opens a view directly,
  `?env=cloud` starts on the cloud cluster, `?theme=light` forces a theme, `?motion=off` skips
  animations, `?autorun=1` (with `#compare`) starts the scenario.

## Benchmark: engine vs last-writer-wins

```powershell
python infra\run_cluster.py --fresh --baseline --fast   # engine on 8001-8003, baseline on 9001-9003
python -m chaos.run --trials 20 --seed 11               # in a second terminal (about 3 minutes)
```

Writes `results\results.json` and two charts. The baseline (`baseline_lww\`) is our own
implementation of item-level last-writer-wins, modelled on DynamoDB Global Tables and Cosmos DB
defaults. Scenarios are conflict-heavy stress tests, not a normal workload.

## Tamper-evident history

Every event is hash-chained to the previous one from the same node.

```powershell
python infra\tamper_demo.py          # edits a stored event behind the app's back, shows detection
curl http://127.0.0.1:8001/audit/verify     # recompute a node's whole chain
curl http://127.0.0.1:8001/audit/heads      # compare newest hashes across nodes
```

## Mixed cloud (AWS + Azure, verified)

Mumbai and Hyderabad on AWS, Singapore on Azure. Run in this order:

```powershell
az login --tenant <tenant-id>                # one time
python infra\azure_cluster.py up sin --public --peer mum=http://<mum-ip>:8001 --peer hyd=http://<hyd-ip>:8002
python infra\aws_cluster.py remove sin       # only if Singapore was on AWS before
python infra\aws_cluster.py up --public --peer sin=http://<azure-ip>:8003 mum hyd
python infra\azure_cluster.py status         # and: aws_cluster.py status
python infra\azure_cluster.py down           # remove the Azure side
```

Student subscriptions allow few regions and VM sizes; `azure_cluster.py` tries sizes in order and
picks the matching x86 or ARM image.

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
