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
