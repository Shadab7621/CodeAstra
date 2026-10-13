import { findStockIssues } from '../cart';
import { REGION } from '../config';
import { useCluster } from '../hooks';
import { useReservations } from '../reservations';
import { ReadOnlyNotice, useClusterActions, useSelectedRegion } from './ClusterView';
import Ledger from './Ledger';
import Panel from './Panel';
import Regions, { DegradationBanner, PAIRS, allLinks, linkState, syncSummary } from './Regions';
import Reports from './Reports';
import Topology from './Topology';
import { Segmented } from './TopBar';

export default function Overview({ engineUrls, baselineUrls, meta, token, env, system, onSystem }) {
  const baseline = system === 'baseline' && baselineUrls;
  const urls = baseline ? baselineUrls : engineUrls;
  const { nodes } = useCluster(urls);
  const [selected, setSelected] = useSelectedRegion();
  const actions = useClusterActions(urls, token);
  const canAct = env === 'local' || Boolean(token);
  const selectedNode = nodes[selected];
  const conflicts = selectedNode && selectedNode.state === 'up' ? selectedNode.conflicts : [];

  const reserve = useReservations(nodes, selected);

  const stockIssues = selectedNode && selectedNode.state === 'up' ? findStockIssues(selectedNode.reports) : [];

  const summary = syncSummary(nodes);
  const links = allLinks(nodes);
  const anyCut = Object.values(links).some((s) => s === 'cut');

  return (
    <div className="stack replication-console-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{baseline ? 'Last-writer-wins baseline' : 'Replication console'}</h1>
          {baseline && <p className="page-sub">The comparison system. It replicates and converges, but keeps only the newest write of each record.</p>}
        </div>
        <span className="spacer" />
        {baselineUrls && (
          <Segmented id="system" label="System" value={system} onChange={onSystem}
            options={[{ value: 'engine', label: 'Our engine' }, { value: 'baseline', label: 'Baseline' }]} />
        )}
      </div>

      <ReadOnlyNotice canAct={canAct} />
      <DegradationBanner nodes={nodes} />
      <Regions
        nodes={nodes} meta={meta} canAct={canAct}
        onToggleLink={actions.toggleLink} onPause={actions.pause} onResume={actions.resume} onSkew={actions.skew}
        onHealAll={actions.healAll}
      />

      <Panel
        title="Network"
        hint="The map shows the state of each link. Use the switches to cut or restore one."
        actions={(
          <>
            {anyCut && (
              <button className="btn btn-sm btn-primary" disabled={!canAct} onClick={actions.healAll}>
                Heal all links
              </button>
            )}
            <span className={`pill ${summary.tone === 'ok' ? 'ok' : summary.tone === 'bad' ? 'bad' : 'warn'}`}>
              {summary.text}
            </span>
          </>
        )}
      >
        <div className="network-split">
          <Topology nodes={nodes} links={links} meta={meta} />

          <div className="signals-control-box">
            <div className="signals-control-head">
              <span className="signals-control-title">Links</span>
              <span className="signals-control-hint">Click a link to cut or restore it</span>
            </div>
            <div className="signals-control-list">
              {PAIRS.map(([a, b]) => {
                const st = linkState(nodes, a, b);
                const isCut = st === 'cut';
                return (
                  <button
                    key={`${a}-${b}`}
                    className={`signal-switch-row ${isCut ? 'cut' : 'ok'}`}
                    disabled={!canAct || st === 'unknown'}
                    onClick={() => actions.toggleLink(a, b, st)}
                  >
                    <span className="switch-node-pair">
                      <span className={`dot ${isCut ? 'bad' : 'ok live'}`} />
                      <strong>{REGION[a].name}</strong>
                      <span className="switch-arrow">↔</span>
                      <strong>{REGION[b].name}</strong>
                    </span>
                    <span className={`switch-pill ${isCut ? 'cut' : 'ok'}`}>
                      {isCut ? 'Cut · restore' : 'Connected · cut'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Panel>

      <Reports nodes={nodes} urls={urls} selected={selected} onSelect={setSelected} reserve={reserve} />

      <Ledger conflicts={conflicts} base={urls[selected]} token={token} kind={baseline ? 'baseline' : 'engine'} stockIssues={stockIssues} />
    </div>
  );
}
