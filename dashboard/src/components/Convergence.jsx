import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import Panel from './Panel';

const LocationAnalytics = lazy(() => import('./LocationAnalytics'));

const POLL_MS = 2500;
const WEB_REFRESH_MS = 30000;
const DEMO_TOTAL_INCIDENTS = 42;
const DEMO_WEB_INCIDENTS = [
  { incident_id: 'INC-108', title: 'Flood in low area', severity: 'Critical', location: 'Mumbai', created_at: '12:29:15' },
  { incident_id: 'INC-107', title: 'Road blockage', severity: 'High', location: 'Hyderabad', created_at: '12:28:47' },
  { incident_id: 'INC-106', title: 'Electric pole down', severity: 'Medium', location: 'Pune', created_at: '12:27:30' },
  { incident_id: 'INC-105', title: 'Medical emergency', severity: 'High', location: 'Bengaluru', created_at: '12:26:10' },
  { incident_id: 'INC-104', title: 'Bridge crack reported', severity: 'Critical', location: 'Chennai', created_at: '12:24:55' },
  { incident_id: 'INC-103', title: 'Waterlogging near station', severity: 'High', location: 'Mumbai', created_at: '12:22:40' },
  { incident_id: 'INC-102', title: 'Power outage reported', severity: 'Medium', location: 'Mumbai', created_at: '12:20:18' },
];
const CITY_COORDINATES = [
  { name: 'Mumbai', aliases: ['bombay'], coords: [19.076, 72.8777] },
  { name: 'Hyderabad', aliases: [], coords: [17.385, 78.4867] },
  { name: 'Pune', aliases: [], coords: [18.5204, 73.8567] },
  { name: 'Bengaluru', aliases: ['bangalore'], coords: [12.9716, 77.5946] },
  { name: 'Chennai', aliases: ['madras'], coords: [13.0827, 80.2707] },
  { name: 'Delhi', aliases: ['new delhi'], coords: [28.6139, 77.209] },
  { name: 'Kolkata', aliases: ['calcutta'], coords: [22.5726, 88.3639] },
  { name: 'Ahmedabad', aliases: [], coords: [23.0225, 72.5714] },
  { name: 'Jaipur', aliases: [], coords: [26.9124, 75.7873] },
  { name: 'Lucknow', aliases: [], coords: [26.8467, 80.9462] },
  { name: 'Bhopal', aliases: [], coords: [23.2599, 77.4126] },
  { name: 'Nagpur', aliases: [], coords: [21.1458, 79.0882] },
  { name: 'Surat', aliases: [], coords: [21.1702, 72.8311] },
  { name: 'Patna', aliases: [], coords: [25.5941, 85.1376] },
  { name: 'Visakhapatnam', aliases: ['vizag'], coords: [17.6868, 83.2185] },
  { name: 'Kochi', aliases: ['cochin'], coords: [9.9312, 76.2673] },
  { name: 'Bhubaneswar', aliases: [], coords: [20.2961, 85.8245] },
  { name: 'Gurugram', aliases: ['gurgaon'], coords: [28.4595, 77.0266] },
  { name: 'Noida', aliases: [], coords: [28.5355, 77.391] },
  { name: 'Thane', aliases: [], coords: [19.2183, 72.9781] },
];
const WEB_PROXY = import.meta.env.VITE_WEB_CONVERGENCE_API
  || `${window.location.protocol}//${window.location.hostname}:4000`;

function recordsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
    return [data];
  }
  return [];
}

function WebIncidentFeed({ onFeed }) {
  const [feed, setFeed] = useState(null);

  const refresh = async () => {
    try {
      const response = await fetch(`${WEB_PROXY}/api/fetch`, { method: 'POST', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Proxy answered HTTP ${response.status}`);
      const data = await response.json();
      setFeed(data);
      onFeed?.(data);
    } catch (error) {
      const offline = { source: 'offline', all: { ok: false, error: error.message }, latest: { ok: false, error: error.message } };
      setFeed(offline);
      onFeed?.(offline);
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, WEB_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return null;
}

function fieldOf(record, names) {
  for (const name of names) {
    const key = Object.keys(record || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && record[key] !== null && record[key] !== undefined && record[key] !== '') return record[key];
  }
  return null;
}

function incidentLocation(value) {
  if (!value || typeof value !== 'object') return value || '—';
  return value.city || value.name || value.locality || value.district || value.address
    || (value.lat !== undefined && value.lon !== undefined ? `${value.lat}, ${value.lon}` : null)
    || (value.latitude !== undefined && value.longitude !== undefined ? `${value.latitude}, ${value.longitude}` : '—');
}

function reportPlace(record) {
  const raw = fieldOf(record, ['location', 'city', 'district', 'address']);
  const point = raw && typeof raw === 'object' ? raw : {};
  const latitude = Number(point.lat ?? point.latitude ?? record?.lat ?? record?.latitude ?? point.coordinates?.[1]);
  const longitude = Number(point.lon ?? point.lng ?? point.longitude ?? record?.lon ?? record?.lng ?? record?.longitude ?? point.coordinates?.[0]);
  let name = String(incidentLocation(raw) || '').trim();
  const known = CITY_COORDINATES.find((city) => [city.name, ...city.aliases].some((alias) => name.toLowerCase().includes(alias.toLowerCase())));
  if (known) name = known.name;
  if ((!name || name === '—') && Number.isFinite(latitude) && Number.isFinite(longitude)) name = `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
  if (!name || name === '—') return null;
  const coords = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? [latitude, longitude]
    : known?.coords || null;
  return { name, coords };
}

function summarizeLocations(records) {
  const counts = new Map();
  records.forEach((record) => {
    const place = reportPlace(record && typeof record === 'object' ? record : {});
    if (!place) return;
    const key = place.name.toLocaleLowerCase();
    const previous = counts.get(key);
    if (previous) {
      previous.count += 1;
      if (!previous.coords && place.coords) previous.coords = place.coords;
    } else counts.set(key, { ...place, count: 1 });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function incidentTime(value) {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function severityOf(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const numeric = Number(normalized);
  if (normalized === 'critical' || numeric >= 5) return ['Critical', 'critical'];
  if (normalized === 'high' || numeric === 4) return ['High', 'high'];
  if (normalized === 'medium' || numeric === 3) return ['Medium', 'medium'];
  if (normalized === 'low' || numeric === 2) return ['Low', 'low'];
  if (normalized === 'info' || numeric === 1) return ['Info', 'info'];
  return [value || '—', ''];
}

function RecentIncidents({ feed, syncTone, pending, onAI }) {
  const result = feed?.all?.ok ? feed.all : feed?.latest?.ok ? feed.latest : null;
  const rows = (result ? recordsOf(result.data) : DEMO_WEB_INCIDENTS).slice(0, 5);
  const live = feed && feed.source !== 'cache' && feed.source !== 'offline' && Boolean(result);
  const cached = feed?.source === 'cache' && Boolean(result);
  const demo = !result;
  const syncLabel = syncTone === 'ok' ? 'Synced' : pending > 0 ? 'Pending' : syncTone === 'bad' ? 'Waiting' : 'Syncing';
  const syncClass = syncTone === 'ok' ? 'synced' : syncLabel === 'Waiting' ? 'waiting' : 'pending';
  return (
    <Panel
      title="Recent Incidents from Web Team"
      className="convergence-incidents-panel"
      actions={<div className="convergence-incidents-actions"><button type="button" className="btn btn-sm btn-ai" onClick={onAI}>AI Analytics</button><span className={`convergence-live-badge ${live ? 'live' : cached ? 'cached' : demo ? 'demo' : 'offline'}`}><i />{live ? 'Live' : cached ? 'Cached' : demo ? 'Demo data' : 'Offline'}</span></div>}
    >
      {rows.length ? <div className="table-wrap"><table className="convergence-incidents-table">
        <thead><tr><th>#</th><th>Incident ID</th><th>Title</th><th>Severity</th><th>Location</th><th>Created At</th><th>Sync Status</th><th aria-label="More" /></tr></thead>
        <tbody>{rows.map((row, index) => {
          const record = row && typeof row === 'object' ? row : { title: row };
          const id = fieldOf(record, ['incident_id', 'incidentId', 'report_id', 'id']);
          const title = fieldOf(record, ['title', 'description', 'incident_type', 'type', 'name']);
          const [severity, severityClass] = severityOf(fieldOf(record, ['severity', 'priority', 'risk_level']));
          const location = incidentLocation(fieldOf(record, ['location', 'city', 'district', 'address']));
          const created = fieldOf(record, ['created_at', 'createdAt', 'reported_at', 'timestamp', 'date', 'created']);
          return <tr key={id || index}>
            <td>{index + 1}</td><td className="incident-id">{id || '—'}</td><td className="incident-title">{title || '—'}</td>
            <td><span className={`incident-severity ${severityClass}`}>{severity}</span></td><td>{location}</td><td className="incident-time">{incidentTime(created)}</td>
            <td><span className={`incident-sync ${syncClass}`}><i />{syncLabel}</span></td><td className="incident-more">···</td>
          </tr>;
        })}</tbody>
      </table></div> : <div className="convergence-incidents-empty">No recent incidents.</div>}
    </Panel>
  );
}

const REGION_SYNC_DEMO = [
  { id: 'mum', total: 42, pending: 0, lastUpdate: '12:30:10', hash: '66bb5eed' },
  { id: 'hyd', total: 42, pending: 0, lastUpdate: '12:30:09', hash: '66bb5eed' },
  { id: 'sin', total: 42, pending: 0, lastUpdate: '12:30:08', hash: '66bb5eed' },
];

function RegionSyncStatus() {
  return (
    <Panel title="Region-wise Sync Status" className="convergence-region-status-panel">
      <div className="convergence-region-status-list">
        {REGION_SYNC_DEMO.map(({ id, total, pending: queued, lastUpdate, hash }) => (
          <article className={`convergence-region-status-row ${id}`} key={id}>
            <div className="convergence-region-status-identity">
              <span className="convergence-region-status-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="5" rx="1.5" /><rect x="5" y="14" width="14" height="5" rx="1.5" /><path d="M8 7.5h.01M8 16.5h.01" /></svg></span>
              <div className="convergence-region-status-name"><strong>{REGION[id].name}</strong><span>localhost:{8000 + NODES.indexOf(id) + 1}</span><small><i />Healthy</small></div>
            </div>
            <div className="convergence-region-status-value"><span>Total</span><strong>{total}</strong></div>
            <div className="convergence-region-status-value"><span>Pending</span><strong>{queued}</strong></div>
            <div className="convergence-region-status-value"><span>Last Update</span><strong>{lastUpdate}</strong></div>
            <div className="convergence-region-status-hash"><span>State Hash</span><strong>{hash}</strong></div>
          </article>
        ))}
      </div>
    </Panel>
  );
}

const SYNC_TIMELINE_DEMO = [
  { time: '12:30:12', text: 'Fetched 3 new incidents from Web Team (IDs: INC-106, INC-107, INC-108)', label: 'Fetch', tone: 'fetch' },
  { time: '12:30:13', text: 'Stored locally in Mumbai', label: 'Local Write', tone: 'write' },
  { time: '12:30:14', text: 'Replicated to Hyderabad', label: 'Replication', tone: 'replication' },
  { time: '12:30:15', text: 'Replicated to Singapore', label: 'Replication', tone: 'replication' },
  { time: '12:30:16', text: 'All regions converged (state hash: 66bb5eed)', label: 'Converged', tone: 'converged' },
];

function SynchronizationTimeline() {
  return (
    <Panel title="Synchronization Timeline" className="convergence-timeline-panel">
      <ol className="convergence-timeline">
        {SYNC_TIMELINE_DEMO.map((event) => (
          <li className={`convergence-timeline-row ${event.tone}`} key={event.time}>
            <time>{event.time}</time>
            <span className="convergence-timeline-marker" aria-hidden="true"><i /></span>
            <span className="convergence-timeline-text">{event.text}</span>
            <span className="convergence-timeline-tag">{event.label}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function DataFlowDiagram({ nodes }) {
  return (
    <div className="convergence-flow-scroll">
      <div className="convergence-flow-diagram">
        <div className="convergence-flow-source">
          <span className="convergence-flow-icon web"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="12" rx="1.5" /><path d="M9 20h6m-3-3v3" /></svg></span>
          <strong>Web Team</strong><span>Incident Platform<br />(ngrok API)</span>
        </div>
        <div className="convergence-flow-arrow"><span>Fetch<br />incidents</span><i /></div>
        <div className="convergence-flow-source resilsync">
          <span className="convergence-flow-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6-1.3A4.7 4.7 0 0 0 7 18Z" /></svg></span>
          <strong>Disaster Sync</strong><span>Replication Layer</span>
        </div>
        <div className="convergence-flow-fan"><i /><i /><i /></div>
        <div className="convergence-flow-regions">
          {NODES.map((id, index) => (
            <div className="convergence-flow-region" key={id}>
              <span className={`convergence-flow-dot ${nodes[id]?.status ? 'online' : ''}`} />
              <span><strong>{REGION[id].name}</strong><small>{index === 0 ? '(Primary)' : '(Replica)'}</small></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SyncMetric({ kind, label, value }) {
  const icon = kind === 'incidents'
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h6l5 5v13H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" /><path d="M14 3v5h5m-9 4h5m-5 4h6" /></svg>
    : kind === 'pending'
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      : kind === 'success'
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>;
  return <div className={`convergence-sync-metric ${kind}`}><span className="convergence-sync-icon">{icon}</span><span className="convergence-sync-copy"><small>{label}</small><strong>{value ?? '—'}</strong></span></div>;
}

function describe(nodes) {
  const available = NODES.filter((id) => nodes[id]?.status);
  if (available.length === 0) return { tone: 'bad', title: 'Waiting for region APIs', detail: 'The dashboard could not read any regional status endpoint.' };
  const hashes = new Set(available.map((id) => nodes[id].status.state_hash));
  if (available.length < NODES.length) {
    return { tone: 'warn', title: 'Partial cluster view', detail: `${available.length} of ${NODES.length} regions answered. Unavailable regions may have newer data.` };
  }
  if (hashes.size === 1) return { tone: 'ok', title: 'All regions have converged', detail: 'The live state hashes match across Mumbai, Hyderabad, and Singapore.' };
  return { tone: 'warn', title: 'Regions have not converged yet', detail: 'Different live state hashes mean one or more updates are still waiting to replicate.' };
}

function readRegion(url) {
  return Promise.all([
    api.status(url),
    api.recovery(url).catch((error) => ({ error: error.message, episodes: [], in_progress: [] })),
  ]).then(([status, recovery]) => ({ status, recovery }));
}

export default function Convergence({ urls, analyticsPage = false, onOpenAnalytics, onBack }) {
  const [snapshot, setSnapshot] = useState({ nodes: {}, at: 0 });
  const [timeRange, setTimeRange] = useState('1h');
  const [incidentFeed, setIncidentFeed] = useState(null);
  const key = JSON.stringify(urls);

  useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const entries = await Promise.all(NODES.map(async (id) => {
        try { return [id, await readRegion(urls[id])]; }
        catch (error) { return [id, { error: error.message }]; }
      }));
      busy = false;
      if (alive) setSnapshot({ nodes: Object.fromEntries(entries), at: Date.now() });
    };
    setSnapshot({ nodes: {}, at: 0 });
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const state = useMemo(() => describe(snapshot.nodes), [snapshot.nodes]);
  const recoveryHistory = useMemo(() => NODES.flatMap((id) => snapshot.nodes[id]?.recovery?.episodes || []), [snapshot.nodes]);
  const ready = NODES.filter((id) => snapshot.nodes[id]?.status);
  const pending = ready.reduce((sum, id) => sum + (snapshot.nodes[id].status.peers || []).reduce((n, peer) => n + (peer.pending_out || 0), 0), 0);
  const hasIncidentFeed = Boolean(incidentFeed?.all?.ok || incidentFeed?.latest?.ok);
  const analysisRecords = useMemo(() => (
    incidentFeed?.all?.ok ? recordsOf(incidentFeed.all.data)
      : incidentFeed?.latest?.ok ? recordsOf(incidentFeed.latest.data)
        : DEMO_WEB_INCIDENTS
  ), [incidentFeed]);
  const totalIncidents = incidentFeed?.all?.ok ? recordsOf(incidentFeed.all.data).length : DEMO_TOTAL_INCIDENTS;
  const syncSuccess = recoveryHistory.filter((episode) => episode.status === 'recovered' && !(episode.failed || 0)).length;
  const syncFailed = recoveryHistory.reduce((sum, episode) => sum + (episode.failed || 0), 0);
  if (analyticsPage) return <Suspense fallback={<div className="convergence-analytics-loading">Loading incident analytics map…</div>}><LocationAnalytics records={analysisRecords} isDemo={!hasIncidentFeed} onClose={onBack} /></Suspense>;
  return (
    <div className="stack convergence-page">
      <header className="convergence-page-head">
        <div>
          <h1>Convergence</h1>
          <p>Web Team Incident Reports <span>→</span> Regional Replication <span>→</span> Data Consistency</p>
        </div>
        <div className="convergence-range" role="group" aria-label="Time range">
          {[['1h', 'Last 1 hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours']].map(([value, label]) => (
            <button key={value} type="button" aria-pressed={timeRange === value} onClick={() => setTimeRange(value)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="convergence-overview-grid">
        <Panel title="Data Flow" className="convergence-flow-panel">
          <DataFlowDiagram nodes={snapshot.nodes} />
        </Panel>
        <Panel title="Overall Sync Status" className="convergence-sync-panel">
          <div className={`convergence-sync-status ${state.tone}`}>
            <span className="convergence-sync-check"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg></span>
            <span><strong>{state.tone === 'ok' ? 'Converged' : state.tone === 'warn' ? 'Synchronizing' : 'Waiting for regions'}</strong><small>{state.tone === 'ok' ? 'All regions have processed the latest incidents from Web team' : state.detail}</small></span>
          </div>
          <div className="convergence-sync-metrics">
            <SyncMetric kind="incidents" label="Total Incidents" value={totalIncidents} />
            <SyncMetric kind="pending" label="Pending Sync" value={ready.length ? pending : '—'} />
            <SyncMetric kind="success" label="Sync Success" value={syncSuccess} />
            <SyncMetric kind="failed" label="Sync Failed" value={syncFailed} />
          </div>
        </Panel>
      </div>

      <WebIncidentFeed onFeed={setIncidentFeed} />
      <RecentIncidents feed={incidentFeed} syncTone={state.tone} pending={pending} onAI={() => { if (onOpenAnalytics) onOpenAnalytics(); else { window.location.hash = 'analytics'; window.dispatchEvent(new HashChangeEvent('hashchange')); } }} />
      <RegionSyncStatus />
      <SynchronizationTimeline />
    </div>
  );
}
