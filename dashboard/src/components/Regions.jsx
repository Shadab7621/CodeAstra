import { motion } from 'framer-motion';
import { NODES, REGION } from '../config';
import { offsetLabel, shortHash } from '../lib';

export function linkState(nodes, a, b) {
  const A = nodes[a];
  const B = nodes[b];
  if (!A || !B || A.state !== 'up' || B.state !== 'up') return 'unknown';
  const blocked = (X, id) => (X.status.peers || []).some((p) => p.id === id && p.blocked);
  return blocked(A, b) || blocked(B, a) ? 'cut' : 'ok';
}

function describe(node) {
  if (!node) return { tone: '', text: 'Connecting' };
  if (node.state === 'up') return { tone: 'ok', text: 'Healthy' };
  if (node.state === 'paused') return { tone: 'warn', text: 'Paused (simulated crash)' };
  return { tone: 'bad', text: 'Unreachable' };
}

function Connector({ state }) {
  const cls = state === 'cut' ? 'cut' : state === 'ok' ? 'ok' : 'unknown';
  return (
    <div className="connector" aria-hidden="true">
      <svg viewBox="0 0 56 40">
        <motion.path
          className={`link-line ${cls}`}
          d="M0 20 H56"
          initial={false}
          animate={{ opacity: state === 'unknown' ? 0.6 : 1 }}
        />
        {state === 'cut' && (
          <motion.g initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ transformOrigin: '28px 20px' }}>
            <path d="M22 14 L34 26 M34 14 L22 26" stroke="var(--bad)" strokeWidth="2.2" strokeLinecap="round" />
          </motion.g>
        )}
      </svg>
    </div>
  );
}

function RegionCard({ id, node, provider, canAct, onPause, onResume, onSkew }) {
  const status = describe(node);
  const up = node && node.state === 'up';
  const s = up ? node.status : null;
  const pending = up ? (s.peers || []).reduce((n, p) => n + (p.pending_in || 0) + (p.pending_out || 0), 0) : 0;
  const rejected = up && s.integrity ? s.integrity.rejected_events : 0;
  const skewed = up && s.clock_offset_ms;

  return (
    <motion.div layout className={`region ${up ? '' : 'is-down'}`}>
      <div className="region-head">
        <span className="region-name">{REGION[id].name}</span>
        <span className="tag">{provider}</span>
      </div>
      <div className="status-line">
        <span className={`dot ${status.tone}`} />
        {status.text}
      </div>
      <div className="metrics">
        <div className="metric"><span>Events</span><span className="num">{up ? s.event_count : '-'}</span></div>
        <div className="metric"><span>State hash</span><span className="mono">{up ? shortHash(s.state_hash) : '-'}</span></div>
        <div className="metric"><span>Waiting to sync</span><span className="num">{up ? pending : '-'}</span></div>
        <div className="metric"><span>Clock</span><span className={skewed ? 'num' : 'num muted'}>{up ? offsetLabel(s.clock_offset_ms) : '-'}</span></div>
        {rejected > 0 && (
          <div className="metric"><span>Rejected events</span><span className="pill bad plain">{rejected}</span></div>
        )}
      </div>
      <div className="region-actions">
        {node && node.state === 'paused' ? (
          <button className="btn btn-sm" disabled={!canAct} onClick={() => onResume(id)}>Resume</button>
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

export default function Regions({ nodes, providers, canAct, onToggleLink, onPause, onResume, onSkew }) {
  const upNodes = NODES.filter((n) => nodes[n] && nodes[n].state === 'up');
  const hashes = new Set(upNodes.map((n) => nodes[n].status.state_hash));
  const missing = NODES.length - upNodes.length;
  const loaded = NODES.every((n) => nodes[n]);

  let banner = { tone: 'warn', text: 'Connecting to the regions...', detail: '' };
  if (loaded) {
    if (upNodes.length === 0) banner = { tone: 'bad', text: 'No region is reachable', detail: 'Check that the cluster is running' };
    else if (hashes.size === 1 && missing === 0) banner = { tone: 'ok', text: 'All regions are in sync', detail: `${upNodes.length} regions hold identical state` };
    else if (hashes.size === 1) banner = { tone: 'warn', text: `${missing} region${missing > 1 ? 's' : ''} unreachable`, detail: 'The rest are in sync' };
    else banner = { tone: 'warn', text: 'Regions differ', detail: 'Updates are waiting to be exchanged' };
  }

  const pairs = [['mum', 'hyd'], ['hyd', 'sin'], ['mum', 'sin']];

  return (
    <section className="panel" aria-label="Regions">
      <div className="panel-head">
        <span className="panel-title">Regions</span>
      </div>
      <div className="panel-body stack" style={{ gap: 16 }}>
        <motion.div
          key={banner.text}
          className={`sync-banner ${banner.tone}`}
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 1 }}
        >
          <span className={`dot ${banner.tone}`} />
          {banner.text}
          <span className="detail">{banner.detail}</span>
        </motion.div>

        <div className="regions">
          <RegionCard id="mum" node={nodes.mum} provider={providers.mum} canAct={canAct} onPause={onPause} onResume={onResume} onSkew={onSkew} />
          <Connector state={linkState(nodes, 'mum', 'hyd')} />
          <RegionCard id="hyd" node={nodes.hyd} provider={providers.hyd} canAct={canAct} onPause={onPause} onResume={onResume} onSkew={onSkew} />
          <Connector state={linkState(nodes, 'hyd', 'sin')} />
          <RegionCard id="sin" node={nodes.sin} provider={providers.sin} canAct={canAct} onPause={onPause} onResume={onResume} onSkew={onSkew} />
        </div>

        <div className="links-strip">
          {pairs.map(([a, b]) => {
            const st = linkState(nodes, a, b);
            return (
              <button
                key={`${a}${b}`}
                className={`link-chip ${st === 'cut' ? 'cut' : ''}`}
                disabled={!canAct || st === 'unknown'}
                onClick={() => onToggleLink(a, b, st)}
                title={st === 'cut' ? 'Restore this link' : 'Cut this link to simulate a partition'}
              >
                <span className={`dot ${st === 'cut' ? 'bad' : st === 'ok' ? 'ok' : ''}`} />
                {REGION[a].name} to {REGION[b].name}
                <span className="muted">{st === 'cut' ? 'Cut, click to restore' : st === 'ok' ? 'Connected, click to cut' : 'Unavailable'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
