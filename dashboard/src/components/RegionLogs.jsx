import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import { relativeTime } from '../lib';
import { ProviderBadge, nodeHealth } from './Regions';
import Panel from './Panel';
import { Segmented } from './TopBar';

const POLL_MS = 2000;
const FETCH_LIMIT = 200;

const GROUPS = [
  { value: 'all', label: 'All', kinds: null },
  { value: 'writes', label: 'Writes', kinds: ['write', 'resolve'] },
  { value: 'sync', label: 'Sync', kinds: ['sync', 'recovery'] },
  { value: 'links', label: 'Links', kinds: ['link'] },
  { value: 'conflicts', label: 'Conflicts', kinds: ['conflict'] },
  { value: 'faults', label: 'Faults', kinds: ['pause', 'resume', 'clock', 'reset', 'startup'] },
];

const KIND_LABEL = {
  write: 'Write', resolve: 'Resolved', sync: 'Sync', recovery: 'Recovery', link: 'Link',
  conflict: 'Conflict', pause: 'Paused', resume: 'Resumed', clock: 'Clock', reset: 'Reset',
  startup: 'Started',
};

const clock = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

/**
 * Reads one region's log. The region's own node answers first; if it cannot (it is down),
 * any other node can serve the same log from Atlas, so a crashed region stays inspectable.
 */
function useRegionLogs(urls, region) {
  const [state, setState] = useState({ entries: null, source: null, storage: null, via: null, error: null });
  const key = `${region}|${JSON.stringify(urls)}`;

  useEffect(() => {
    let alive = true;
    let busy = false;
    setState({ entries: null, source: null, storage: null, via: null, error: null });

    const load = async () => {
      if (busy) return;
      busy = true;
      const order = [region, ...NODES.filter((n) => n !== region)];
      let result = null;
      let lastError = null;
      for (const via of order) {
        try {
          const data = await api.logs(urls[via], { region, limit: FETCH_LIMIT });
          // A node that is not the region only helps when it reads the shared Atlas log.
          if (via !== region && data.source !== 'atlas') continue;
          result = { data, via };
          break;
        } catch (err) {
          lastError = err;
        }
      }
      busy = false;
      if (!alive) return;
      if (result) {
        setState({ entries: result.data.entries, source: result.data.source, storage: result.data.storage, via: result.via, error: null });
      } else {
        setState((s) => ({ ...s, error: lastError ? lastError.message : 'No region answered' }));
      }
    };

    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

function SourceBadge({ source, storage, via, region }) {
  if (!source) return null;
  const atlas = source === 'atlas';
  const detail = atlas
    ? `Stored in MongoDB Atlas${via && via !== region ? `, read through ${REGION[via].name}` : ''}`
    : storage && storage.backend === 'atlas'
      ? 'Atlas is unreachable, showing this region\'s recent in-memory log'
      : 'No Atlas connection configured, showing this region\'s in-memory log';
  return (
    <span className={`pill ${atlas ? 'ok' : 'warn'}`} title={detail}>
      {atlas ? 'MongoDB Atlas' : 'Local memory'}
    </span>
  );
}

export default function RegionLogs({ urls, meta, region, onRegion }) {
  const { nodes } = useCluster(urls);
  const { entries, source, storage, via, error } = useRegionLogs(urls, region);
  const [group, setGroup] = useState('all');
  const seen = useRef(new Set());
  const [fresh, setFresh] = useState(new Set());

  const kinds = GROUPS.find((g) => g.value === group).kinds;
  const shown = useMemo(
    () => (entries || []).filter((e) => !kinds || kinds.includes(e.kind)),
    [entries, kinds],
  );

  // Briefly highlight entries that arrived since the last refresh.
  useEffect(() => {
    if (!entries) return undefined;
    const added = new Set();
    for (const e of entries) {
      if (seen.current.size > 0 && !seen.current.has(e.id)) added.add(e.id);
      seen.current.add(e.id);
    }
    if (added.size === 0) return undefined;
    setFresh(added);
    const t = setTimeout(() => setFresh(new Set()), 1400);
    return () => clearTimeout(t);
  }, [entries]);
  useEffect(() => { seen.current = new Set(); setFresh(new Set()); }, [region]);

  const health = nodeHealth(nodes[region]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Region logs</h1>
          <p className="page-sub">
            What each region did, in order: writes, links cut and restored, sync, conflicts and recoveries.
            Every entry is saved to MongoDB Atlas, so a crashed region&apos;s history is still here.
          </p>
        </div>
      </div>

      <Panel
        title={`${REGION[region].name} activity`}
        hint={`${meta[region].regionCode} · ${meta[region].provider}`}
        flush
        actions={(
          <>
            <SourceBadge source={source} storage={storage} via={via} region={region} />
            <Segmented
              id="log-region" label="Region" value={region} onChange={onRegion}
              options={NODES.map((n) => ({ value: n, label: REGION[n].name }))}
            />
          </>
        )}
      >
        <div className="log-toolbar">
          <span className="log-state">
            <span className={`dot ${health.tone} ${nodes[region] && nodes[region].state === 'up' ? 'live' : ''}`} />
            {health.text}
            <ProviderBadge provider={meta[region].provider} />
          </span>
          <span className="spacer" />
          <Segmented id="log-group" label="Filter" value={group} onChange={setGroup}
            options={GROUPS.map((g) => ({ value: g.value, label: g.label }))} />
        </div>

        {entries === null ? (
          <div className="empty">{error ? `Could not read the log: ${error}` : 'Loading the log...'}</div>
        ) : shown.length === 0 ? (
          <div className="empty">
            {entries.length === 0 ? 'Nothing recorded yet. Add to the cart or cut a link to see entries here.' : 'No entries match this filter.'}
          </div>
        ) : (
          <ol className="log-list" aria-label={`${REGION[region].name} activity log`}>
            {shown.map((e) => (
              <motion.li
                key={e.id} layout="position"
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={`log-row ${e.level} ${fresh.has(e.id) ? 'flash' : ''}`}
              >
                <time className="log-time mono" dateTime={e.ts} title={e.ts}>{clock(e.ts)}</time>
                <span className={`log-kind ${e.level}`}>{KIND_LABEL[e.kind] || e.kind}</span>
                <span className="log-message">{e.message}</span>
                <span className="log-ago muted">{relativeTime(e.ts)}</span>
              </motion.li>
            ))}
          </ol>
        )}

        <footer className="log-foot muted">
          {entries ? `${shown.length} of ${entries.length} recent entries` : ''}
          {storage && storage.queued > 0 ? ` · ${storage.queued} waiting to be saved to Atlas` : ''}
        </footer>
      </Panel>
    </div>
  );
}
