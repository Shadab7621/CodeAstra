"""Merge engine: turns a report's events into its current state plus a conflict ledger.

Pure functions only (no I/O, no clock). The result depends on the SET of events and never on
the order they arrived in, so any two nodes holding the same events compute the same state.
Rules are in docs/00_CONTRACT.md section 3.4.

Causality comes from each event's version vector (`vv`): what its author had seen when writing.
  a happened-before b  <=>  b.vv[a.origin] >= a.seq
Two writes are concurrent when neither happened before the other. Wall clocks are only used to
pick a display value between concurrent writes, never to decide what is causally newer.
"""
import hashlib
import json
import math
import uuid
from collections import defaultdict
from typing import Optional

MERGED_FIELDS = ("severity", "status", "location", "description")
STATUS_ORDER = {"open": 0, "acknowledged": 1, "in_progress": 2, "resolved": 3}
LOCATION_CONFLICT_M = 500
_CONFLICT_NS = uuid.UUID("6f1d2c3a-0b7e-4a59-9c1d-5e2f8a7b4c10")

NODE_NAMES = {"mum": "Mumbai", "hyd": "Hyderabad", "sin": "Singapore"}

POLICY = {
    "severity": "severity: highest wins",
    "status": "status: most advanced wins",
    "location": "location: latest wins",
    "superseded": "superseded by a later edit",
    "operator": "operator decision",
}


def _order(e: dict) -> tuple:
    h = e["hlc"]
    return (h["wall"], h["counter"], h["node"], e["event_id"])


def happened_before(a: dict, b: dict) -> bool:
    return a["event_id"] != b["event_id"] and b["vv"].get(a["origin"], 0) >= a["seq"]


def concurrent(a: dict, b: dict) -> bool:
    return (a["event_id"] != b["event_id"]
            and not happened_before(a, b) and not happened_before(b, a))


def _canon(value) -> str:
    return json.dumps(value, sort_keys=True)


def distance_m(p: dict, q: dict) -> float:
    """Great-circle distance in metres between two {lat, lon} points."""
    r = 6_371_000
    lat1, lat2 = math.radians(p["lat"]), math.radians(q["lat"])
    dlat = lat2 - lat1
    dlon = math.radians(q["lon"] - p["lon"])
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _rule_value(field: str, writes: list[dict]):
    """Apply the escalate-only rules over a set of writes."""
    values = [w["fields"][field] for w in writes]
    if field == "severity":
        return max(values)
    return max(values, key=lambda s: STATUS_ORDER.get(s, -1))


def _merge_field(report_id: str, field: str, events: list[dict]):
    """Returns (value, conflict entries) for one field of one report."""
    writes = [e for e in events if field in e["fields"]]
    if not writes:
        return None, []

    # An operator decision discards every write the operator had already seen.
    resolves = [w for w in writes if w["op"] == "operator_resolve"]
    live = [w for w in writes if not any(happened_before(w, r) for r in resolves)]
    # Frontier: live writes that no other live write has superseded.
    frontier = [w for w in live if not any(happened_before(w, x) for x in live)]

    if field in ("severity", "status"):
        value = _rule_value(field, live)
    else:
        value = max(frontier, key=_order)["fields"][field]

    return value, _conflicts(report_id, field, writes, resolves, frontier, value)


def _conflicts(report_id, field, writes, resolves, frontier, value) -> list[dict]:
    """Group writes that were concurrent AND disagreed. Each group is one ledger entry.

    Built over the full history, so an entry stays in the ledger after it is resolved.
    """
    parent = list(range(len(writes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(writes)):
        for j in range(i + 1, len(writes)):
            a, b = writes[i], writes[j]
            if concurrent(a, b) and _canon(a["fields"][field]) != _canon(b["fields"][field]):
                parent[find(i)] = find(j)

    groups = defaultdict(list)
    for i, w in enumerate(writes):
        groups[find(i)].append(w)

    frontier_ids = {w["event_id"] for w in frontier}
    entries = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=_order)
        entry = {
            "conflict_id": str(uuid.uuid5(
                _CONFLICT_NS, f"{report_id}:{field}:{min(w['event_id'] for w in group)}")),
            "report_id": report_id,
            "field": field,
            "candidates": [
                {"event_id": w["event_id"], "origin": w["origin"],
                 "value": w["fields"][field], "hlc": w["hlc"]}
                for w in group
            ],
            "detected_at": max(w["client_ts"] for w in group),
        }
        entry["status"], entry["resolution"] = _resolution(
            field, group, resolves, frontier_ids, value)
        entry["winner"], entry["explanation"] = _explain(field, group, entry)
        entries.append(entry)
    return entries


def _show(field: str, value) -> str:
    if field == "location" and isinstance(value, dict):
        return f"{value['lat']:.4f}, {value['lon']:.4f}"
    text = str(value)
    return text if len(text) <= 40 else text[:37] + "..."


def _who(origin: str) -> str:
    return NODE_NAMES.get(origin, origin)


def _explain(field: str, group: list[dict], entry: dict):
    """Plain-words answer to "which value won, and which rule decided it?".

    Returns (winner, sentence). winner is the candidate that supplied the final value, or None
    while an operator still has to choose. Display only: it never feeds back into the merge."""
    seen = []  # one line per distinct (region, value), oldest first
    for w in group:
        item = f"{_who(w['origin'])} set {_show(field, w['fields'][field])}"
        if item not in seen:
            seen.append(item)
    versions = ", ".join(seen[:3]) + (f" and {len(seen) - 3} more" if len(seen) > 3 else "")

    resolution = entry["resolution"]
    if resolution is None:
        return None, (f"{versions}, at the same time, and no rule can pick between them safely. "
                      "An operator has to choose.")

    chosen = resolution["chosen_value"]
    matching = [w for w in group if _canon(w["fields"][field]) == _canon(chosen)]
    winner = None
    if matching:
        top = max(matching, key=_order)
        winner = {"event_id": top["event_id"], "origin": top["origin"], "value": chosen}
    kept = f"Kept {_show(field, chosen)}"
    source = f" from {_who(winner['origin'])}" if winner else ""

    policy = resolution["policy"]
    if policy == POLICY["operator"]:
        return winner, (f"{resolution.get('operator') or 'An operator'} reviewed the versions "
                        f"({versions}) and chose {_show(field, chosen)}{source}.")
    if policy == POLICY["severity"]:
        return winner, (f"{versions}, at the same time. Severity can only go up, so the highest "
                        f"value wins. {kept}{source}.")
    if policy == POLICY["status"]:
        return winner, (f"{versions}, at the same time. Status can only move forward, so the "
                        f"most advanced one wins. {kept}{source}.")
    if policy == POLICY["location"]:
        return winner, (f"{versions}, at the same time and less than {LOCATION_CONFLICT_M} m "
                        f"apart, so the most recent one wins. {kept}{source}.")
    return winner, (f"{versions}, at the same time. A later edit by someone who had seen "
                    f"all of them replaced them. Current value: {_show(field, chosen)}.")


def _resolution(field, group, resolves, frontier_ids, value):
    decided = [r for r in resolves if all(happened_before(c, r) for c in group)]
    if decided:
        r = max(decided, key=_order)
        return "operator_resolved", {
            "policy": POLICY["operator"],
            "chosen_value": r["fields"][field],
            "operator": r["fields"].get("_meta", {}).get("operator"),
            "event_id": r["event_id"],
        }

    if field in ("severity", "status"):
        return "auto_resolved", {"policy": POLICY[field],
                                 "chosen_value": _rule_value(field, group)}

    still_open = [w for w in group if w["event_id"] in frontier_ids]
    if len({_canon(w["fields"][field]) for w in still_open}) < 2:
        # Someone who had seen the competing versions wrote a newer one.
        return "auto_resolved", {"policy": POLICY["superseded"], "chosen_value": value}

    if field == "location":
        far = any(
            concurrent(a, b)
            and distance_m(a["fields"][field], b["fields"][field]) > LOCATION_CONFLICT_M
            for i, a in enumerate(still_open) for b in still_open[i + 1:]
        )
        if not far:
            latest = max(still_open, key=_order)
            return "auto_resolved", {"policy": POLICY["location"],
                                     "chosen_value": latest["fields"][field]}

    return "needs_operator", None


def merge_report(report_id: str, events: list[dict]) -> tuple[Optional[dict], list[dict]]:
    """Returns (report, conflict entries). report is None until the create event has arrived."""
    events = sorted(events, key=_order)
    creates = [e for e in events if e["op"] == "create"]
    if not creates:
        return None, []
    created = creates[0]["fields"]

    report = {
        "report_id": report_id,
        "incident_type": created.get("incident_type"),
        "reporter": created.get("reporter"),
    }
    conflicts = []
    for field in MERGED_FIELDS:
        report[field], field_conflicts = _merge_field(report_id, field, events)
        conflicts.extend(field_conflicts)

    report["conflicts"] = sorted(
        c["conflict_id"] for c in conflicts if c["status"] == "needs_operator")
    report["possible_duplicates"] = []
    report["last_updated"] = events[-1]["hlc"]
    return report, conflicts


def merge_all(events_by_report: dict[str, list[dict]]) -> tuple[list[dict], list[dict]]:
    """Returns (reports sorted by id, all conflict entries)."""
    reports, conflicts = [], []
    for report_id in sorted(events_by_report):
        report, report_conflicts = merge_report(report_id, events_by_report[report_id])
        if report is not None:
            reports.append(report)
            conflicts.extend(report_conflicts)
    conflicts.sort(key=lambda c: (c["status"] != "needs_operator", c["detected_at"],
                                  c["conflict_id"]))
    return reports, conflicts


def state_hash(reports: list[dict], event_ids: list[str]) -> str:
    """Equal on two nodes exactly when they hold the same events and merged them the same way.

    Durability is left out on purpose: it legitimately differs between nodes.
    """
    payload = json.dumps({"reports": reports, "event_ids": sorted(event_ids)},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()
