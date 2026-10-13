import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import { relativeTime } from '../lib';
import { nodeHealth } from './Regions';

const POLL_MS = 2000;
const FETCH_LIMIT = 200;

const REGION_META = {
  mum: { index: 1, continent: 'Asia' },
  hyd: { index: 2, continent: 'Asia' },
  sin: { index: 3, continent: 'Asia' },
};

const ListIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19" />
  </svg>
);

const LinkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const ZapIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const FileTextIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

const ClockIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);


const GlobeIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const SearchIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const GROUPS = [
  { value: 'all', label: 'All', icon: ListIcon, kinds: null },
  { value: 'writes', label: 'Writes', icon: EditIcon, kinds: ['write', 'resolve'] },
  { value: 'sync', label: 'Sync', icon: RefreshIcon, kinds: ['sync', 'recovery'] },
  { value: 'links', label: 'Links', icon: LinkIcon, kinds: ['link'] },
  { value: 'conflicts', label: 'Conflicts', icon: AlertIcon, kinds: ['conflict'] },
  { value: 'faults', label: 'Faults', icon: ZapIcon, kinds: ['pause', 'resume', 'clock', 'reset', 'startup'] },
];

const KIND_LABEL = {
  write: 'Write', resolve: 'Resolved', sync: 'Sync', recovery: 'Recovery', link: 'Link',
  conflict: 'Conflict', pause: 'Paused', resume: 'Resumed', clock: 'Clock', reset: 'Reset',
  startup: 'Started',
};

/** "Today" / "Yesterday" / "13 Oct", with the time in the viewer's own clock and 12-hour style. */
const stamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: '', time: '' };
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return { day, time };
};

/**
 * Reads one region's log. The region's own node answers first; if it cannot (it is down),
 * any other node can serve the same log from Atlas, so a crashed region stays inspectable.
 */
function useRegionLogs(urls, region) {
  const [state, setState] = useState({ entries: null, source: null, storage: null, via: null, error: null });
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const key = `${region}|${JSON.stringify(urls)}|${tick}`;

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

  return { ...state, reload };
}

export default function RegionLogs({ urls, meta, region, onRegion }) {
  const { nodes } = useCluster(urls);
  const { entries, storage, error, reload } = useRegionLogs(urls, region);
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const seen = useRef(new Set());
  const [fresh, setFresh] = useState(new Set());

  const kinds = GROUPS.find((g) => g.value === group)?.kinds;
  const shown = useMemo(() => {
    let list = entries || [];
    if (kinds) list = list.filter((e) => kinds.includes(e.kind));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((e) => (
        (e.message && e.message.toLowerCase().includes(q)) ||
        (e.kind && e.kind.toLowerCase().includes(q))
      ));
    }
    return list;
  }, [entries, kinds, search]);

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

  useEffect(() => {
    seen.current = new Set();
    setFresh(new Set());
  }, [region]);

  const node = nodes[region];
  const nodeUp = node && node.state === 'up';
  const health = nodeHealth(node);
  const regionInfo = REGION_META[region] || { index: 1, continent: 'Asia' };
  const eventCount = node?.status?.event_count ?? (entries ? entries.length : 0);
  const lastUpdatedText = entries && entries.length > 0 ? relativeTime(entries[0].ts) : '—';

  return (
    <div className="stack">
      <div className="rl-card">
        {/* Row 1: Region Identity & Region Pills */}
        <div className="rl-header-row">
          <div className="rl-region-identity">
            <div className="rl-globe-box" aria-hidden="true">
              <GlobeIcon />
            </div>
            <div className="rl-title-box">
              <div className="rl-main-title">
                <span>{REGION[region].name} ({nodeUp ? 'Active' : 'Offline'})</span>
              </div>
              <div className="rl-sub-meta">
                Region {regionInfo.index} • {regionInfo.continent}
              </div>
            </div>
          </div>

          <div className="rl-region-pills" role="tablist" aria-label="Select Region">
            {NODES.map((n) => {
              const active = n === region;
              return (
                <button
                  key={n}
                  type="button"
                  className={`rl-region-pill-btn ${active ? 'active' : ''}`}
                  onClick={() => onRegion(n)}
                  role="tab"
                  aria-selected={active}
                >
                  {active && <span className="rl-pill-dot" />}
                  <span>{REGION[n].name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Row 2: Metrics and Search Bar */}
        <div className="rl-stats-bar">
          <div className="rl-stats-left">
            <div className="rl-health-group">
              <span className="rl-health-pill">
                <span className={`dot ${health.tone} ${nodeUp ? 'live' : ''}`} />
                {health.text}
              </span>
              <span className="rl-provider-chip">
                {meta[region]?.provider || 'Local'}
              </span>
            </div>

            <div className="rl-vdiv" aria-hidden="true" />

            <div className="rl-metric-item">
              <div className="rl-metric-icon is-events">
                <FileTextIcon />
              </div>
              <div className="rl-metric-text">
                <span className="rl-metric-val">{eventCount}</span>
                <span className="rl-metric-lbl">Total events</span>
              </div>
            </div>

            <div className="rl-vdiv" aria-hidden="true" />

            <div className="rl-metric-item">
              <div className="rl-metric-icon is-clock">
                <ClockIcon />
              </div>
              <div className="rl-metric-text">
                <span className="rl-metric-lbl">Last updated</span>
                <span className="rl-metric-val">{lastUpdatedText}</span>
              </div>
            </div>
          </div>

          <div className="rl-search-box">
            <SearchIcon />
            <input
              type="text"
              placeholder="Search log events..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rl-search-input"
              aria-label="Search log events"
            />
            {search && (
              <button
                type="button"
                className="rl-search-clear"
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Row 3: Filter Chips */}
        <div className="rl-filter-row" role="tablist" aria-label="Filter events by kind">
          {GROUPS.map((g) => {
            const Icon = g.icon;
            const active = group === g.value;
            return (
              <button
                key={g.value}
                type="button"
                className={`rl-filter-chip ${active ? 'active' : ''}`}
                onClick={() => setGroup(g.value)}
                role="tab"
                aria-selected={active}
              >
                <Icon />
                <span>{g.label}</span>
              </button>
            );
          })}
        </div>

        {/* Row 4: Log Entries or Empty State */}
        {entries === null ? (
          <div className="rl-empty-container">
            <h3 className="rl-empty-heading">
              {error ? `Could not read the log: ${error}` : 'Loading logs...'}
            </h3>
            <p className="rl-empty-caption">
              Connecting to {REGION[region].name} service endpoint...
            </p>
            <button type="button" className="rl-retry-btn" onClick={reload}>
              <RefreshIcon />
              <span>Retry loading logs</span>
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="rl-empty-container">
            <div className="rl-empty-art" aria-hidden="true">
              <svg width="68" height="68" viewBox="0 0 68 68" fill="none">
                <path d="M21 20L16 18" stroke="#93c5fd" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M19 28L14 29" stroke="#93c5fd" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M47 20L52 18" stroke="#93c5fd" strokeWidth="2.5" strokeLinecap="round" />
                <path d="M49 28L54 29" stroke="#93c5fd" strokeWidth="2.5" strokeLinecap="round" />
                <rect x="23" y="16" width="22" height="32" rx="4" fill="#eff6ff" stroke="#3b82f6" strokeWidth="2.5" />
                <line x1="28" y1="24" x2="34" y2="24" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />
                <line x1="28" y1="30" x2="40" y2="30" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />
                <line x1="28" y1="36" x2="36" y2="36" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="rl-empty-heading">
              {search ? 'No matching log entries' : 'No log entries found'}
            </h3>
            <p className="rl-empty-caption">
              {search ? (
                <>No log events in {REGION[region].name} match "{search}". Try clearing your search.</>
              ) : (
                <>
                  This region hasn't returned any log events yet.<br />
                  Check the service connection or choose another region.
                </>
              )}
            </p>
            <button
              type="button"
              className="rl-retry-btn"
              onClick={search ? () => setSearch('') : reload}
            >
              <RefreshIcon />
              <span>{search ? 'Clear search' : 'Retry loading logs'}</span>
            </button>
          </div>
        ) : (
          <div className="rl-list-container">
            <ol className="log-list" aria-label={`${REGION[region].name} activity log`}>
              {shown.map((e) => (
                <motion.li
                  key={e.id}
                  layout="position"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  className={`log-row ${e.level} ${fresh.has(e.id) ? 'flash' : ''}`}
                >
                  <time className="log-time" dateTime={e.ts} title={new Date(e.ts).toLocaleString()}>
                    <strong>{stamp(e.ts).time}</strong>
                    <span>{stamp(e.ts).day}</span>
                  </time>
                  <span className={`log-kind k-${e.kind} ${e.level}`}>{KIND_LABEL[e.kind] || e.kind}</span>
                  <span className="log-message">{e.message}</span>
                  <span className="log-ago muted">{relativeTime(e.ts)}</span>
                </motion.li>
              ))}
            </ol>
            <footer className="log-foot muted" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                {shown.length} of {entries.length} recent entries
                {storage && storage.queued > 0 ? ` · ${storage.queued} waiting to be saved to Atlas` : ''}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={reload}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <RefreshIcon />
                <span>Refresh</span>
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
