# Task sheet for C: Dashboard (web UI)

Read `00_CONTRACT.md` first. This sheet tells you exactly what to build.

## Why your work matters
Judges only see what is on screen. The engine can be perfect, but if they cannot SEE the
partition, the conflict and the recovery, it looks like nothing happened. Your UI must make
the hidden story visible in under 3 minutes.

## What to build (one page, three columns)

```
+------------------------------------------------------------------+
|  Header: cluster selector [Ours | Baseline | Side by side]       |
+------------------+------------------------+----------------------+
|  REGIONS         |  REPORT BOARD          |  CONFLICT LEDGER     |
|  Mumbai   OK     |  [+ New report]        |  needs_operator: 2   |
|  Hyderabad CUT   |  list of reports with  |  auto_resolved: 5    |
|  Singapore OK    |  durability badges     |  [Resolve] buttons   |
|  [Cut link]      |                        |                      |
|  [Restore]       |  History drawer        |  Test results panel  |
|  [Skew clock]    |  for selected report   |  (from results.json) |
|  [Crash/Resume]  |                        |                      |
+------------------+------------------------+----------------------+
```

### Panel 1: Regions
For each node (from `GET /status`):
- Name (Mumbai, Hyderabad, Singapore), reachable or not, event count, short state hash (first 8 chars), and per-peer: reachable, last sync "x s ago", pending out and in.
- A small network graph: 3 circles with lines. A line is green when linked and red/dashed when blocked.
- Buttons: **Cut link** between two regions, **Restore all**, **Skew clock** (+1 hour / reset), **Crash** and **Resume**. These call the `/admin/*` endpoints (contract 5.4). A cut must call `block` on BOTH nodes.
- If hashes differ across nodes, show a yellow banner: "Regions are out of sync". When they match: green "All regions in sync".

### Panel 2: Report board
- Choose which region you are "sitting in" (dropdown). All writes go to THAT node's URL, and the list shows THAT node's view. This is how we demo two regions disagreeing.
- Form to create a report (fields from contract 3.1).
- Each report row: type icon, severity (1-5), status, description, and a **durability badge**:
  - `local` = orange "Saved locally, at risk"
  - `replicated` = blue "Replicated"
  - `confirmed` = green "Confirmed everywhere"
- Inline edit of severity, status, description, calling `PATCH /reports/{id}`.
- Click a report to open a history drawer from `GET /reports/{id}/history` (timeline of events: who, which region, when, what changed).
- If a report has `conflicts`, show a red marker.

### Panel 3: Conflict ledger
- From `GET /conflicts`. Show `needs_operator` first.
- Each entry shows the competing values side by side, with region labels.
- A **Resolve** button per candidate calls `POST /conflicts/{id}/resolve`.
- `auto_resolved` entries show which policy applied (e.g. "severity: highest wins").
- This panel is the proof that nothing is silently dropped. Make it prominent.

### Panel 4: Test results (reads `results/results.json`, contract section 7)
- Two columns: Ours vs Baseline. Rows: converged %, acknowledged writes lost %, silent overwrites %, convergence p50/p95.
- Show a bold number for "silent overwrites" so the contrast is obvious.
- If the file does not exist yet, show "No results yet".

### Compare mode ("Side by side")
Show the same Regions + Board for two clusters at once: ours on the left (8001-8003), baseline
on the right (9001-9003). Same scenario, two outcomes. This is the centrepiece of the demo.

## Configuration
One file `dashboard/src/config.js` (or `.json`):

```js
export const CLUSTERS = {
  ours: { label: "Ours", nodes: {
    mum: "http://localhost:8001", hyd: "http://localhost:8002", sin: "http://localhost:8003" } },
  lww:  { label: "Baseline (last-writer-wins)", nodes: {
    mum: "http://localhost:9001", hyd: "http://localhost:9002", sin: "http://localhost:9003" } }
};
```

URLs must be changeable without touching component code (D will point them at AWS later).

## How to work before A and B are ready
1. Do NOT wait. Build against a mock. Create `dashboard/mock/` with static JSON files shaped exactly like the contract examples, or a tiny mock server returning them.
2. Hit endpoints through ONE small module `api.js` (functions: `getStatus(node)`, `listReports(node)`, `createReport(node, body)`, `patchReport(...)`, `getConflicts(node)`, `resolveConflict(...)`, `block(node, peer)`, `unblock(...)`, `setClock(...)`, `pause(...)`, `resume(...)`). Swapping mock for real nodes then means changing only the base URL.
3. At hour 6, B's baseline should be running on 9001-9003: point at it and test for real.
4. At hour 10, A's engine should be on 8001-8003. Switch config and fix mismatches.

## Technical guidance
- Suggested: Vite + React (or plain HTML + JS if faster for you). Any framework is fine as long as `npm run build` makes a static site D can host.
- Poll `/status`, `/reports`, `/conflicts` every 1 second. Replace with `GET /stream` (SSE) only if A delivers it.
- Handle a node returning `503` or not responding: show "Unreachable" for that region, do not crash the page.
- Keep it usable with a dozen reports on screen. No fancy animation needed, but flashing a row when it changes is very helpful for demos.

## Definition of done
- [ ] All 4 panels working against the mock
- [ ] Same code working against real baseline nodes (hour 6)
- [ ] Same code working against real engine nodes (hour 10)
- [ ] Cut link, restore, skew clock, crash, resume buttons work
- [ ] Durability badge changes visibly (local to replicated to confirmed)
- [ ] Side-by-side mode (ours vs baseline)
- [ ] Looks fine at 1920x1080 on a projector (large text, high contrast)

## Demo flow your UI must support (practice this)
1. Both regions show the same board. Create a report in Mumbai. It appears in Hyderabad. Badge turns green.
2. Click **Cut link** between Mumbai and Hyderabad. Regions panel shows the break.
3. Edit the same report in both regions (different severity or description). Badges show "Saved locally".
4. Click **Restore**. Watch the banner go from "out of sync" to "in sync".
5. Open the conflict ledger. Show exactly what clashed and how it was resolved.
6. Switch to side-by-side and show that the baseline silently lost one edit.

## Deliver to the team
- `dashboard/README.md`: how to install and run, and how to change the node URLs
- A built static site (`npm run build` output) so D can host it on S3 or similar
