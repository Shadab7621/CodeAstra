# UI changes for the frontend (what the new backend now provides)

Four things were added to the engine. All are additive: nothing existing changed, so the current
dashboard keeps working. Each section says what to show, where, and which field to read.

All data comes from the node you are already polling (`useCluster` in `dashboard/src/hooks.js`).
Add `GET /recovery` to the same poll (see the API helper in `dashboard/src/api.js`).

---

## 1. "Why this version won" line in the conflict ledger

**Where:** each row/card in `dashboard/src/components/Ledger.jsx`.

**Data:** every entry of `GET /conflicts` now has

| Field | Meaning |
|---|---|
| `explanation` | One ready-made sentence, e.g. `Mumbai set 4, Hyderabad set 5, at the same time. Severity can only go up, so the highest value wins. Kept 5 from Hyderabad.` |
| `winner` | `{ event_id, origin, value }` or `null` while an operator still has to choose |

**Do:**
- Show `explanation` as a small line under the conflict title (muted text, one or two lines).
- If `winner` is not null, highlight the candidate whose `event_id` equals `winner.event_id` in
  the candidates list with a "Kept" pill. Show the other candidates as plain.
- If `winner` is null (status `needs_operator`), keep the existing "Choose" buttons and show
  `explanation` in the warning colour: it says an operator has to choose.
- Do not rewrite the sentence in the UI. It is written by the engine so the text and the
  decision always agree.

---

## 2. "Last synced 5 s ago" per region and per link

**Where:** `Regions.jsx` (region card, and the link chips under it) and `Topology.jsx` (link label).

**Data:** `GET /status` -> `peers[]`, each row has

| Field | Meaning |
|---|---|
| `last_sync_ms_ago` | Milliseconds since the last successful pull from that peer, `null` if never |
| `last_sync_at` | Same moment as unix seconds (use for a tooltip with the clock time) |
| `reachable`, `reason`, `blocked` | Already used for the link state |

**Do:**
- Link chip text: when connected show `synced 3 s ago`; when cut show `last sync 2 min ago`; when
  `last_sync_ms_ago` is `null` show `never synced`.
- Region card: add one metric `Last sync` using the newest (smallest) `last_sync_ms_ago` among
  that region's peers.
- Format with a small helper in `lib.js` (`ago(ms)`: `<1 s`, `5 s`, `2 min`, `1 h`). Tick it from
  the existing 1 s poll, so no extra timer is needed.
- If the value is above ~5 s while the link says connected, colour it as a warning.

---

## 3. Recovery report after reconnect

**Where:** a new panel `RecoveryReport.jsx`, placed under `Regions` on the Overview page.
Also fire a toast when a new report appears (use the existing `Toast`).

**Data:** `GET /recovery` on the region being viewed:

```json
{
  "node_id": "mum",
  "episodes": [ {
    "peer": "hyd",
    "status": "recovered",
    "summary": "Link to Hyderabad restored after 42 s. 12 changes received, 9 sent, 2 conflicts (1 auto-resolved, 1 waiting for an operator), 0 failed.",
    "outage_ms": 42000,
    "received": 12, "sent": 9,
    "conflicts": { "new": 2, "auto_resolved": 1, "needs_operator": 1 },
    "failed": 0,
    "changes": { "reports_added": 3, "reports_changed": 2 },
    "recovered_at": 1760000044.0
  } ],
  "in_progress": [ { "peer": "hyd", "status": "recovering", "received": 4, "sent": 0 } ]
}
```

**Do:**
- Show the newest `episodes` entry as a card with four numbers: **Received**, **Sent**,
  **Conflicts** (with `auto_resolved` / `needs_operator` underneath) and **Failed**. `Failed` is
  green at 0 and red above.
- Put `summary` as the card heading so it can be read out loud in the demo.
- While `in_progress` is not empty, show "Recovering link to <peer> ... N changes received" with
  a small progress/pulse indicator. It switches to the finished card by itself.
- Older episodes: a collapsed list, newest first (`recovered_at`, `peer`, `summary`).
- Empty state: `No outage yet. Cut a link, write on both sides and restore it.`
- Names: map `peer` ids with `REGION[peer].name` from `config.js`.

---

## 4. Before / during / after view

**Where:** same panel as section 3, as an expandable "Compare" section under the newest report
(or a tab inside it). It uses the same `episode` object.

**Data:** `episode.before`, `episode.during`, `episode.after`. Each is

```json
{ "taken_at": 1760000000.0, "event_count": 14, "state_hash": "ab12...", "report_count": 4,
  "conflicts": { "needs_operator": 1, "auto_resolved": 2 },
  "reports": [ { "report_id": "...", "severity": 3, "status": "open",
                 "location": {"lat": 19.07, "lon": 72.87}, "description": "..." } ] }
```

- `before` = the region just as the link went down.
- `during` = the region as it stood when the link came back, i.e. what it held while cut off,
  before anything was replayed.
- `after` = once everything was exchanged.

**Do:** three columns, left to right: **Before**, **During the outage**, **After recovery**.
Each column shows:
- `event_count` and `report_count` as big numbers,
- `state_hash` (first 8 characters, mono font, reuse `shortHash` from `lib.js`),
- the conflict counts,
- a short list of reports (`description`, `severity`, `status`), max 5, "+N more" after that.

Visual cues that make the story obvious to judges:
- Under `After`, show a green tick `Hashes match` when this region's `after.state_hash` equals the
  same-time `state_hash` of the other regions (read their `/status`), otherwise amber
  `Still catching up`.
- Highlight rows in `After` that are not in `Before` with a "new" pill, and rows whose
  `severity`/`status`/`description` differ from `Before` with a "changed" pill (compare by
  `report_id`). `episode.changes` gives the totals for the heading.
- Cart demo note: descriptions of cart lines start with `cart-item:v1:`. Reuse the
  `cartItem()` parser from `Reports.jsx` so the column shows product name and quantity, not JSON.

---

## Notes for the frontend developer

- Each region keeps its own recovery reports. If the cluster has three regions, fetch `/recovery`
  from the region the user selected (same as the reports table).
- A report exists only after the link actually went down and came back while the node was
  running. Opening the dashboard on a healthy cluster shows the empty state; that is expected.
- `POST /admin/reset` clears the reports, so the demo is repeatable.
- Offline or paused regions return `503` for `/recovery`: show the existing paused/unreachable
  empty state.
- Do not edit anything in `engine/`. If a field is missing, tell the backend owner.
- Run the demo to see real data: cut Mumbai-Hyderabad, edit the same cart line (or severity) in
  both, restore the link, wait ~3 s, then open the panel.
