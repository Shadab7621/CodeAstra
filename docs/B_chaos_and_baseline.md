# Task sheet for B: Baseline + Chaos Tester + Benchmarks

Read `00_CONTRACT.md` first. This sheet tells you exactly what to build.

## Why your work matters
Anyone can say "our system does not lose data". You are the person who PROVES it, with numbers,
and who shows a competitor-style system (last-writer-wins) losing data in the same test.
Your results are the strongest slide in the demo.

## You build two things

### Part 1: Baseline node (`baseline_lww/`)
A small server that implements the SAME API as the engine (contract section 5) but resolves
conflicts the way DynamoDB Global Tables does by default: **last writer wins**.

Rules for the baseline:
- Same endpoints and JSON shapes as the contract. Run with `MODE=lww` on ports 9001-9003.
- Store the current value of each report field plus the wall-clock timestamp of the write.
- When syncing, for each field keep the value with the larger wall-clock timestamp (tie: larger node ID).
- Use wall time ONLY. Do not use hybrid logical clocks. `POST /admin/clock` must shift this clock.
- No conflict ledger entries: `GET /conflicts` always returns `{ "conflicts": [] }` (this is the point: it hides conflicts).
- Sync every 500 ms with peers (pull or push, your choice).
- Must support: `/reports`, `/reports/{id}`, `/status`, `/state-hash`, `/events?ids_only=true`, `/healthz`, all `/admin/*`.
- For `/events?ids_only=true`, still return the ids of every write the node has accepted, even if that write was later overwritten. This lets the checker prove which acknowledged writes were overwritten.

Suggested stack: FastAPI + uvicorn + SQLite or an in-memory dict. Keep it under ~250 lines.

Definition of done: the same script can create a report on `9001` and read it back from `9002` within 2 seconds.

### Part 2: Chaos tester (`chaos/`)

A command-line tool that runs fault scenarios against a cluster and checks invariants.

```
python -m chaos.run --cluster ours --scenario concurrent_edit
python -m chaos.run --cluster lww  --scenario concurrent_edit
python -m chaos.run --cluster ours --random --runs 200 --seed 42
python -m chaos.report            # builds results/results.json and charts
```

`--cluster ours` means ports 8001-8003; `--cluster lww` means 9001-9003.

#### Fault actions (all via the admin API, contract 5.4)
- Partition a pair of nodes, or isolate one node from both others
- Heal everything
- Skew a node's clock by +/- up to 1 hour
- Pause then resume a node (crash and recovery)
- Flap a link (block, unblock, repeat quickly)

#### Named scenarios (write these first)

| Name | What it does |
|---|---|
| `simple_partition` | Cut `mum` from the rest, write on both sides, heal |
| `concurrent_edit` | Create a report, cut link, edit the SAME field on both sides, heal |
| `clock_skew` | Set one node's clock +1 hour, edit on both sides, heal |
| `crash_recover` | Pause a node mid-writes, resume, verify it catches up |
| `pairwise_partition` | `mum`-`hyd` cut, but both can still reach `sin` |
| `flapping_link` | Rapidly cut and restore a link while writing |

#### Random mode
Seeded random sequence of: create, update, partition, heal, skew, pause, resume. Same seed must
reproduce the same run, so failures can be debugged.

#### Invariants to check after every run (after healing and waiting up to 30 s)

| ID | Invariant | How to check |
|---|---|---|
| I1 | **Convergence**: all nodes have the same state | `/state-hash` equal on all nodes |
| I2 | **No acknowledged write lost**: every event the API returned 2xx for exists on every node | Collect `event_id`s from POST/PATCH responses; confirm each is in every node's `/events?ids_only=true` |
| I3 | **No silent overwrite**: if two nodes changed the same field concurrently with different values, either a merge rule applies or a conflict entry exists | Compare the writes you made to the final report plus `/conflicts` |
| I4 | **Status never goes backward** (`resolved` never returns to `open` without `operator_resolve`) | Check final status against all status writes |
| I5 | **Severity never decreases** without `operator_resolve` | Same idea |
| I6 | **Convergence time**: time from heal to equal hashes | Measure; record in milliseconds |

For the LWW baseline, I1 may pass while I2/I3 FAIL. That difference is what we want to show.
Do NOT make the baseline look worse than it really is: implement it honestly.

#### Output
- Print a clear PASS/FAIL table per scenario.
- Write each run to `results/runs/<timestamp>.json`.
- `chaos.report` aggregates into `results/results.json` using EXACTLY the schema in contract section 7.
- Also produce two PNG charts in `results/`: (1) silent overwrite % ours vs baseline,
  (2) convergence time p50/p95. Use matplotlib.

## Working before A is finished
A's engine will not be ready for hours. You do not need it:
1. Build the baseline first and test your chaos runner against it (`--cluster lww`).
2. When A's engine appears on 8001-8003 (milestone: hour 10), run `--cluster ours`.
3. If the engine fails an invariant, report it to A with: scenario name, seed, and the printed diff. That is a bug report, not a failure on your side.

## Definition of done
- [ ] Baseline passes the contract's API on ports 9001-9003
- [ ] 6 named scenarios run against both clusters
- [ ] Random mode with seeds, 200+ runs per cluster
- [ ] `results/results.json` matches contract section 7
- [ ] Two charts generated
- [ ] A one-command demo: `python -m chaos.demo` runs `concurrent_edit` on both clusters and prints a side-by-side summary

## Deliver to the team
- A short `chaos/README.md` with the run commands above
- Final numbers (for the slide), with the seed and number of runs written beside them
