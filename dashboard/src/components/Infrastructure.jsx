import { motion } from 'motion/react';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import { PIPELINE } from '../infra';
import { shortHash } from '../lib';
import { ReadOnlyNotice, useClusterActions } from './ClusterView';
import Panel, { Card } from './Panel';
import { ProviderBadge, allLinks, nodeHealth, syncSummary } from './Regions';
import Topology from './Topology';

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

function NodeCard({ id, node, meta, url }) {
  const health = nodeHealth(node);
  const up = node && node.state === 'up';
  const s = up ? node.status : null;
  const ownHead = up && node.heads && node.heads[id];
  return (
    <Card className="node-card">
      <div className="region-head">
        <h3>{REGION[id].name}</h3>
        <span className="spacer" />
        <ProviderBadge provider={meta.provider} />
      </div>
      <div className="status-line" style={{ margin: '10px 0 0' }}>
        <span className={`dot ${health.tone} ${up ? 'live' : ''}`} />
        {health.text}
        <span className="spacer" />
        {up && <span className="pill plain info num">{node.rtt} ms</span>}
      </div>
      <dl className="spec">
        <dt>Service</dt><dd>{meta.service}</dd>
        <dt>Region</dt><dd className="mono">{meta.regionCode}</dd>
        <dt>Location</dt><dd>{meta.zone}</dd>
        <dt>Machine</dt><dd className="mono">{meta.instance}</dd>
        <dt>Processor</dt><dd>{meta.cpu}</dd>
        <dt>System</dt><dd>{meta.os}</dd>
        <dt>Endpoint</dt><dd className="mono">{url.replace('http://', '')}</dd>
        <dt>Events held</dt><dd className="num">{up ? s.event_count : '-'}</dd>
        <dt>State hash</dt><dd className="mono">{up ? shortHash(s.state_hash) : '-'}</dd>
        <dt>Own chain head</dt><dd className="mono">{ownHead ? `#${ownHead.seq} ${shortHash(ownHead.hash)}` : '-'}</dd>
        <dt>Forged refused</dt><dd className="num">{up && s.integrity ? s.integrity.rejected_events : '-'}</dd>
      </dl>
    </Card>
  );
}

function ReplicationMatrix({ nodes }) {
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
        <thead><tr><th>From</th><th>To</th><th>Link</th><th>Last exchange</th><th>Waiting to send</th><th>Waiting to receive</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.from}-${r.id}`}>
              <td style={{ fontWeight: 650 }}>{REGION[r.from].name}</td>
              <td>{REGION[r.id]?.name || r.id}</td>
              <td>
                {r.blocked ? <span className="pill bad">Cut</span>
                  : r.reachable ? <span className="pill ok">Connected</span>
                    : <span className="pill warn">{(r.reason || 'unreachable').replace(/_/g, ' ')}</span>}
              </td>
              <td className="num muted">{r.last_sync_ms_ago == null ? '-' : r.last_sync_ms_ago < 1000 ? `${r.last_sync_ms_ago} ms ago` : `${(r.last_sync_ms_ago / 1000).toFixed(1)} s ago`}</td>
              <td className="num">{r.pending_out ?? '-'}</td>
              <td className="num">{r.pending_in ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Infrastructure({ urls, meta, token, env }) {
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

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Live infrastructure</h1>
          <p className="page-sub">
            {cloud
              ? 'Three servers on two cloud providers. Everything on this page is read from the running nodes.'
              : 'This is the local simulation: three processes on this computer. Switch to Cloud (top right) to see the AWS and Azure servers.'}
          </p>
        </div>
      </div>

      <ReadOnlyNotice canAct={canAct} />

      <div className="grid-4">
        <StatTile delay={0} label="Cloud providers" value={cloud ? providers.length : '-'} foot={cloud ? providers.join(' and ') : 'Local processes'} />
        <StatTile delay={0.05} label="Regions online" value={`${up.length} / ${NODES.length}`} foot={summary.text} />
        <StatTile delay={0.1} label="Median round trip" value={median == null ? '-' : `${median} ms`} foot="From this browser to a node" />
        <StatTile delay={0.15} label="Events replicated" value={events} foot="Hash-chained, held by every region" />
      </div>

      <Panel
        title="Topology"
        hint={canAct ? 'Click a link to cut or restore it. Moving dots mean the two regions are exchanging data.' : 'Moving dots mean the two regions are exchanging data.'}
        actions={<span className={`pill ${summary.tone === 'ok' ? 'ok' : summary.tone === 'bad' ? 'bad' : 'warn'}`}>{summary.text}</span>}
      >
        <Topology nodes={nodes} links={allLinks(nodes)} meta={meta} onToggleLink={canAct ? actions.toggleLink : undefined} />
      </Panel>

      <div className="grid-3">
        {NODES.map((id) => <NodeCard key={id} id={id} node={nodes[id]} meta={meta[id]} url={urls[id]} />)}
      </div>

      <Panel title="Replication links" hint="What each region reports about its connection to the others." flush>
        <ReplicationMatrix nodes={nodes} />
      </Panel>

      <Panel title="How a node gets there" hint="The same steps run on every provider, which is why the cluster can span clouds.">
        <div className="pipeline">
          {PIPELINE.map((p, i) => (
            <div className="pipe-step" key={p.step}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <b>{p.step}</b>
              <span>{p.detail}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
