import { findStockIssues } from '../cart';
import { REGION } from '../config';
import { useCluster } from '../hooks';
import { ReadOnlyNotice, useClusterActions, useSelectedRegion } from './ClusterView';
import Ledger from './Ledger';
import Panel from './Panel';
import Regions, { PAIRS, allLinks, linkState, syncSummary } from './Regions';
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

  const stockIssues = selectedNode && selectedNode.state === 'up' ? findStockIssues(selectedNode.reports) : [];

  const summary = syncSummary(nodes);
  const links = allLinks(nodes);
  const anyCut = Object.values(links).some((s) => s === 'cut');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{baseline ? 'Last-writer-wins baseline' : 'Replication console'}</h1>
          <p className="page-sub">
            {baseline
              ? 'The comparison system. It replicates and converges, but keeps only the newest write of each record.'
              : 'Write in any region, break the links between them, and watch the regions merge when the links return.'}
          </p>
        </div>
        <span className="spacer" />
        {baselineUrls && (
          <Segmented id="system" label="System" value={system} onChange={onSystem}
            options={[{ value: 'engine', label: 'Our engine' }, { value: 'baseline', label: 'Baseline' }]} />
        )}
      </div>

      <ReadOnlyNotice canAct={canAct} />
      <Regions
        nodes={nodes} meta={meta} canAct={canAct}
        onToggleLink={actions.toggleLink} onPause={actions.pause} onResume={actions.resume} onSkew={actions.skew}
        onHealAll={actions.healAll}
      />
      <div className="grid-2 overview-split">
        <Reports nodes={nodes} urls={urls} selected={selected} onSelect={setSelected} />
        <div className="topology-col">
          <Panel
            className="topology-full-card"
            title="Cluster Topology & Signal Mesh"
            hint="Interactive network mesh. Click on any curved signal path or badge to simulate partition."
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {anyCut && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!canAct}
                    onClick={actions.healAll}
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
            <Topology
              nodes={nodes}
              links={links}
              meta={meta}
              onToggleLink={canAct ? actions.toggleLink : undefined}
            />

            {/* Direct Signal Switches - Clean rows, zero text clipping */}
            <div className="signals-control-box">
              <div className="signals-control-head">
                <div className="signals-head-left">
                  <span className="dot ok live" />
                  <span className="signals-control-title">Direct Signal Switches</span>
                </div>
                <span className="signals-control-hint">1-click instant partition toggle</span>
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
                      <div className="switch-row-left">
                        <span className={`dot ${isCut ? 'bad' : 'ok live'}`} />
                        <span className="switch-node-pair">
                          <strong>{REGION[a].name}</strong>
                          <span className="switch-arrow">↔</span>
                          <strong>{REGION[b].name}</strong>
                        </span>
                      </div>
                      <div className="switch-row-right">
                        <span className={`switch-pill ${isCut ? 'cut' : 'ok'}`}>
                          {isCut ? 'Cut · Click to Restore' : 'Connected · Click to Cut'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <Ledger conflicts={conflicts} base={urls[selected]} token={token} kind={baseline ? 'baseline' : 'engine'} stockIssues={stockIssues} />
    </div>
  );
}
