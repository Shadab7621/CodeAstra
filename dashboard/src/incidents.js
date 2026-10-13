// Web-team incidents stored in the DisasterSync cluster, in their own lane.
//
// Each incident becomes an ordinary report whose description starts with INCIDENT_PREFIX, the
// same way the shopping cart uses its own prefix. The cart, the stock rules and the conflict
// ledger only look at their own prefix, so incidents never show up there. The engine replicates
// them like any other record, which is what the Convergence page then reports on.
import { api } from './api';

export const INCIDENT_PREFIX = 'incident:v1:';

const SEVERITY = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const FALLBACK_POINT = [19.076, 72.8777]; // Mumbai, used only when an incident carries no coordinates

// The web team's feed carries no incident type, so one is inferred from the title.
const TYPE_WORDS = [
  ['medical', ['medical', 'injur', 'ambulance', 'hospital', 'health']],
  ['fire', ['fire', 'smoke', 'blaze', 'explosion']],
  ['flood', ['flood', 'water', 'rain', 'cyclone', 'landslide']],
  ['road_blocked', ['road', 'highway', 'bridge', 'collapse', 'obstruction', 'blockage', 'traffic', 'pole', 'tremor']],
];

const pick = (obj, names) => {
  for (const name of names) {
    const key = Object.keys(obj || {}).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key && obj[key] !== null && obj[key] !== undefined && obj[key] !== '') return obj[key];
  }
  return null;
};

/** One feed record in a fixed shape, or null when it has no id to de-duplicate on. */
export function normalizeIncident(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = pick(raw, ['incident_id', 'incidentId', 'id']);
  if (!id) return null;
  const loc = pick(raw, ['location']);
  const place = loc && typeof loc === 'object' ? loc : {};
  const lat = Number(place.latitude ?? place.lat ?? raw.latitude ?? raw.lat);
  const lon = Number(place.longitude ?? place.lon ?? place.lng ?? raw.longitude ?? raw.lon ?? raw.lng);
  return {
    incident_id: String(id),
    title: String(pick(raw, ['title', 'name', 'description']) || 'Incident').slice(0, 160),
    severity: String(pick(raw, ['severity']) || 'Medium'),
    city: String(place.city || (typeof loc === 'string' ? loc : '') || '').slice(0, 60),
    address: String(place.address || '').slice(0, 120),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    created_at: pick(raw, ['created_at', 'createdAt', 'timestamp']) || null,
  };
}

function typeOf(title) {
  const text = title.toLowerCase();
  for (const [type, words] of TYPE_WORDS) if (words.some((w) => text.includes(w))) return type;
  return 'road_blocked';
}

/** The incident as an engine report. */
export function toReport(incident) {
  const [lat, lon] = incident.lat !== null && incident.lon !== null ? [incident.lat, incident.lon] : FALLBACK_POINT;
  return {
    incident_type: typeOf(incident.title),
    severity: SEVERITY[incident.severity.toLowerCase()] ?? 3,
    location: { lat: Math.max(-90, Math.min(90, lat)), lon: Math.max(-180, Math.min(180, lon)) },
    description: INCIDENT_PREFIX + JSON.stringify(incident),
    reporter: 'web-team',
  };
}

/** Incident records held by one region: [{ report, incident }]. */
export function incidentRecords(reports) {
  const out = [];
  for (const report of reports || []) {
    const d = report.description;
    if (typeof d !== 'string' || !d.startsWith(INCIDENT_PREFIX)) continue;
    try { out.push({ report, incident: JSON.parse(d.slice(INCIDENT_PREFIX.length)) }); } catch { /* not ours */ }
  }
  return out;
}

// Ids sent very recently. A poll can read the cluster just before a write lands, and without this
// the same incident would be written twice. After a reset the incident is allowed back in.
const recentlySent = new Map();
const HOLD_MS = 20000;

/** Writes incidents the cluster does not hold yet into one region. Returns the ids created. */
export async function ingestIncidents(baseUrl, incidents) {
  const now = Date.now();
  const created = [];
  for (const incident of incidents) {
    const last = recentlySent.get(incident.incident_id);
    if (last && now - last < HOLD_MS) continue;
    recentlySent.set(incident.incident_id, now);
    try {
      await api.create(baseUrl, toReport(incident));
      created.push(incident.incident_id);
    } catch {
      recentlySent.delete(incident.incident_id); // try again on the next poll
    }
  }
  return created;
}
