import { useState } from 'react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import Integrity from './Integrity';
import Ledger from './Ledger';
import Regions from './Regions';
import Reports from './Reports';
import { useToast } from './Toast';

export default function ClusterView({ urls, kind, providers, token, env }) {
  const toast = useToast();
  const { nodes } = useCluster(urls);
  const [selected, setSelected] = useState('mum');

  const run = async (label, fn) => {
    try {
      await fn();
      if (label) toast(label);
    } catch (err) {
      const hint = err.status === 401
        ? 'The admin token is missing or wrong. Add it in Settings.'
        : err.message;
      toast(`Failed: ${hint}`, 'bad');
    }
  };

  const toggleLink = (a, b, state) => run(
    state === 'cut' ? `Restored the link between ${REGION[a].name} and ${REGION[b].name}`
      : `Cut the link between ${REGION[a].name} and ${REGION[b].name}`,
    async () => {
      const call = state === 'cut' ? api.unblock : api.block;
      await Promise.all([call(urls[a], b, token), call(urls[b], a, token)]);
    },
  );

  const pause = (n) => run(`${REGION[n].name} is paused. It now rejects requests like a crashed server.`, () => api.pause(urls[n], token));
  const resume = (n) => run(`${REGION[n].name} resumed`, () => api.resume(urls[n], token));
  const skew = (n, ms) => run(ms ? `${REGION[n].name}'s clock is now an hour fast` : `${REGION[n].name}'s clock is back to normal`, () => api.clock(urls[n], ms, token));

  const selectedNode = nodes[selected];
  const conflicts = selectedNode && selectedNode.state === 'up' ? selectedNode.conflicts : [];
  const canAct = env === 'local' || Boolean(token);

  return (
    <div className="stack">
      {!canAct && (
        <div className="sync-banner warn">
          <span className="dot warn" />
          Controls are read-only until you add the admin token in Settings.
        </div>
      )}
      <Regions
        nodes={nodes}
        providers={providers}
        canAct={canAct}
        onToggleLink={toggleLink}
        onPause={pause}
        onResume={resume}
        onSkew={skew}
      />
      <div className="grid-2">
        <Reports nodes={nodes} urls={urls} selected={selected} onSelect={setSelected} kind={kind} providers={providers} />
        <div className="stack">
          <Ledger conflicts={conflicts} base={urls[selected]} token={token} kind={kind} />
          <Integrity nodes={nodes} urls={urls} kind={kind} />
        </div>
      </div>
    </div>
  );
}
