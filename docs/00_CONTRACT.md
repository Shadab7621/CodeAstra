# 00 - Shared Contract (READ FIRST, everyone)

Project: **Geo-distributed disaster report replication with graceful degradation.**
Three regional servers keep accepting disaster reports even when disconnected from each other,
then merge safely when the network returns. Nothing is silently lost.

This file is the single source of truth. If your code and this file disagree, this file wins.
Change it only by telling the whole team.

## 1. Team and ownership

| Who | Owns | Folder |
|---|---|---|
| A | Sync engine (the real system) | `engine/` |
| B | Baseline (last-writer-wins) + chaos tester + benchmarks | `baseline_lww/`, `chaos/` |
| C | Dashboard (web UI) | `dashboard/` |
| D | Infra, AWS, Docker, partition control, demo, slides | `infra/`, `docs/` |

Never edit another person's folder. Ask them.

## 2. The cluster

Three nodes ("regions"). Every node exposes the SAME HTTP API (section 5).

| Node ID | Label shown in UI | Port (engine, `MODE=crdt`) | Port (baseline, `MODE=lww`) |
|---|---|---|---|
| `mum` | Mumbai | 8001 | 9001 |
| `hyd` | Hyderabad | 8002 | 9002 |
| `sin` | Singapore | 8003 | 9003 |

Two clusters run side by side: ours (8001-8003) and the baseline (9001-9003). The demo
compares them. Both speak the identical API so C and B treat them the same way.

Environment variables for every node: `NODE_ID`, `PORT`, `PEERS` (comma list of base URLs),
`MODE` (`crdt` or `lww`). CORS must be enabled (allow all origins).

## 3. Data model

### 3.1 Report (what users see)

```json
{
  "report_id": "b1c7...uuid",
  "incident_type": "flood",
  "severity": 4,
  "status": "open",
  "location": { "lat": 19.076, "lon": 72.877 },
  "description": "Water level rising on main road",
  "reporter": "citizen-102",
  "durability": "local",
  "conflicts": [],
  "possible_duplicates": [],
  "last_updated": { "wall": 1760000000000, "counter": 0, "node": "mum" }
}
```

| Field | Type | Allowed values |
|---|---|---|
| `incident_type` | string | `flood`, `fire`, `road_blocked`, `medical` |
| `severity` | int | 1 to 5 |
| `status` | string | `open`, `acknowledged`, `in_progress`, `resolved` |
| `location` | object | `lat`, `lon` numbers |
| `description` | string | up to 500 chars |
| `reporter` | string | any |
| `durability` | string | `local`, `replicated`, `confirmed` (see 3.3) |

### 3.2 Event (what is stored and synced; immutable, append-only)

Every change is an event. Reports are rebuilt by merging events. Events are never edited or deleted.

```json
{
  "event_id": "uuid",
  "report_id": "uuid",
  "origin": "mum",
  "seq": 17,
  "hlc": { "wall": 1760000000000, "counter": 0, "node": "mum" },
  "op": "update",
  "fields": { "severity": 5 },
  "client_ts": "2026-10-12T10:30:00Z"
}
```

- `op` is `create`, `update`, or `operator_resolve`.
- `hlc` is a hybrid logical clock. Order events by `(wall, counter, node)`. Wall clocks may be
  wrong on purpose (clock-skew tests), so never order by `client_ts`.
- `seq` is a per-origin counter (1, 2, 3...). It lets nodes ask "give me everything from `mum` after seq 17".

### 3.3 Durability (shown on every report)

| Value | Meaning |
|---|---|
| `local` | Only this node has it. At risk if this node is lost. |
| `replicated` | At least one other node has it. |
| `confirmed` | All nodes have it. |

### 3.4 Merge rules (decided; A implements, B tests, C displays)

| Field | Rule when two nodes changed it concurrently |
|---|---|
| `incident_type` | Set once at create, never changes |
| `reporter` | Set once at create, never changes |
| `severity` | Highest value wins (can only escalate). Lowering needs an `operator_resolve` event |
| `status` | Higher rank wins: `open` < `acknowledged` < `in_progress` < `resolved`. Reopening needs `operator_resolve` |
| `location` | Latest HLC wins. If the two candidates are more than 500 m apart, also raise a conflict |
| `description` | Different texts: keep BOTH, raise a conflict for the operator |

Rule of thumb: auto-resolve when the rule is safe, otherwise record a conflict. Never drop data silently.

### 3.5 Conflict ledger entry

```json
{
  "conflict_id": "uuid",
  "report_id": "uuid",
  "field": "description",
  "candidates": [
    { "event_id": "uuid", "origin": "mum", "value": "Road flooded", "hlc": {"wall":1,"counter":0,"node":"mum"} },
    { "event_id": "uuid", "origin": "hyd", "value": "Water at knee height", "hlc": {"wall":2,"counter":0,"node":"hyd"} }
  ],
  "status": "needs_operator",
  "resolution": null,
  "detected_at": "2026-10-12T10:31:00Z"
}
```

`status` is one of:

| Status | Meaning | `resolution` |
|---|---|---|
| `needs_operator` | Still open, a person must choose | `null` |
| `auto_resolved` | A merge rule decided, or a later edit replaced both versions | `{policy, chosen_value}` |
| `operator_resolved` | An operator chose | `{policy, chosen_value, operator, event_id}` |

Entries stay in the ledger after they are resolved (it is a history, not a to-do list).
A report's `conflicts` field lists the `conflict_id`s that are still `needs_operator`.
An operator may also resolve an `auto_resolved` entry: that is how severity is lowered or a
status moved back.

### 3.6 Additions made while building the engine (v1.1)

These are additive: nothing in the original contract changed.

- Events carry an extra field `vv` (version vector: what the author had seen). The engine
  uses it to tell "at the same time" from "one after the other". B and C can ignore it.
- `PATCH /reports/{id}` also returns `warnings: [string]`. It is non-empty when the write was
  recorded but an escalate-only rule kept a higher value. C should show it to the user.
- A conflict's `conflict_id` can change if another concurrent edit joins the same conflict.
  If `POST /conflicts/{id}/resolve` returns `404`, reload the ledger and retry.
- `POST /conflicts/{id}/resolve` returns `409` if an operator already resolved that entry.
- The engine's state hash covers the merged reports AND the set of event ids, so equal hashes
  mean the nodes hold the same events and merged them identically.

### 3.7 Additions made with the sync protocol (v1.2)

Also additive.

- `PEERS` uses `id=url` pairs: `PEERS="hyd=http://host:8002,sin=http://host:8003"`.
- `GET /status` has a top-level `epoch`, and each peer row also has `reason` and `blocked`.
  `reason` is `null` when reachable, otherwise one of `blocked`, `paused`, `self_paused`,
  `unreachable`, `epoch_mismatch`, `never_contacted`, `not_configured`.
- **Reset and epochs (important for B).** `POST /admin/reset` wipes the node and raises its
  `epoch` by one. Nodes only sync with peers on the same epoch. So to reset a cluster, just
  call reset on all three nodes in any order: a node that is already wiped will not get old
  data copied back from one that is not wiped yet. Resetting only one node leaves it
  isolated (`epoch_mismatch`) until the others are reset too.
- `POST /admin/sync-now` returns `{ ok, peers: [{ id, reachable, reason, applied }] }`.
- `POST /sync` is the node-to-node endpoint. B's baseline and C's dashboard never call it.
- A report's `durability` is `confirmed` only when every other node is known to hold ALL of
  that report's events, and `replicated` when at least one other node does.
- After a node with a fast clock has synced, the other nodes' logical clocks move forward to
  match it. `last_updated.wall` can therefore be ahead of real time. Ordering stays correct;
  do not display `wall` as a real timestamp (use the event's `client_ts`).

## 4. Time and sync behaviour (so tests have fixed numbers)

- Nodes sync with each other every **500 ms** in the background.
- A write returns immediately after saving locally; it never waits for other nodes.
- "Healed" means all links are unblocked. After healing, all nodes should converge within **10 seconds** under normal test load.
- Quiescent timeout used by tests: **30 seconds**.

## 5. HTTP API (identical on every node)

All bodies are JSON. Errors look like `{ "error": "bad_request", "message": "..." }` with a proper HTTP status.

### 5.1 Reports

| Method and path | Body | Returns |
|---|---|---|
| `POST /reports` | `incident_type, severity, location, description, reporter`, optional `status` | `201` `{ report_id, event_id, durability: "local" }` |
| `PATCH /reports/{id}` | any of `severity, status, location, description` | `200` `{ event_id, durability }` |
| `GET /reports` | none | `{ reports: [Report] }` |
| `GET /reports/{id}` | none | `Report` |
| `GET /reports/{id}/history` | none | `{ events: [Event] }` sorted by HLC |

### 5.2 Conflicts

| Method and path | Body | Returns |
|---|---|---|
| `GET /conflicts` | none | `{ conflicts: [ConflictEntry] }` |
| `POST /conflicts/{id}/resolve` | `{ "chosen_event_id": "uuid", "operator": "name" }` | `200` updated entry |

### 5.3 Status and verification

| Method and path | Returns |
|---|---|
| `GET /status` | `{ node_id, mode, clock_offset_ms, paused, event_count, state_hash, peers: [{ id, reachable, last_sync_ms_ago, pending_out, pending_in }] }` |
| `GET /state-hash` | `{ node_id, hash, event_count }`. `hash` = SHA-256 of the canonical merged state (reports sorted by id, keys sorted). Equal hash means converged |
| `GET /events?ids_only=true` | `{ node_id, event_ids: ["uuid", ...] }`. Used to prove no acknowledged write was lost |
| `GET /healthz` | `{ "ok": true }` |

### 5.4 Admin / fault injection (used by B's chaos tester, C's buttons, D's scripts)

| Method and path | Body | Effect |
|---|---|---|
| `POST /admin/block` | `{ "peer": "hyd" }` | This node stops sending to AND accepting from that peer |
| `POST /admin/unblock` | `{ "peer": "hyd" }` | Reverse of block |
| `POST /admin/clock` | `{ "offset_ms": 3600000 }` | Shifts this node's wall clock (negative allowed) |
| `POST /admin/pause` | none | Simulates a crash: every endpoint except `/healthz` and `/admin/resume` returns `503` |
| `POST /admin/resume` | none | Node comes back with its data intact |
| `POST /admin/reset` | none | Wipes all data. Tests only |
| `POST /admin/sync-now` | none | Triggers an immediate sync round |

A partition between `mum` and `hyd` = call `block` on `mum` (peer `hyd`) AND on `hyd` (peer `mum`).

### 5.5 Live updates (optional, nice-to-have)

`GET /stream` returns Server-Sent Events. One JSON object per event, with `type` one of
`event_applied`, `conflict_detected`, `peer_status_changed`. C may poll `/reports`, `/status`
and `/conflicts` every 1 second until this exists.

## 6. Repo layout

```
CodeAstra/
  docs/              contract and task sheets
  engine/            A: our sync engine (ports 8001-8003)
  baseline_lww/      B: last-writer-wins baseline (ports 9001-9003)
  chaos/             B: fault injector, invariant checks, benchmark
  dashboard/         C: web UI
  infra/             D: docker-compose, AWS scripts, partition scripts
  results/           B writes results.json and charts here
```

## 7. Test results file (B writes, C reads)

`results/results.json`:

```json
{
  "generated_at": "2026-10-12T14:00:00Z",
  "runs": 1000,
  "systems": {
    "ours": {
      "converged_pct": 100.0,
      "acked_writes_lost_pct": 0.0,
      "silent_overwrites_pct": 0.0,
      "convergence_ms_p50": 1200,
      "convergence_ms_p95": 4800
    },
    "lww_baseline": {
      "converged_pct": 100.0,
      "acked_writes_lost_pct": 0.0,
      "silent_overwrites_pct": 23.4,
      "convergence_ms_p50": 900,
      "convergence_ms_p95": 2100
    }
  },
  "scenarios": [
    { "name": "concurrent_edit", "runs": 200, "ours_pass": 200, "lww_pass": 154 }
  ]
}
```

## 8. Integration milestones (hours from start)

| Hour | Who | Deliverable |
|---|---|---|
| 2 | All | Everyone has read and agreed to this file |
| 6 | A | One engine node answers `/reports`, `/status`, `/admin/*` (even if sync is incomplete) |
| 6 | B | Baseline node running on 9001-9003 with the same API |
| 6 | C | Dashboard works against a mock or the baseline |
| 10 | A | 3 engine nodes syncing; conflict ledger working |
| 10 | C | Dashboard connected to real engine nodes |
| 12 | B | Chaos runner executes against both clusters and prints pass/fail |
| 16 | B | `results/results.json` generated |
| 20 | All | Feature freeze, demo rehearsal begins |

## 9. Ground rules

- Python 3.13 for server and test code. Pin dependencies in each folder's `requirements.txt`.
- Never commit `.env`, keys, `.pem` files or the `.venv`.
- Small commits, merge to `main` often.
- If the contract is unclear or wrong, ask in the group chat. Do not guess silently.
