import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { STATUS_LABEL, TYPE_LABEL, formatFields, relativeTime, shortHash, shortId } from '../lib';
import { Close, Plus } from './Icons';
import Panel, { Portal } from './Panel';
import { useToast } from './Toast';
import { Segmented } from './TopBar';

const COORDS = { mum: [19.076, 72.877], hyd: [17.385, 78.487], sin: [1.352, 103.82] };

function Durability({ value }) {
  if (value === 'confirmed') return <span className="pill ok">Confirmed</span>;
  if (value === 'replicated') return <span className="pill info">Replicated</span>;
  if (value === 'local') return <span className="pill warn">Local only</span>;
  return <span className="muted">-</span>;
}

const sevTone = (s) => (s >= 4 ? 'bad' : s === 3 ? 'warn' : '');

function NewRecord({ base, region, onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    incident_type: 'medical', severity: 3, description: '', reporter: 'operator',
    lat: COORDS[region][0], lon: COORDS[region][1],
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.create(base, {
        incident_type: form.incident_type,
        severity: Number(form.severity),
        description: form.description.trim() || 'No details given',
        reporter: form.reporter.trim() || 'operator',
        location: { lat: Number(form.lat), lon: Number(form.lon) },
      });
      toast(`Saved in ${REGION[region].name}. It replicates to the other regions on its own.`);
      onClose();
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.form
        className="modal" onSubmit={submit}
        initial={{ opacity: 0, x: '-50%', y: '-46%', scale: 0.97 }}
        animate={{ opacity: 1, x: '-50%', y: '-50%', scale: 1 }}
        exit={{ opacity: 0, x: '-50%', y: '-48%' }}
        transition={{ duration: 0.22 }}
      >
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>New record in {REGION[region].name}</h2>
          <button type="button" className="icon-btn" style={{ flex: 'none' }} onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="type">Category</label>
            <select id="type" value={form.incident_type} onChange={set('incident_type')}>
              {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sev">Priority (1 to 5)</label>
            <select id="sev" value={form.severity} onChange={set('severity')}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="desc">Details</label>
          <textarea id="desc" value={form.description} onChange={set('description')} placeholder="What this record says" maxLength={500} />
        </div>
        <div className="row">
          <div className="field"><label htmlFor="lat">Latitude</label><input id="lat" type="number" step="any" value={form.lat} onChange={set('lat')} /></div>
          <div className="field"><label htmlFor="lon">Longitude</label><input id="lon" type="number" step="any" value={form.lon} onChange={set('lon')} /></div>
        </div>
        <div className="field">
          <label htmlFor="rep">Written by</label>
          <input id="rep" value={form.reporter} onChange={set('reporter')} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" style={{ flex: 'none' }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 'none' }} disabled={busy}>{busy ? 'Saving...' : 'Save record'}</button>
        </div>
      </motion.form>
    </Portal>
  );
}

function RecordDrawer({ report, base, kind, onClose }) {
  const toast = useToast();
  const [edit, setEdit] = useState({ severity: report.severity, status: report.status, description: report.description });
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const stamp = JSON.stringify(report.last_updated);

  useEffect(() => {
    if (kind !== 'engine') { setHistory([]); return undefined; }
    let alive = true;
    api.history(base, report.report_id)
      .then((r) => { if (alive) setHistory(r.events); })
      .catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [base, report.report_id, stamp, kind]);

  const changes = {};
  if (Number(edit.severity) !== report.severity) changes.severity = Number(edit.severity);
  if (edit.status !== report.status) changes.status = edit.status;
  if (edit.description !== report.description) changes.description = edit.description;
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.patch(base, report.report_id, changes);
      if (res.warnings && res.warnings.length) toast(res.warnings[0], 'warn');
      else toast('Change saved');
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        className="drawer"
        initial={{ x: 60, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 60, opacity: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
      >
        <div className="drawer-head">
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{TYPE_LABEL[report.incident_type] || report.incident_type}</div>
            <div className="mono muted">{shortId(report.report_id)}</div>
          </div>
          <span className="spacer" />
          <Durability value={report.durability} />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="drawer-body">
          <div className="stack" style={{ gap: 12 }}>
            <div className="row">
              <div className="field">
                <label htmlFor="e-sev">Priority</label>
                <select id="e-sev" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="e-status">Status</label>
                <select id="e-status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="e-desc">Details</label>
              <textarea id="e-desc" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </div>
            <div><button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving...' : 'Save changes'}</button></div>
          </div>

          <dl className="kv">
            <dt>Written by</dt><dd>{report.reporter}</dd>
            <dt>Location</dt><dd className="num">{report.location.lat.toFixed(4)}, {report.location.lon.toFixed(4)}</dd>
            <dt>Last change</dt><dd>from {REGION[report.last_updated.node]?.name || report.last_updated.node}</dd>
          </dl>

          <div>
            <div className="panel-title" style={{ marginBottom: 14 }}>History</div>
            {kind !== 'engine' ? (
              <p className="muted">The baseline keeps no history, so earlier versions cannot be shown.</p>
            ) : history === null ? (
              <p className="muted">Loading...</p>
            ) : history.length === 0 ? (
              <p className="muted">No history available.</p>
            ) : (
              <div className="timeline">
                {history.map((e) => (
                  <div className="tl-item" key={e.event_id}>
                    <div className="tl-meta">
                      <span className="pill plain info">{REGION[e.origin]?.name || e.origin}</span>
                      <span>{e.op === 'create' ? 'Created' : e.op === 'operator_resolve' ? 'Operator decision' : 'Edited'}</span>
                      <span>{relativeTime(e.client_ts)}</span>
                      <span className="mono" title="Hash of this event">{shortHash(e.event_hash)}</span>
                    </div>
                    <div style={{ marginTop: 6 }}>{formatFields(e.fields)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.aside>
    </Portal>
  );
}

export default function Reports({ nodes, urls, selected, onSelect, kind }) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [flash, setFlash] = useState({});
  const seen = useRef({});

  const node = nodes[selected];
  const reports = node && node.state === 'up' ? node.reports : null;
  const open = reports && reports.find((r) => r.report_id === openId);

  // Briefly highlight rows that changed since the last poll.
  useEffect(() => {
    if (!reports) return undefined;
    const changed = {};
    for (const r of reports) {
      const sig = JSON.stringify([r.last_updated, r.durability, r.conflicts]);
      if (seen.current[r.report_id] !== undefined && seen.current[r.report_id] !== sig) changed[r.report_id] = true;
      seen.current[r.report_id] = sig;
    }
    if (Object.keys(changed).length === 0) return undefined;
    setFlash(changed);
    const t = setTimeout(() => setFlash({}), 1200);
    return () => clearTimeout(t);
  }, [reports]);

  useEffect(() => { seen.current = {}; }, [selected]);

  return (
    <Panel
      title="Records"
      hint={`What ${REGION[selected].name} holds right now. Each region can show something different while a link is down.`}
      flush
      actions={(
        <>
          <Segmented id="region" label="Region to view" value={selected} onChange={onSelect}
            options={NODES.map((n) => ({ value: n, label: REGION[n].name }))} />
          <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)} disabled={!node || node.state !== 'up'}>
            <Plus /> New record
          </button>
        </>
      )}
    >
      {reports === null ? (
        <div className="empty">
          {node && node.state === 'paused' ? `${REGION[selected].name} is paused.` : node ? `${REGION[selected].name} is unreachable.` : 'Connecting...'}
        </div>
      ) : reports.length === 0 ? (
        <div className="empty">Nothing in {REGION[selected].name} yet. Add a record and watch it reach the other regions.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Record</th><th>Category</th><th>Priority</th><th>Status</th><th>Details</th><th>Durability</th></tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {reports.map((r) => (
                  <motion.tr
                    key={r.report_id} layout
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className={`clickable ${flash[r.report_id] ? 'flash' : ''}`}
                    onClick={() => setOpenId(r.report_id)}
                  >
                    <td className="mono">{shortId(r.report_id)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{TYPE_LABEL[r.incident_type] || r.incident_type}</td>
                    <td><span className={`pill plain ${sevTone(r.severity)}`}>{r.severity}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{STATUS_LABEL[r.status] || r.status}</td>
                    <td className="cell-clip" title={r.description}>{r.description}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Durability value={r.durability} />
                        {r.conflicts && r.conflicts.length > 0 && <span className="pill warn">Needs decision</span>}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {creating && <NewRecord key="new" base={urls[selected]} region={selected} onClose={() => setCreating(false)} />}
        {open && <RecordDrawer key={open.report_id} report={open} base={urls[selected]} kind={kind} onClose={() => setOpenId(null)} />}
      </AnimatePresence>
    </Panel>
  );
}
