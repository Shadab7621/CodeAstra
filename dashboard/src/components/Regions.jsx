import { motion } from 'motion/react';
import { NODES, REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';
import { offsetLabel, shortHash } from '../lib';
import DecryptedText from '../reactbits/DecryptedText';
import Panel from './Panel';

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

export function ProviderBadge({ provider }) {
  return <span className="provider" style={{ '--p': PROVIDER_COLOR[provider] || PROVIDER_COLOR.Local }}>{provider}</span>;
}

function RegionCard({ id, node, meta, canAct, onPause, onResume, onSkew }) {
  const health = nodeHealth(node);
  const up = node && node.state === 'up';
  const s = up ? node.status : null;
  const pending = up ? (s.peers || []).reduce((n, p) => n + (p.pending_in || 0) + (p.pending_out || 0), 0) : 0;
  const skewed = up && s.clock_offset_ms;
  const hash = up ? shortHash(s.state_hash) : '';

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

export default function Regions({ nodes, meta, canAct, onToggleLink, onPause, onResume, onSkew }) {
  const summary = syncSummary(nodes);
  return (
    <Panel title="Regions" hint="Each region is a full copy of the service. Cut a link to split them.">
      <div className="stack" style={{ gap: 16 }}>
        <motion.div key={summary.text} className={`banner ${summary.tone}`} initial={{ opacity: 0.3 }} animate={{ opacity: 1 }}>
          <span className={`dot ${summary.tone}`} />
          {summary.text}
          <span className="detail">{summary.detail}</span>
        </motion.div>

        <div className="regions">
          {NODES.map((id) => (
            <RegionCard key={id} id={id} node={nodes[id]} meta={meta[id]} canAct={canAct} onPause={onPause} onResume={onResume} onSkew={onSkew} />
          ))}
        </div>

        <div className="links-strip">
          {PAIRS.map(([a, b]) => {
            const st = linkState(nodes, a, b);
            return (
              <button
                key={`${a}${b}`} className={`link-chip ${st === 'cut' ? 'cut' : ''}`}
                disabled={!canAct || st === 'unknown'} onClick={() => onToggleLink(a, b, st)}
              >
                <span className={`dot ${st === 'cut' ? 'bad' : st === 'ok' ? 'ok' : ''}`} />
                {REGION[a].name} to {REGION[b].name}
                <span className="muted">{st === 'cut' ? 'cut, click to restore' : st === 'ok' ? 'connected, click to cut' : 'unavailable'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
