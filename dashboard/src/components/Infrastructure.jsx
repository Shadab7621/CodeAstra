import { motion } from 'motion/react';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import { PIPELINE, STACK } from '../infra';
import { offsetLabel, shortHash } from '../lib';
import { ReadOnlyNotice, useClusterActions } from './ClusterView';
import Panel, { Card } from './Panel';
import { ProviderBadge, allLinks, nodeHealth, syncSummary } from './Regions';

function StatTile({ label, value, foot, delay }) {
  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay }}>
      <Card className="stat-tile">
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        <div className="foot">{foot}</div>
      </Card>
    </motion.div>
  );
}

function NodeCard({ id, node, meta, url, canAct, actions, onOpenLogs }) {
  const health = nodeHealth(node);
  const up = node && node.state === 'up';
  const paused = node && node.state === 'paused';
  const s = up ? node.status : null;
  const ownHead = up && node.heads && node.heads[id];
  const skewed = up && s?.clock_offset_ms;
  const activePeers = up ? (s?.peers || []).filter((p) => p.reachable && !p.blocked).length : 0;
  const pendingIn = up ? (s?.peers || []).reduce((n, p) => n + (p.pending_in || 0), 0) : 0;
  const pendingOut = up ? (s?.peers || []).reduce((n, p) => n + (p.pending_out || 0), 0) : 0;

  return (
    <Card className="node-card">
      <div>
        <div className="region-head">
          <h3>{REGION[id].name}</h3>
          <span className="spacer" />
          <ProviderBadge provider={meta.provider} />
        </div>
        <div className="status-line" style={{ margin: '10px 0 0' }}>
          <span className={`dot ${health.tone} ${up ? 'live' : ''}`} />
          {health.text}
          <span className="spacer" />
          {up && <span className="pill plain info num">{node.rtt} ms RTT</span>}
        </div>

        <div className="node-endpoints">
          <span className="muted">Endpoints:</span>
          <a href={`${url}/status`} target="_blank" rel="noreferrer" title="Open raw /status JSON">
            <span>/status</span> ↗
          </a>
          <span className="muted">·</span>
          <a href={`${url}/docs`} target="_blank" rel="noreferrer" title="Open interactive Swagger API Documentation">
            <span>Swagger UI (/docs)</span> ↗
          </a>
        </div>

        <dl className="spec">
          <dt>Service</dt><dd>{meta.service}</dd>
          <dt>Region / Zone</dt><dd className="mono">{meta.regionCode} ({meta.zone})</dd>
          <dt>Instance / CPU</dt><dd className="mono">{meta.instance} · {meta.cpu}</dd>
          <dt>Host OS</dt><dd>{meta.os}</dd>
          <dt>Endpoint</dt><dd className="mono">{url.replace('http://', '')}</dd>
          <dt>Events held</dt><dd className="num" style={{ fontWeight: 700, color: 'var(--accent)' }}>{up ? s.event_count : '-'}</dd>
          <dt>State hash</dt><dd className="mono">{up ? shortHash(s.state_hash) : '-'}</dd>
          <dt>Own chain head</dt><dd className="mono">{ownHead ? `#${ownHead.seq} ${shortHash(ownHead.hash)}` : '-'}</dd>
          <dt>Forged refused</dt><dd className="num">{up && s.integrity ? s.integrity.rejected_events : '-'}</dd>
          <dt>Active peers</dt><dd className="num">{up ? `${activePeers} connected` : '-'}</dd>
          <dt>Pending queue</dt><dd className="num">{up ? `${pendingOut} out / ${pendingIn} in` : '-'}</dd>
          <dt>Clock offset</dt><dd className="mono" style={skewed ? { color: 'var(--warn)' } : undefined}>{up ? offsetLabel(s.clock_offset_ms) : '-'}</dd>
        </dl>
      </div>

      <div className="node-card-actions">
        <button
          className="btn btn-sm btn-ghost"
          disabled={!canAct || !up}
          onClick={() => actions.syncNow(id)}
          title="Force an immediate gossip synchronization pull from peers"
        >
          ↻ Sync Now
        </button>

        {paused ? (
          <button
            className="btn btn-sm btn-primary"
            disabled={!canAct}
            onClick={() => actions.resume(id)}
            title="Resume the paused node process"
          >
            ▶ Resume Node
          </button>
        ) : (
          <button
            className="btn btn-sm"
            style={{ color: 'var(--warn)', borderColor: 'var(--warn-soft)' }}
            disabled={!canAct || !up}
            onClick={() => actions.pause(id)}
            title="Simulate crash failure (node stops responding to traffic)"
          >
            ⚠ Simulate Crash
          </button>
        )}

        <button
          className="btn btn-sm"
          disabled={!canAct || !up}
          onClick={() => actions.skew(id, skewed ? 0 : 3600000)}
          title="Inject a +1 hour clock skew to test Lamport / HLC timestamp reconciliation"
        >
          {skewed ? 'Reset Clock' : 'Skew +1h'}
        </button>

        {onOpenLogs && (
          <button type="button" className="btn btn-sm node-logs-btn" onClick={() => onOpenLogs(id)}>
            View {REGION[id].name} logs
          </button>
        )}
      </div>
    </Card>
  );
}

function ReplicationMatrix({ nodes, canAct, actions }) {
  const rows = [];
  for (const from of NODES) {
    const n = nodes[from];
    if (!n || n.state !== 'up') continue;
    for (const p of n.status.peers || []) rows.push({ from, ...p });
  }
  if (rows.length === 0) return <div className="empty">No region is answering yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>From Region</th>
            <th>To Peer</th>
            <th>Link State</th>
            <th>Last Exchange</th>
            <th>Waiting to Send</th>
            <th>Waiting to Receive</th>
            <th style={{ textAlign: 'right', paddingRight: '20px' }}>Direct Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isCut = r.blocked;
            const isConnected = r.reachable && !r.blocked;
            return (
              <tr key={`${r.from}-${r.id}`}>
                <td style={{ fontWeight: 650 }}>{REGION[r.from].name}</td>
                <td>{REGION[r.id]?.name || r.id}</td>
                <td>
                  {isCut ? (
                    <span className="pill bad">Partitioned (Cut)</span>
                  ) : isConnected ? (
                    <span className="pill ok">Active (Replicating)</span>
                  ) : (
                    <span className="pill warn">{(r.reason || 'unreachable').replace(/_/g, ' ')}</span>
                  )}
                </td>
                <td className="num muted">
                  {r.last_sync_ms_ago == null
                    ? '-'
                    : r.last_sync_ms_ago < 1000
                    ? `${r.last_sync_ms_ago} ms ago`
                    : `${(r.last_sync_ms_ago / 1000).toFixed(1)} s ago`}
                </td>
                <td className="num">{r.pending_out ?? '-'}</td>
                <td className="num">{r.pending_in ?? '-'}</td>
                <td style={{ textAlign: 'right', paddingRight: '20px' }}>
                  {isCut ? (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!canAct}
                      onClick={() => actions.toggleLink(r.from, r.id, 'cut')}
                    >
                      Restore Link
                    </button>
                  ) : isConnected ? (
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ color: 'var(--bad)', borderColor: 'var(--bad-soft)' }}
                      disabled={!canAct}
                      onClick={() => actions.toggleLink(r.from, r.id, 'ok')}
                    >
                      Cut Link
                    </button>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Infrastructure({ urls, meta, token, env, onOpenLogs }) {
  const { nodes } = useCluster(urls);
  const actions = useClusterActions(urls, token);
  const canAct = env === 'local' || Boolean(token);
  const cloud = env === 'cloud';

  const up = NODES.filter((n) => nodes[n] && nodes[n].state === 'up');
  const providers = [...new Set(NODES.map((n) => meta[n].provider))];
  const rtts = up.map((n) => nodes[n].rtt).sort((a, b) => a - b);
  const median = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
  const events = up.length ? Math.max(...up.map((n) => nodes[n].status.event_count)) : 0;
  const summary = syncSummary(nodes);
  const links = allLinks(nodes);
  const anyCut = Object.values(links).some((s) => s === 'cut');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Live infrastructure & mesh</h1>
          <p className="page-sub">
            {cloud
              ? 'Multi-region deployment across AWS and Azure cloud nodes with decentralized replication and fault simulation.'
              : 'Local simulation running three isolated FastAPI processes. Switch to Cloud (top right) for AWS & Azure servers.'}
          </p>
        </div>
        <span className="spacer" />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {anyCut && (
            <button
              className="btn btn-primary"
              disabled={!canAct}
              onClick={actions.healAll}
            >
              Heal All Links
            </button>
          )}
          <button
            className="btn"
            disabled={!canAct}
            onClick={actions.syncAll}
            title="Trigger gossip reconciliation pull across all online nodes"
          >
            ↻ Sync All Nodes
          </button>
          <span className={`pill ${summary.tone === 'ok' ? 'ok' : summary.tone === 'bad' ? 'bad' : 'warn'}`}>
            {summary.text}
          </span>
        </div>
      </div>

      <ReadOnlyNotice canAct={canAct} />

      <div className="grid-4">
        <StatTile delay={0} label="Cloud providers" value={cloud ? providers.length : '-'} foot={cloud ? providers.join(' and ') : 'Local processes'} />
        <StatTile delay={0.05} label="Regions online" value={`${up.length} / ${NODES.length}`} foot={summary.text} />
        <StatTile delay={0.1} label="Median round trip" value={median == null ? '-' : `${median} ms`} foot="Browser to active node latency" />
        <StatTile delay={0.15} label="Events replicated" value={events} foot="Hash-chained records held in SQLite" />
      </div>


      <div className="grid-3">
        {NODES.map((id) => (
          <NodeCard
            key={id}
            id={id}
            node={nodes[id]}
            meta={meta[id]}
            url={urls[id]}
            canAct={canAct}
            actions={actions}
            onOpenLogs={onOpenLogs}
          />
        ))}
      </div>

      <Panel
        title="Replication links & peering state"
        hint="Live peer exchange matrix reported by each active region. Cut or restore links directly from the action column."
        flush
      >
        <ReplicationMatrix nodes={nodes} canAct={canAct} actions={actions} />
      </Panel>

      <Panel
        title="How a node gets there"
        hint="Automated multi-cloud deployment pipeline from source code to persistent event-sourced cluster."
      >
        <div className="stack" style={{ gap: 20 }}>
          <div className="pipeline">
            {PIPELINE.map((p, i) => (
              <div className="pipe-step" key={p.step}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <b>{p.step}</b>
                <span>{p.detail}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: '12px', fontWeight: 650, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: '6px' }}>
              Core Stack:
            </span>
            {STACK.map((tech) => (
              <span key={tech} className="tech-tag">
                {tech}
              </span>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}
