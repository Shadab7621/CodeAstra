import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { REGION } from '../config';
import { shortId } from '../lib';
import { useToast } from './Toast';

const show = (v) => (typeof v === 'object' && v !== null ? `${v.lat?.toFixed?.(3)}, ${v.lon?.toFixed?.(3)}` : String(v));
const FIELD = { description: 'Description', severity: 'Severity', status: 'Status', location: 'Location' };

function Conflict({ entry, base, token }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const open = entry.status === 'needs_operator';

  const choose = async (candidate) => {
    setBusy(true);
    try {
      await api.resolve(base, entry.conflict_id, candidate.event_id, 'dashboard', token);
      toast(`Kept ${REGION[candidate.origin]?.name || candidate.origin}'s version`);
    } catch (err) {
      toast(err.status === 401 ? 'The admin token is missing or wrong. Add it in Settings.' : `Could not resolve: ${err.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div layout className="conflict" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="conflict-head">
        <span>{FIELD[entry.field] || entry.field}</span>
        <span className="mono muted">{shortId(entry.report_id)}</span>
        <span className="spacer" />
        {open ? <span className="pill warn">Needs a decision</span>
          : entry.status === 'operator_resolved' ? <span className="pill ok">Decided</span>
            : <span className="pill info">Resolved by rule</span>}
      </div>
      <div className="candidates">
        {entry.candidates.map((c) => (
          <div className="candidate" key={c.event_id}>
            <div>
              <span className="who">{REGION[c.origin]?.name || c.origin}</span>
              <q>{show(c.value)}</q>
            </div>
            {open && <button className="btn btn-sm" disabled={busy} onClick={() => choose(c)}>Keep this</button>}
          </div>
        ))}
      </div>
      {!open && entry.resolution && (
        <p className="resolved-note" style={{ marginTop: 10 }}>
          {entry.resolution.policy}. Kept: <strong>{show(entry.resolution.chosen_value)}</strong>
        </p>
      )}
    </motion.div>
  );
}

export default function Ledger({ conflicts, base, token, kind }) {
  const [showAll, setShowAll] = useState(false);

  if (kind !== 'engine') {
    return (
      <section className="panel">
        <div className="panel-head"><span className="panel-title">Conflict ledger</span></div>
        <div className="panel-body">
          <p className="muted">
            The last-writer-wins baseline keeps no record of what it discards. When two regions edit the same
            report, the older write simply disappears, and there is nothing here to review.
          </p>
        </div>
      </section>
    );
  }

  const list = conflicts || [];
  const open = list.filter((c) => c.status === 'needs_operator');
  const closed = list.filter((c) => c.status !== 'needs_operator');
  const visible = showAll ? [...open, ...closed] : open;

  return (
    <section className="panel" aria-label="Conflict ledger">
      <div className="panel-head">
        <span className="panel-title">Conflict ledger</span>
        <span className="spacer" />
        <span className={`pill ${open.length ? 'warn' : 'ok'}`}>{open.length ? `${open.length} to decide` : 'Nothing waiting'}</span>
      </div>
      <div className="panel-body flush">
        {visible.length === 0 ? (
          <div className="empty">
            {list.length === 0
              ? 'No disagreements recorded. Cut a link and edit the same report on both sides to see one.'
              : 'No open decisions.'}
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((c) => <Conflict key={c.conflict_id} entry={c} base={base} token={token} />)}
          </AnimatePresence>
        )}
      </div>
      {closed.length > 0 && (
        <div className="panel-body" style={{ borderTop: '1px solid var(--border)', padding: '10px 18px' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Hide resolved' : `Show ${closed.length} resolved`}
          </button>
        </div>
      )}
    </section>
  );
}
