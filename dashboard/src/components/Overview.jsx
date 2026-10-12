import { useCluster } from '../hooks';
import { ReadOnlyNotice, useClusterActions, useSelectedRegion } from './ClusterView';
import Integrity from './Integrity';
import Ledger from './Ledger';
import Regions from './Regions';
import Reports from './Reports';
import { Segmented } from './TopBar';

export default function Overview({ engineUrls, baselineUrls, meta, token, env, system, onSystem }) {
  const baseline = system === 'baseline' && baselineUrls;
  const urls = baseline ? baselineUrls : engineUrls;
  const kind = baseline ? 'baseline' : 'engine';
  const { nodes } = useCluster(urls);
  const [selected, setSelected] = useSelectedRegion();
  const actions = useClusterActions(urls, token);
  const canAct = env === 'local' || Boolean(token);
  const selectedNode = nodes[selected];
  const conflicts = selectedNode && selectedNode.state === 'up' ? selectedNode.conflicts : [];

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
      />
      <div className="grid-2">
        <Reports nodes={nodes} urls={urls} selected={selected} onSelect={setSelected} />
        <div className="stack">
          <Ledger conflicts={conflicts} base={urls[selected]} token={token} kind={kind} />
          <Integrity nodes={nodes} urls={urls} kind={kind} />
        </div>
      </div>
    </div>
  );
}
