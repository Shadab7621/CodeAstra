import { useState } from 'react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import Panel from './Panel';

/** Compare the newest hash per origin: where two regions are at the same position, they must agree. */
export function compareHeads(nodes) {
  const seen = {};
  let comparable = 0;
  const conflicts = [];
  for (const n of NODES) {
    const heads = nodes[n] && nodes[n].state === 'up' ? nodes[n].heads : null;
    if (!heads) continue;
    for (const [origin, h] of Object.entries(heads)) {
      const key = `${origin}#${h.seq}`;
      if (seen[key] && seen[key] !== h.hash) conflicts.push(key);
      if (seen[key]) comparable += 1;
      seen[key] = h.hash;
    }
  }
  return { comparable, conflicts };
}

export default function Integrity({ nodes, urls, kind }) {
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);

  if (kind !== 'engine') {
    return (
      <Panel title="History integrity">
        <p className="muted">The baseline stores only the latest value of each record, so there is no history to verify.</p>
      </Panel>
    );
  }

  const { comparable, conflicts } = compareHeads(nodes);
  const hasHeads = NODES.some((n) => nodes[n] && nodes[n].heads);

  const verify = async () => {
    setBusy(true);
    const out = {};
    await Promise.all(NODES.map(async (n) => {
      try { out[n] = await api.verify(urls[n]); } catch (e) { out[n] = { error: e.message }; }
    }));
    setResults(out);
    setBusy(false);
  };

  return (
    <Panel
      title="History integrity"
      hint="Every event carries the hash of the one before it."
      actions={<button className="btn btn-sm" onClick={verify} disabled={busy}>{busy ? 'Checking...' : 'Verify now'}</button>}
    >
      <div className="check-row">
        <span className={`dot ${!hasHeads ? '' : conflicts.length ? 'bad' : 'ok'}`} />
        <span>
          {!hasHeads ? 'Waiting for the regions'
            : conflicts.length ? `Regions disagree on ${conflicts.join(', ')}`
              : comparable > 0 ? 'Regions hold identical history where they overlap'
                : 'Regions are at different points, nothing to compare yet'}
        </span>
      </div>
      {results && NODES.map((n) => {
        const r = results[n];
        const ok = r && r.ok;
        return (
          <div className="check-row" key={n}>
            <span className={`dot ${r && !r.error ? (ok ? 'ok' : 'bad') : ''}`} />
            <span style={{ fontWeight: 650 }}>{REGION[n].name}</span>
            <span className="spacer" />
            <span className="muted">
              {r.error ? r.error : ok ? `Chain intact, ${r.events_checked} events` : 'Stored history was altered'}
              {r && !r.error && r.rejected_events > 0 ? `, ${r.rejected_events} forged events refused` : ''}
            </span>
          </div>
        );
      })}
    </Panel>
  );
}
