import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { NODES } from './config';

/** Light or dark, remembered in the browser, defaulting to the system setting. */
export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('codeastra.theme', theme); } catch { /* private mode */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}

async function readNode(base) {
  try {
    const [status, reports, conflicts, heads] = await Promise.all([
      api.status(base),
      api.reports(base),
      api.conflicts(base),
      api.heads(base).catch(() => null), // the baseline has no audit endpoints
    ]);
    return {
      state: 'up',
      status,
      reports: reports.reports,
      conflicts: conflicts.conflicts,
      heads: heads ? heads.heads : null,
    };
  } catch (err) {
    return { state: err.status === 503 ? 'paused' : 'down', error: err.message };
  }
}

/** Polls every node of one cluster once a second. A slow poll never stacks up behind itself. */
export function useCluster(urls) {
  const [snapshot, setSnapshot] = useState({ nodes: {}, at: 0 });
  const key = urls ? JSON.stringify(urls) : '';

  useEffect(() => {
    if (!urls) {
      setSnapshot({ nodes: {}, at: 0 });
      return undefined;
    }
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      const entries = await Promise.all(NODES.map(async (n) => [n, await readNode(urls[n])]));
      busy = false;
      if (alive) setSnapshot({ nodes: Object.fromEntries(entries), at: Date.now() });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return snapshot;
}

/** Remembers which values changed since the last render, to flash them briefly. */
export function usePrevious(value) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref.current;
}
