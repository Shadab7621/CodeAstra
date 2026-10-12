import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import { NODES, REGION } from '../config';
import { useCluster } from '../hooks';
import { shortHash, sleep } from '../lib';
import { compareHeads } from './Integrity';
import Panel, { Card } from './Panel';
import { ProviderBadge, allLinks } from './Regions';
import Topology from './Topology';

// The same checks as infra/smoke_test.py, run from the browser against the selected cluster.
// They are non-destructive: the run creates its own records and never wipes existing data.
const STEPS = [
  { id: 'replicate', title: 'A write in Mumbai reaches Singapore', group: 'Replication' },
  { id: 'confirmed', title: 'The record becomes confirmed on every region', group: 'Replication' },
  { id: 'cut', title: 'Cut Mumbai off from Hyderabad and Singapore', group: 'Link failure' },
  { id: 'writes', title: 'Both sides still accept writes', group: 'Link failure' },
  { id: 'diverge', title: 'The two sides hold different state while apart', group: 'Link failure' },
  { id: 'local', title: "Mumbai's write is marked local, at risk", group: 'Link failure' },
  { id: 'heal', title: 'Restore the links and converge', group: 'Recovery' },
  { id: 'ledger', title: 'Both edits are kept in the conflict ledger', group: 'Recovery' },
  { id: 'decide', title: 'An operator decision reaches every region', group: 'Recovery' },
  { id: 'crash', title: 'A crashed region catches up after it returns', group: 'Crash' },
  { id: 'token', title: 'Admin calls are refused without the token', group: 'Security' },
  { id: 'chain', title: 'History chains are intact and identical everywhere', group: 'Integrity' },
];

async function waitFor(check, timeoutMs = 12000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try { if (await check()) return Math.round(performance.now() - start); } catch { /* keep waiting */ }
    await sleep(120);
  }
  return null;
}

function Icon({ status }) {
  if (status === 'running') return <span className="step-icon running" aria-label="Running" />;
  if (status === 'pass') return <span className="step-icon pass" aria-label="Passed"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg></span>;
  if (status === 'fail') return <span className="step-icon fail" aria-label="Failed"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></span>;
  if (status === 'skip') return <span className="step-icon skip" aria-label="Skipped"><svg viewBox="0 0 16 16"><path d="M4 8h8" /></svg></span>;
  return <span className="step-icon" aria-label="Waiting" />;
}

export default function LiveTests({ urls, meta, token, env }) {
  const { nodes } = useCluster(urls);
  const [state, setState] = useState({});
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const cloud = env === 'cloud';
  const ready = NODES.every((n) => nodes[n] && nodes[n].state !== 'down');
  const needsToken = cloud && !token;
  const providers = [...new Set(NODES.map((n) => meta[n].provider))];
  const target = cloud ? providers.join(' + ') : 'the local cluster';

  const run = async () => {
    const { mum: M, hyd: H, sin: S } = urls;
    const stamp = new Date().toLocaleTimeString();
    const textA = `Live test ${stamp}: edit made in Mumbai`;
    const textB = `Live test ${stamp}: edit made in Hyderabad`;
    const result = {};
    const mark = (id, patch) => { result[id] = { ...result[id], ...patch }; if (!cancelled.current) setState({ ...result }); };
    const began = performance.now();
    setRunning(true);
    setSummary(null);
    setState({});

    // Runs one step: `fn` returns { ok, ms?, note? } or throws.
    const step = async (id, fn) => {
      mark(id, { status: 'running' });
      const t0 = performance.now();
      try {
        const r = await fn();
        mark(id, { status: r.skip ? 'skip' : r.ok ? 'pass' : 'fail', ms: r.ms ?? Math.round(performance.now() - t0), note: r.note });
        return r.ok || r.skip;
      } catch (err) {
        mark(id, { status: 'fail', ms: Math.round(performance.now() - t0), note: err.status === 401 ? 'Refused: add the admin token in Settings' : err.message });
        return false;
      }
    };

    let recordId;
    try {
      await step('replicate', async () => {
        recordId = (await api.create(M, {
          incident_type: 'medical', severity: 3, description: `Live test ${stamp}: shared record`,
          reporter: 'live-test', location: { lat: 19.076, lon: 72.877 },
        })).report_id;
        const ms = await waitFor(async () => Boolean(await api.report(S, recordId)));
        const place = (n) => (meta[n].provider === 'Local' ? REGION[n].name : `${REGION[n].name} on ${meta[n].provider}`);
        return { ok: ms !== null, ms, note: `From ${place('mum')} to ${place('sin')}` };
      });

      await step('confirmed', async () => {
        const ms = await waitFor(async () => (await api.report(M, recordId)).durability === 'confirmed');
        return { ok: ms !== null, ms, note: 'Every region reports that it holds the record' };
      });

      const cutOk = await step('cut', async () => {
        for (const other of ['hyd', 'sin']) {
          await Promise.all([api.block(M, other, token), api.block(urls[other], 'mum', token)]);
        }
        await sleep(800);
        return { ok: true, note: 'Two of the three links are down' };
      });

      if (cutOk) {
        await step('writes', async () => {
          const a = await api.patch(M, recordId, { description: textA });
          const b = await api.patch(H, recordId, { description: textB });
          return { ok: Boolean(a.event_id && b.event_id), note: 'Mumbai and Hyderabad each saved an edit to the same record' };
        });

        await step('diverge', async () => {
          await sleep(1200);
          const [a, b] = await Promise.all([api.status(M), api.status(H)]);
          return { ok: a.state_hash !== b.state_hash, note: `Mumbai ${shortHash(a.state_hash)}, Hyderabad ${shortHash(b.state_hash)}` };
        });

        await step('local', async () => {
          const r = await api.report(M, recordId);
          return { ok: r.durability === 'local', note: `Durability shown to the operator: ${r.durability}` };
        });

        await step('heal', async () => {
          for (const other of ['hyd', 'sin']) {
            await Promise.all([api.unblock(M, other, token), api.unblock(urls[other], 'mum', token)]);
          }
          const ms = await waitFor(async () => {
            const hashes = await Promise.all(NODES.map(async (n) => (await api.status(urls[n])).state_hash));
            return new Set(hashes).size === 1;
          });
          return { ok: ms !== null, ms, note: 'All three regions hold identical state again' };
        });

        let entry;
        await step('ledger', async () => {
          const { conflicts } = await api.conflicts(S);
          entry = conflicts.find((c) => c.report_id === recordId && c.field === 'description');
          const kept = entry ? entry.candidates.map((c) => c.value) : [];
          return { ok: kept.includes(textA) && kept.includes(textB), note: 'Neither edit was discarded' };
        });

        await step('decide', async () => {
          if (!entry) return { ok: false, note: 'No ledger entry to decide' };
          const choice = entry.candidates.find((c) => c.value === textA);
          await api.resolve(S, entry.conflict_id, choice.event_id, 'live-test', token);
          const ms = await waitFor(async () => (await api.report(M, recordId)).description === textA
            && (await api.report(H, recordId)).conflicts.length === 0);
          return { ok: ms !== null, ms, note: 'Decided in Singapore, applied in Mumbai and Hyderabad' };
        });
      } else {
        for (const id of ['writes', 'diverge', 'local', 'heal', 'ledger', 'decide']) mark(id, { status: 'skip', note: 'Needs the link cut to work' });
      }

      await step('crash', async () => {
        await api.pause(S, token);
        const other = (await api.create(M, {
          incident_type: 'medical', severity: 2, description: `Live test ${stamp}: written while Singapore was down`,
          reporter: 'live-test', location: { lat: 19.076, lon: 72.877 },
        })).report_id;
        await sleep(1300);
        await api.resume(S, token);
        const ms = await waitFor(async () => Boolean(await api.report(S, other)));
        return { ok: ms !== null, ms, note: 'Singapore missed a write while down, then fetched it' };
      });

      await step('token', async () => {
        const call = async (t) => { try { await api.syncNow(M, t); return 200; } catch (e) { return e.status; } };
        const [none, wrong] = [await call(''), await call('not-the-token')];
        if (none === 200) return { skip: true, ok: false, note: 'This cluster runs without a token (local development)' };
        return { ok: none === 401 && wrong === 401, note: `No token: ${none}. Wrong token: ${wrong}` };
      });

      await step('chain', async () => {
        const checks = await Promise.all(NODES.map((n) => api.verify(urls[n])));
        const heads = Object.fromEntries(await Promise.all(NODES.map(async (n) => [n, { state: 'up', heads: (await api.heads(urls[n])).heads }])));
        const { conflicts } = compareHeads(heads);
        const events = checks[0].events_checked;
        return { ok: checks.every((c) => c.ok) && conflicts.length === 0, note: `${events} events verified on each region, chain heads match` };
      });
    } finally {
      // Never leave the cluster split or a region paused, whatever happened above.
      await Promise.all(NODES.map((n) => api.resume(urls[n], token).catch(() => {})));
      for (const other of ['hyd', 'sin']) {
        await Promise.all([api.unblock(urls.mum, other, token).catch(() => {}), api.unblock(urls[other], 'mum', token).catch(() => {})]);
      }
      const done = Object.values(result);
      if (!cancelled.current) {
        setSummary({
          passed: done.filter((r) => r.status === 'pass').length,
          failed: done.filter((r) => r.status === 'fail').length,
          skipped: done.filter((r) => r.status === 'skip').length,
          seconds: ((performance.now() - began) / 1000).toFixed(1),
        });
        setRunning(false);
      }
    }
  };

  // ?autorun=1 starts the run as soon as the regions answer (used for testing).
  const auto = useRef(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('autorun') === '1' && ready && !needsToken && !auto.current) {
      auto.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, needsToken]);

  const counted = STEPS.length - (summary ? summary.skipped : 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Live tests</h1>
          <p className="page-sub">
            The same checks we run from the terminal, executed here against {target}. Each one is a real request to the
            running servers, and nothing existing is deleted.
          </p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary btn-lg" onClick={run} disabled={running || !ready || needsToken}>
          {running ? 'Running...' : `Run tests on ${cloud ? providers.join(' and ') : 'the local cluster'}`}
        </button>
      </div>

      {needsToken && (
        <div className="banner warn"><span className="dot warn" />Add the admin token in Settings first. Cutting links and crashing a region are protected actions.</div>
      )}
      {!ready && !needsToken && (
        <div className="banner warn"><span className="dot warn" />Waiting for all three regions to answer.</div>
      )}

      {summary && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`banner ${summary.failed ? 'bad' : 'ok'}`}>
          <span className={`dot ${summary.failed ? 'bad' : 'ok'}`} />
          {summary.failed ? `${summary.failed} of ${counted} checks failed` : `${summary.passed} of ${counted} checks passed on ${target}`}
          <span className="detail">
            {summary.seconds} s{summary.skipped ? `, ${summary.skipped} not applicable here` : ''}
          </span>
        </motion.div>
      )}

      <div className="grid-2 tests-grid">
        <Panel title="Checks" hint="Run in order. Timings are measured from this browser." flush>
          <div className="steps">
            {STEPS.map((s, i) => {
              const r = state[s.id] || {};
              const newGroup = i === 0 || STEPS[i - 1].group !== s.group;
              return (
                <div key={s.id}>
                  {newGroup && <div className="step-group">{s.group}</div>}
                  <motion.div layout className={`step-row ${r.status || ''}`}>
                    <Icon status={r.status} />
                    <div className="step-text">
                      <div className="step-title">{s.title}</div>
                      {r.note && <div className="step-note">{r.note}</div>}
                    </div>
                    {r.ms != null && r.status !== 'skip' && <span className="step-ms num">{r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(2)} s`}</span>}
                  </motion.div>
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="stack tests-side">
          <Panel title="What is happening on the servers" hint="Live view of the cluster while the checks run.">
            <Topology nodes={nodes} links={allLinks(nodes)} meta={meta} />
          </Panel>
          <Card className="stat-tile">
            <div className="label">Running against</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {NODES.map((n) => (
                <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <ProviderBadge provider={meta[n].provider} />
                  <span className="mono muted">{meta[n].regionCode}</span>
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
