import { motion } from 'motion/react';
import { RESERVATIONS_ENABLED } from '../cart';
import { NODES, REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';
import { offsetLabel, shortHash } from '../lib';
import DecryptedText from '../reactbits/DecryptedText';
import Panel from './Panel';
import Topology from './Topology';

export const PAIRS = [['mum', 'hyd'], ['mum', 'sin'], ['hyd', 'sin']];

export function linkState(nodes, a, b) {
  const A = nodes[a];
  const B = nodes[b];
  if (!A || !B || A.state !== 'up' || B.state !== 'up') return 'unknown';
  const blocked = (X, id) => (X.status.peers || []).some((p) => p.id === id && p.blocked);
  return blocked(A, b) || blocked(B, a) ? 'cut' : 'ok';
}

export const allLinks = (nodes) => Object.fromEntries(PAIRS.map(([a, b]) => [`${a}-${b}`, linkState(nodes, a, b)]));

export function nodeHealth(node) {
  if (!node) return { tone: '', text: 'Connecting' };
  if (node.state === 'up') return { tone: 'ok', text: 'Healthy' };
  if (node.state === 'paused') return { tone: 'warn', text: 'Paused (simulated crash)' };
  return { tone: 'bad', text: 'Unreachable' };
}

/** One sentence on whether the regions agree. */
export function syncSummary(nodes) {
  const up = NODES.filter((n) => nodes[n] && nodes[n].state === 'up');
  const hashes = new Set(up.map((n) => nodes[n].status.state_hash));
  const missing = NODES.length - up.length;
  if (!NODES.every((n) => nodes[n])) return { tone: 'warn', text: 'Connecting to the regions', detail: '' };
  if (up.length === 0) return { tone: 'bad', text: 'No region is reachable', detail: 'Check that the cluster is running' };
  if (hashes.size === 1 && missing === 0) return { tone: 'ok', text: 'All regions are in sync', detail: `${up.length} regions hold identical state` };
  if (hashes.size === 1) return { tone: 'warn', text: `${missing} region${missing > 1 ? 's' : ''} unreachable`, detail: 'The rest are in sync' };
  return { tone: 'warn', text: 'Regions differ', detail: 'Writes are waiting to be exchanged' };
}

/**
 * How one region is doing from its own point of view.
 * normal: it reaches every peer. degraded: some links are down but it still reaches a peer.
 * isolated: it reaches nobody. offline: the node itself is paused or down.
 */
export function regionMode(nodes, id) {
  const node = nodes[id];
  if (!node) return { mode: 'connecting', label: 'Connecting', tone: '', lost: [], staleMs: null };
  if (node.state !== 'up') return { mode: 'offline', label: 'Offline', tone: 'bad', lost: [], staleMs: null };
  const peers = node.status.peers || [];
  const lost = peers.filter((p) => !p.reachable || p.blocked);
  const staleMs = lost.reduce((m, p) => (p.last_sync_ms_ago == null ? m : Math.max(m ?? 0, p.last_sync_ms_ago)), null);
  if (lost.length === 0) return { mode: 'normal', label: 'Normal', tone: 'ok', lost, staleMs: null };
  if (lost.length >= peers.length) return { mode: 'isolated', label: 'Isolated', tone: 'bad', lost, staleMs };
  return { mode: 'degraded', label: 'Degraded', tone: 'warn', lost, staleMs };
}

const ago = (ms) => {
  if (ms == null) return 'a while';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
};

/** What the whole cluster is doing, in plain words: what keeps working and what is limited. */
export function DegradationBanner({ nodes }) {
  const modes = NODES.map((id) => ({ id, ...regionMode(nodes, id) }));
  if (modes.some((m) => m.mode === 'connecting')) return null;
  const isolated = modes.filter((m) => m.mode === 'isolated');
  const degraded = modes.filter((m) => m.mode === 'degraded');
  const offline = modes.filter((m) => m.mode === 'offline');
  const waiting = NODES.reduce((n, id) => {
    const node = nodes[id];
    return n + (node && node.state === 'up' ? (node.status.peers || []).reduce((a, p) => a + (p.pending_out || 0), 0) : 0);
  }, 0);

  if (isolated.length === 0 && degraded.length === 0 && offline.length === 0) {
    return (
      <div className="degrade ok">
        <span className="dot ok live" />
        <strong>Normal operation</strong>
        <span className="muted">All {NODES.length} regions are connected. Every write is replicated within a second.</span>
      </div>
    );
  }

  const level = isolated.length || offline.length ? 'bad' : 'warn';
  const title = isolated.length
    ? `Isolated: ${isolated.map((m) => REGION[m.id].name).join(', ')}`
    : offline.length
      ? `Offline: ${offline.map((m) => REGION[m.id].name).join(', ')}`
      : `Degraded: ${degraded.length} region${degraded.length > 1 ? 's' : ''} lost a link`;
  const stale = [...isolated, ...degraded].filter((m) => m.staleMs != null);

  return (
    <div className={`degrade ${level}`} role="status">
      <div className="degrade-head">
        <span className={`dot ${level}`} />
        <strong>{title}</strong>
        <span className="muted">The service keeps running. It trades some freshness for availability until the links return.</span>
      </div>
      <div className="degrade-cols">
        <div>
          <div className="degrade-k">Keeps working</div>
          <ul>
            <li>Reading and writing in every region that is up</li>
            <li>Cart adds and quantity edits, stored locally and merged on reconnect</li>
            <li>History, audit chain and conflict ledger</li>
          </ul>
        </div>
        <div>
          <div className="degrade-k">Limited until reconnect</div>
          <ul>
            <li>
              {RESERVATIONS_ENABLED
                ? 'Stock-limited items: each region sells only its reserved share (a third of what was left when the link dropped), so nothing is oversold'
                : 'Stock is counted from each region\'s own view, so two regions can sell the same last units. The overlap is found and trimmed after reconnect'}
            </li>
            {stale.map((m) => (
              <li key={m.id}>{REGION[m.id].name}'s view of its cut-off peers is up to {ago(m.staleMs)} old</li>
            ))}
            {waiting > 0 && <li>{waiting} change{waiting === 1 ? '' : 's'} waiting to be sent</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function ProviderBadge({ provider }) {
  return <span className="provider" style={{ '--p': PROVIDER_COLOR[provider] || PROVIDER_COLOR.Local }}>{provider}</span>;
}

function RegionCard({ id, node, nodes, meta, canAct, onPause, onResume, onSkew }) {
  const health = nodeHealth(node);
  const up = node && node.state === 'up';
  const s = up ? node.status : null;
  const pending = up ? (s.peers || []).reduce((n, p) => n + (p.pending_in || 0) + (p.pending_out || 0), 0) : 0;
  const skewed = up && s.clock_offset_ms;
  const hash = up ? shortHash(s.state_hash) : '';
  const mode = regionMode(nodes, id);

  return (
    <motion.div layout className={`region ${up ? '' : 'is-down'}`}>
      <div className="region-head">
        <span className="region-name">{REGION[id].name}</span>
        <span className="spacer" />
        <ProviderBadge provider={meta.provider} />
      </div>
      <div className="region-code mono">{meta.regionCode}</div>
      <div className="status-line">
        <span className={`dot ${health.tone} ${up ? 'live' : ''}`} />
        {health.text}
        <span className="spacer" />
        {up && <span className="muted num" style={{ fontWeight: 500 }}>{node.rtt} ms</span>}
      </div>
      <div className="region-mode">
        <span className={`pill ${mode.tone}`}>{mode.label}</span>
        {up && mode.lost.length > 0 && (
          <span className="muted">
            {mode.lost.length} link{mode.lost.length > 1 ? 's' : ''} down
            {mode.staleMs != null ? `, data up to ${ago(mode.staleMs)} old` : ''}
          </span>
        )}
      </div>
      <div className="metrics">
        <div className="metric"><span className="k">Events</span><span className="v">{up ? s.event_count : '-'}</span></div>
        <div className="metric"><span className="k">Waiting to sync</span><span className="v">{up ? pending : '-'}</span></div>
        <div className="metric">
          <span className="k">State hash</span>
          <span className="v mono">{up ? <DecryptedText key={hash} text={hash} animateOn="view" speed={40} maxIterations={12} sequential /> : '-'}</span>
        </div>
        <div className="metric"><span className="k">Clock</span><span className="v" style={skewed ? { color: 'var(--warn)' } : undefined}>{up ? offsetLabel(s.clock_offset_ms) : '-'}</span></div>
      </div>
      <div className="region-actions">
        {node && node.state === 'paused' ? (
          <button className="btn btn-sm btn-primary" disabled={!canAct} onClick={() => onResume(id)}>Resume</button>
        ) : (
          <button className="btn btn-sm" disabled={!canAct || !up} onClick={() => onPause(id)}>Simulate crash</button>
        )}
        <button className="btn btn-sm" disabled={!canAct || !up} onClick={() => onSkew(id, skewed ? 0 : 3600000)}>
          {skewed ? 'Reset clock' : 'Skew clock +1h'}
        </button>
      </div>
    </motion.div>
  );
}

export default function Regions({ nodes, meta, canAct, onToggleLink, onPause, onResume, onSkew, onHealAll }) {
  const summary = syncSummary(nodes);
  const links = allLinks(nodes);
  const anyCut = Object.values(links).some((s) => s === 'cut');

  return (
    <Panel
      title="Regions"
      hint="Each region is an autonomous node. Fault injection and node controls below."
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {anyCut && onHealAll && (
            <button
              className="btn btn-sm btn-primary"
              disabled={!canAct}
              onClick={onHealAll}
            >
              Heal All Links
            </button>
          )}
          <span className={`pill ${summary.tone === 'ok' ? 'ok' : summary.tone === 'bad' ? 'bad' : 'warn'}`}>
            {summary.text}
          </span>
        </div>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <motion.div key={summary.text} className={`banner ${summary.tone}`} initial={{ opacity: 0.3 }} animate={{ opacity: 1 }}>
          <span className={`dot ${summary.tone}`} />
          {summary.text}
          <span className="detail">{summary.detail}</span>
        </motion.div>

        <div className="regions">
          {NODES.map((id) => (
            <RegionCard
              key={id}
              id={id}
              node={nodes[id]}
              nodes={nodes}
              meta={meta[id]}
              canAct={canAct}
              onPause={onPause}
              onResume={onResume}
              onSkew={onSkew}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
}
