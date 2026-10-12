import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import { NODES } from '../config';
import { useCluster } from '../hooks';
import { sleep } from '../lib';
import CountUp from '../reactbits/CountUp';
import Panel from './Panel';
import { useToast } from './Toast';

const BASE_TEXT = 'Camp 4 supply record: 500 blankets in stock';
const MUM_TEXT = 'Mumbai office: 120 blankets dispatched to Camp 4';
const HYD_TEXT = 'Hyderabad office: 80 blankets dispatched to Camp 7';

async function waitFor(check, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await check()) return true; } catch { /* keep waiting */ }
    await sleep(200);
  }
  return false;
}

const converged = (urls) => async () => {
  const hashes = await Promise.all(NODES.map(async (n) => (await api.status(urls[n])).state_hash));
  return new Set(hashes).size === 1;
};

async function outcome(urls, reportId) {
  const { reports } = await api.reports(urls.mum);
  const { conflicts } = await api.conflicts(urls.mum);
  const final = reports.find((r) => r.report_id === reportId);
  const values = (field) => conflicts
    .filter((c) => c.report_id === reportId && c.field === field)
    .flatMap((c) => c.candidates.map((x) => x.value));
  const where = (field, value) => {
    if (final && final[field] === value) return 'final';
    return values(field).includes(value) ? 'ledger' : 'lost';
  };
  return {
    final,
    entries: conflicts.filter((c) => c.report_id === reportId).length,
    rows: [
      { label: "Mumbai's edit, made while cut off", result: where('description', MUM_TEXT) },
      { label: "Hyderabad's edit to the same record", result: where('description', HYD_TEXT) },
      { label: "Hyderabad's priority change (to 5)", result: where('severity', 5) },
    ],
  };
}

const RESULT = {
  final: { cls: 'ok', text: 'In the final record' },
  ledger: { cls: 'info', text: 'Kept in the ledger' },
  lost: { cls: 'bad', text: 'Silently lost' },
};

function Benchmark({ results }) {
  if (!results) return null;
  const o = results.systems.ours;
  const b = results.systems.lww_baseline;
  const max = Math.max(o.silent_overwrites_pct, b.silent_overwrites_pct, 1);
  const Bar = ({ label, pct, tone }) => (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline' }}>
        <span>{label}</span>
        <strong className="num" style={{ fontSize: 20 }}><CountUp to={pct} duration={1.2} />%</strong>
      </div>
      <div className="bar-track">
        <motion.div
          className={`bar-fill ${tone}`} initial={{ width: 0 }} whileInView={{ width: `${(pct / max) * 100}%` }}
          viewport={{ once: true }} transition={{ duration: 1, ease: [0.22, 0.61, 0.36, 1] }}
          style={{ minWidth: pct > 0 ? 6 : 0 }}
        />
      </div>
    </div>
  );
  return (
    <Panel title="Measured over many failures" hint={`${results.runs} randomised trials per system: ${results.setup}`}>
      <div className="stack" style={{ gap: 18 }}>
        <Bar label="Acknowledged edits silently lost by the last-writer-wins baseline" pct={b.silent_overwrites_pct} tone="bad" />
        <Bar label="Acknowledged edits silently lost by our engine" pct={o.silent_overwrites_pct} tone="ok" />
        <div className="table-wrap" style={{ margin: '0 -20px -20px' }}>
          <table>
            <thead><tr><th>Failure scenario</th><th>Engine passed</th><th>Baseline passed</th></tr></thead>
            <tbody>
              {results.scenarios.map((s) => (
                <tr key={s.name}>
                  <td style={{ textTransform: 'capitalize' }}>{s.name.replace(/_/g, ' ')}</td>
                  <td className="num"><span className="pill ok plain">{s.ours_pass} of {s.runs}</span></td>
                  <td className="num"><span className={`pill plain ${s.lww_pass === s.runs ? 'ok' : 'bad'}`}>{s.lww_pass} of {s.runs}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

export default function Compare({ engineUrls, baselineUrls, results }) {
  const toast = useToast();
  const engine = useCluster(engineUrls);
  const baseline = useCluster(baselineUrls);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [verdict, setVerdict] = useState(null);
  const started = useRef(0);

  const say = (text) => setLog((l) => [...l, { t: ((Date.now() - started.current) / 1000).toFixed(1), text }]);
  const reachable = (snap) => NODES.every((n) => snap.nodes[n] && snap.nodes[n].state === 'up');
  const ready = reachable(engine) && reachable(baseline);

  const runScenario = async () => {
    const clusters = [engineUrls, baselineUrls];
    const each = (fn) => Promise.all(clusters.map(fn));
    setRunning(true);
    setLog([]);
    setVerdict(null);
    started.current = Date.now();
    try {
      say('Resetting both systems to empty');
      await each(async (u) => {
        await Promise.all(NODES.map((n) => api.resume(u[n]).catch(() => {})));
        await Promise.all(NODES.map((n) => api.reset(u[n])));
      });
      await sleep(700);

      say('Mumbai creates a shared record, and it replicates to every region');
      const ids = await each(async (u) => (await api.create(u.mum, {
        incident_type: 'medical', severity: 3, description: BASE_TEXT,
        reporter: 'scenario', location: { lat: 19.076, lon: 72.877 },
      })).report_id);
      const seenEverywhere = await waitFor(async () => {
        for (let i = 0; i < clusters.length; i += 1) {
          for (const n of NODES) {
            const { reports } = await api.reports(clusters[i][n]);
            if (!reports.some((r) => r.report_id === ids[i])) return false;
          }
        }
        return true;
      });
      if (!seenEverywhere) throw new Error('The record did not reach every region');

      say('Link failure: Mumbai can no longer reach Hyderabad or Singapore');
      await each(async (u) => {
        for (const other of ['hyd', 'sin']) {
          await Promise.all([api.block(u.mum, other), api.block(u[other], 'mum')]);
        }
      });
      await sleep(400);

      say('While apart, Mumbai and Hyderabad both edit the same record');
      await each(async (u, i) => {
        await api.patch(u.mum, ids[i], { description: MUM_TEXT });
        await api.patch(u.hyd, ids[i], { description: HYD_TEXT });
        await api.patch(u.hyd, ids[i], { severity: 5 });
      });
      await sleep(500);

      say('Link restored. Waiting for the regions to merge');
      await each(async (u) => {
        for (const other of ['hyd', 'sin']) {
          await Promise.all([api.unblock(u.mum, other), api.unblock(u[other], 'mum')]);
        }
      });
      const merged = await Promise.all(clusters.map((u) => waitFor(converged(u), 12000)));
      say(merged.every(Boolean) ? 'Both systems converged to one state' : 'A system did not converge in time');

      const [eng, base] = await Promise.all(clusters.map((u, i) => outcome(u, ids[i])));
      setVerdict({ eng, base });
      say('Done');
    } catch (err) {
      toast(`Scenario stopped: ${err.message}`, 'bad');
      say(`Stopped: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  // ?autorun=1 starts the scenario as soon as both clusters answer (used for testing and demos).
  const autoStarted = useRef(false);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('autorun') === '1';
    if (wanted && ready && !autoStarted.current) {
      autoStarted.current = true;
      runScenario();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Same failure, two systems</h1>
          <p className="page-sub">
            The link to Mumbai is cut, Mumbai and Hyderabad both edit one record, then the link returns. Our engine and a
            last-writer-wins store receive exactly the same actions.
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary btn-lg" onClick={runScenario} disabled={running || !ready}>
          {running ? 'Running...' : 'Run the link-failure scenario'}
        </button>
      </div>

      {!ready && (
        <div className="banner warn">
          <span className="dot warn" />
          Both local clusters must be running: the engine on ports 8001 to 8003 and the baseline on 9001 to 9003.
        </div>
      )}

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr)' }}>
        <Panel title="What is happening">
          {log.length === 0 ? <p className="muted">Press the button to start.</p> : (
            <div className="log">
              <AnimatePresence initial={false}>
                {log.map((l, i) => (
                  <motion.div key={i} className="log-line" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
                    <time>{l.t}s</time><span>{l.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </Panel>

        <Panel title="What each system kept" flush>
          {!verdict ? <div className="empty">The result appears here when the scenario finishes.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Edit</th><th>Our engine</th><th>Last-writer-wins</th></tr></thead>
                <tbody>
                  {verdict.eng.rows.map((row, i) => (
                    <motion.tr key={row.label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.14 }}>
                      <td style={{ fontWeight: 600 }}>{row.label}</td>
                      <td><span className={`pill ${RESULT[row.result].cls}`}>{RESULT[row.result].text}</span></td>
                      <td><span className={`pill ${RESULT[verdict.base.rows[i].result].cls}`}>{RESULT[verdict.base.rows[i].result].text}</span></td>
                    </motion.tr>
                  ))}
                  <tr>
                    <td style={{ fontWeight: 600 }}>Disagreements flagged for review</td>
                    <td className="num">{verdict.eng.entries}</td>
                    <td className="num muted">0 (no record kept)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Benchmark results={results} />
    </div>
  );
}
