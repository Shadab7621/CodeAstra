import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import { CART_PREFIX as PREFIX, stockFixes } from '../cart';
import { REGION } from '../config';
import { shortId } from '../lib';
import Panel from './Panel';
import { useToast } from './Toast';

const cartOf = (v) => {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return null;
  try { return JSON.parse(v.slice(PREFIX.length)); } catch { return null; }
};
const show = (v) => {
  const cart = cartOf(v);
  if (cart) return Number.isFinite(cart.qty) ? `${cart.name} × ${cart.qty}` : cart.name;
  return typeof v === 'object' && v !== null ? `${v.lat?.toFixed?.(3)}, ${v.lon?.toFixed?.(3)}` : String(v);
};
const newest = (a, b) => (a.hlc.wall - b.hlc.wall) || (a.hlc.counter - b.hlc.counter);

/** Picks the candidate to keep and the reason, so a person does not have to look at each one. */
function autoChoice(entry) {
  const carts = entry.candidates.map((c) => ({ c, cart: cartOf(c.value) }));
  if (carts.every(({ cart }) => cart && Number.isFinite(cart.qty))) {
    const top = carts.reduce((a, b) => (b.cart.qty > a.cart.qty ? b : a));
    return { candidate: top.c, reason: 'Cart quantity conflicts keep the higher quantity, so no item a customer asked for is lost.' };
  }
  const latest = [...entry.candidates].sort(newest).at(-1);
  return { candidate: latest, reason: 'No safe rule for this field, so the most recent write was kept.' };
}
const FIELD = { description: 'Details', severity: 'Priority', status: 'Status', location: 'Location' };

function Conflict({ entry, base, token }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const open = entry.status === 'needs_operator';

  const choose = async (candidate) => {
    setBusy(true);
    try {
      await api.resolve(base, entry.conflict_id, candidate.event_id, 'dashboard', token);
      toast(`Kept the version from ${REGION[candidate.origin]?.name || candidate.origin}`);
    } catch (err) {
      toast(err.status === 401 ? 'The admin token is missing or wrong. Add it in Settings.' : `Could not resolve: ${err.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div layout className="conflict" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="conflict-head">
        <span>{FIELD[entry.field] || entry.field}</span>
        <span className="mono muted">{shortId(entry.report_id)}</span>
        <span className="spacer" />
        {open ? <span className="pill warn">Needs a decision</span>
          : entry.status === 'operator_resolved' ? <span className="pill ok">Decided</span>
            : <span className="pill info">Resolved by rule</span>}
      </div>
      {entry.explanation && <p className={`conflict-why ${open ? 'open' : ''}`}>{entry.explanation}</p>}
      <div className="candidates">
        {entry.candidates.map((c) => (
          <div className={`candidate ${entry.winner && entry.winner.event_id === c.event_id ? 'won' : ''}`} key={c.event_id}>
            <div>
              <span className="who">Written in {REGION[c.origin]?.name || c.origin}</span>
              <q>{show(c.value)}</q>
              {entry.winner && entry.winner.event_id === c.event_id && <span className="pill ok kept-pill">Kept</span>}
            </div>
            {open && <button className="btn btn-sm" disabled={busy} onClick={() => choose(c)}>Keep this</button>}
          </div>
        ))}
      </div>
      {!open && entry.resolution && (
        <p className="resolved-note">{entry.resolution.policy}. Kept: <strong>{show(entry.resolution.chosen_value)}</strong></p>
      )}
    </motion.div>
  );
}

const regionName = (id) => REGION[id]?.name || 'another region';

function StockIssue({ issue }) {
  const fixes = stockFixes(issue);
  return (
    <motion.div layout className="conflict" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="conflict-head">
        <span>Stock</span>
        <span className="mono muted">{issue.name}</span>
        <span className="spacer" />
        <span className="pill warn">Over stock by {issue.over}</span>
      </div>
      <p className="conflict-why open">
        {issue.requested} {issue.name} were asked for but only {issue.stock} are in stock. Each region checked the
        stock on its own while the link was cut, so both were allowed. Adding them together passes the limit.
      </p>
      <div className="candidates">
        {issue.lines.map((l) => (
          <div className="candidate" key={l.report.report_id}>
            <div>
              <span className="who">Written in {regionName(l.region)}</span>
              <q>{l.item.name} × {l.qty}</q>
            </div>
          </div>
        ))}
      </div>
      <p className="resolved-note">
        Auto resolve: {fixes.map((f) => `reduce ${regionName(f.line.region)}'s add from ${f.line.qty} to ${f.to}`).join(', ')}.
      </p>
    </motion.div>
  );
}

export default function Ledger({ conflicts, base, token, kind, stockIssues = [] }) {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState(null);

  // The explanation of an automatic resolution is shown for a few seconds, then it fades.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  if (kind !== 'engine') {
    return (
      <Panel title="Conflict ledger">
        <p className="muted">
          The last-writer-wins baseline keeps no record of what it throws away. When two regions edit the same
          record while apart, the older write just disappears, so there is nothing here to review.
        </p>
      </Panel>
    );
  }

  const list = conflicts || [];
  const open = list.filter((c) => c.status === 'needs_operator');
  const closed = list.filter((c) => c.status !== 'needs_operator');
  const visible = showAll ? [...open, ...closed] : open;
  const waiting = open.length + stockIssues.length;

  const autoResolve = async () => {
    setWorking(true);
    const done = [];
    try {
      for (const issue of stockIssues) {
        for (const { line, to } of stockFixes(issue)) {
          await api.patch(base, line.report.report_id,
            { description: `${PREFIX}${JSON.stringify({ ...line.item, qty: to })}` });
        }
        done.push({
          id: `stock-${issue.sku}`,
          text: `Stock: ${issue.name} was ${issue.requested} against ${issue.stock} in stock. `
            + `${stockFixes(issue).map((f) => `${regionName(f.line.region)}'s add went from ${f.line.qty} to ${f.to}`).join(', ')}. `
            + 'The newest add is trimmed first, so earlier customers keep what they ordered.',
        });
      }
      for (const entry of open) {
        const { candidate, reason } = autoChoice(entry);
        await api.resolve(base, entry.conflict_id, candidate.event_id, 'auto-resolve', token);
        done.push({
          id: entry.conflict_id,
          text: `${FIELD[entry.field] || entry.field}: kept ${show(candidate.value)} from ${REGION[candidate.origin]?.name || candidate.origin}. ${reason}`,
        });
      }
      setNotice(done);
    } catch (err) {
      toast(err.status === 401 ? 'The admin token is missing or wrong. Add it in Settings.' : `Could not auto resolve: ${err.message}`, 'bad');
      if (done.length) setNotice(done);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Panel
      title="Conflict ledger" flush
      hint="Edits made on both sides of a broken link. Nothing is dropped silently."
      actions={(
        <>
          <span className={`pill ${waiting ? 'warn' : 'ok'}`}>{waiting ? `${waiting} to decide` : 'Nothing waiting'}</span>
          {waiting > 0 && (
            <button className="btn btn-sm btn-primary" disabled={working} onClick={autoResolve}>
              {working ? 'Resolving...' : 'Auto resolve'}
            </button>
          )}
        </>
      )}
    >
      {notice && notice.length > 0 && (
        <div className="banner ok" role="status">
          <span className="dot ok" />
          <div>
            <strong>{notice.length === 1 ? 'Conflict resolved' : `${notice.length} conflicts resolved`}</strong>
            {notice.map((n) => <div key={n.id}>{n.text}</div>)}
          </div>
        </div>
      )}
      {stockIssues.map((issue) => <StockIssue key={issue.sku} issue={issue} />)}
      {visible.length === 0 && stockIssues.length === 0 ? (
        <div className="empty">
          {list.length === 0 ? 'No disagreements yet. Cut a link and edit the same record on both sides to create one.' : 'No open decisions.'}
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {visible.map((c) => <Conflict key={c.conflict_id} entry={c} base={base} token={token} />)}
        </AnimatePresence>
      )}
      {closed.length > 0 && (
        <div className="panel-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'Hide resolved' : `Show ${closed.length} resolved`}
          </button>
        </div>
      )}
    </Panel>
  );
}
