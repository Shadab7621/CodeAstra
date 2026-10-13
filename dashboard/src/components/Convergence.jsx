import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { shortHash } from '../lib';
import Panel from './Panel';

const POLL_MS = 2500;
const WEB_REFRESH_MS = 30000;
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

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function IncidentTable({ title, host, result }) {
  const rows = result?.ok ? recordsOf(result.data) : [];
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row && typeof row === 'object' ? row : { value: row })))];
  return (
    <section className="web-feed-section">
      <header><strong>{title}</strong><span>{host || 'Endpoint not configured'}</span></header>
      {!result ? <p className="muted">Loading feed…</p>
        : !result.ok ? <p className="bad-text">{result.error || 'Feed request failed.'}</p>
          : rows.length === 0 ? <p className="muted">No incidents returned.</p>
            : <div className="table-wrap"><table className="web-feed-table">
              <thead><tr>{columns.map((column) => <th key={column}>{column.replaceAll('_', ' ')}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 25).map((row, index) => {
                const values = row && typeof row === 'object' ? row : { value: row };
                return <tr key={row?.id || row?.incident_id || index}>{columns.map((column) => <td key={column}>{valueText(values[column])}</td>)}</tr>;
              })}</tbody>
            </table></div>}
      {rows.length > 25 && <p className="web-feed-foot">Showing 25 of {rows.length} records.</p>}
      {result?.data !== undefined && <details className="web-feed-raw"><summary>View raw response</summary><pre>{JSON.stringify(result.data, null, 2)}</pre></details>}
    </section>
  );
}

function WebIncidentFeed() {
  const [feed, setFeed] = useState(null);
  const [hosts, setHosts] = useState({});
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState('');

  useEffect(() => {
    let alive = true;
    const loadHosts = async () => {
      try {
        const response = await fetch(`${WEB_PROXY}/api/config`);
        if (!response.ok) throw new Error(`Proxy answered HTTP ${response.status}`);
        const data = await response.json();
        if (alive) setHosts(data);
      } catch (error) {
        if (alive) setLastError(error.message || 'Could not reach the Web API proxy.');
      }
    };
    loadHosts();
    return () => { alive = false; };
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${WEB_PROXY}/api/fetch`, { method: 'POST', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Proxy answered HTTP ${response.status}`);
      const data = await response.json();
      setFeed(data);
      setLastError('');
    } catch (error) {
      setLastError(error.message || 'Could not reach the Web API proxy.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, WEB_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const isCache = feed?.source === 'cache';
  const isLive = feed && feed.source !== 'cache' && (feed.all?.ok || feed.latest?.ok);
  return (
    <Panel
      title="Web team incident feed"
      hint="Read-only incident data fetched through the Web team’s ngrok API tunnel."
      actions={<><span className={`pill ${isLive ? 'ok' : isCache ? 'warn' : 'bad'}`}>{isLive ? 'Live API' : isCache ? 'Cached copy' : 'Waiting for API'}</span><button className="btn btn-sm" onClick={refresh} disabled={busy}>{busy ? 'Fetching…' : 'Fetch now'}</button></>}
    >
      <div className="web-feed-meta">
        <span>{feed?.fetched_at ? `Fetched ${new Date(feed.fetched_at).toLocaleString()}` : 'Waiting for first fetch'}</span>
        <span>Refreshes every {WEB_REFRESH_MS / 1000}s</span>
      </div>
      {isCache && <div className="web-feed-notice">The ngrok API could not be reached. Showing the last saved response from {feed.cached_from ? new Date(feed.cached_from).toLocaleString() : 'an earlier request'}.</div>}
      {!feed && lastError && <div className="web-feed-notice error">{lastError}. Start the Convergence proxy with <code>node convergence/server.js</code> and configure its <code>.env</code>.</div>}
      <IncidentTable title="Latest incident" host={hosts.latest} result={feed?.latest} />
      <IncidentTable title="All incidents" host={hosts.all} result={feed?.all} />
    </Panel>
  );
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
    api.heads(url).catch((error) => ({ error: error.message })),
    api.recovery(url).catch((error) => ({ error: error.message, episodes: [], in_progress: [] })),
  ]).then(([status, heads, recovery]) => ({ status, heads, recovery }));
}

function recoveryRows(nodes) {
  return NODES.flatMap((id) => {
    const recovery = nodes[id]?.recovery;
    if (!recovery) return [];
    return [
      ...(recovery.in_progress || []).map((episode) => ({ region: id, episode, active: true })),
      ...(recovery.episodes || []).map((episode) => ({ region: id, episode, active: false })),
    ];
  }).sort((a, b) => (b.episode.recovered_at || b.episode.reconnected_at || 0) - (a.episode.recovered_at || a.episode.reconnected_at || 0));
}

function timestamp(seconds) {
  if (!seconds) return 'Time unavailable';
  return new Date(seconds * 1000).toLocaleString();
}

export default function Convergence({ urls, env }) {
  const [snapshot, setSnapshot] = useState({ nodes: {}, at: 0 });
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
  const recoveries = useMemo(() => recoveryRows(snapshot.nodes).slice(0, 12), [snapshot.nodes]);
  const ready = NODES.filter((id) => snapshot.nodes[id]?.status);
  const pending = ready.reduce((sum, id) => sum + (snapshot.nodes[id].status.peers || []).reduce((n, peer) => n + (peer.pending_out || 0), 0), 0);
  const matchingHeads = useMemo(() => {
    const seen = new Map();
    let comparable = 0;
    let mismatch = 0;
    for (const id of NODES) {
      const heads = snapshot.nodes[id]?.heads?.heads;
      if (!heads) continue;
      for (const [origin, head] of Object.entries(heads)) {
        const key = `${origin}:${head.seq}`;
        if (seen.has(key)) {
          comparable += 1;
          if (seen.get(key) !== head.hash) mismatch += 1;
        } else seen.set(key, head.hash);
      }
    }
    return { comparable, mismatch };
  }, [snapshot.nodes]);

  return (
    <div className="stack convergence-page">
      <Panel title="Cluster agreement" hint={`Reading the ${env} cluster APIs · refreshes every ${POLL_MS / 1000} seconds`}>
        <div className={`convergence-banner ${state.tone}`}>
          <span className={`dot ${state.tone}`} />
          <div><strong>{state.title}</strong><p>{state.detail}</p></div>
          <span className="spacer" />
          <span className="convergence-sampled">{snapshot.at ? `Updated ${new Date(snapshot.at).toLocaleTimeString()}` : 'Connecting…'}</span>
        </div>
        <div className="convergence-metrics">
          <div><span>Regions responding</span><strong>{ready.length} / {NODES.length}</strong></div>
          <div><span>Changes awaiting send</span><strong>{ready.length ? pending : '—'}</strong></div>
          <div><span>Comparable history heads</span><strong>{matchingHeads.comparable || '—'}</strong></div>
          <div><span>Head hash mismatches</span><strong className={matchingHeads.mismatch ? 'bad-text' : ''}>{matchingHeads.comparable ? matchingHeads.mismatch : '—'}</strong></div>
        </div>
      </Panel>

      <WebIncidentFeed />

      <Panel title="Regional state" hint="State hashes summarize current report data; equal hashes indicate matching state.">
        <div className="convergence-regions">
          {NODES.map((id) => {
            const node = snapshot.nodes[id];
            const status = node?.status;
            const peers = status?.peers || [];
            const queue = peers.reduce((sum, peer) => sum + (peer.pending_out || 0), 0);
            return (
              <article className="convergence-region" key={id}>
                <header><strong>{REGION[id].name}</strong><span className={`pill ${status ? 'ok' : 'bad'}`}>{status ? 'Online' : node?.error || 'Connecting'}</span></header>
                <div className="convergence-region-stats">
                  <div><span>Events</span><b>{status ? status.event_count : '—'}</b></div>
                  <div><span>Waiting to send</span><b>{status ? queue : '—'}</b></div>
                </div>
                <div className="convergence-hash"><span>State hash</span><code title={status?.state_hash}>{status ? shortHash(status.state_hash) : 'Unavailable'}</code></div>
                <div className="convergence-api" title={urls[id]}>{urls[id]}</div>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel title="Recovery history" hint="Recovery episodes are read from each node’s /recovery endpoint.">
        {recoveries.length === 0 ? (
          <div className="convergence-empty">{ready.length ? 'No completed or active recovery episodes have been reported yet.' : 'Waiting for a regional API to return recovery data.'}</div>
        ) : (
          <div className="convergence-recoveries">
            {recoveries.map(({ region, episode }, index) => (
              <article className="convergence-recovery" key={`${region}-${episode.peer}-${episode.outage_started_at}-${index}`}>
                <span className={`dot ${episode.status === 'recovered' ? 'ok' : 'warn'}`} />
                <div className="convergence-recovery-main">
                  <strong>{REGION[region].name} ↔ {REGION[episode.peer]?.name || episode.peer}</strong>
                  <span>{episode.summary || (episode.status === 'recovering' ? 'Connection restored; synchronization is in progress.' : 'Recovery completed.')}</span>
                </div>
                <time>{timestamp(episode.recovered_at || episode.reconnected_at)}</time>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
