import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import { NODES } from './config';

export const ThemeContext = createContext('dark');
export const useThemeName = () => useContext(ThemeContext);

/** Light or dark, remembered in the browser, defaulting to the system setting. */
export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('disastersync.theme', theme); } catch { /* private mode */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}

async function readNode(base) {
  try {
    const started = performance.now();
    const statusCall = api.status(base).then((s) => ({ s, rtt: Math.round(performance.now() - started) }));
    const [timed, reports, conflicts, heads] = await Promise.all([
      statusCall,
      api.reports(base),
      api.conflicts(base),
      api.heads(base).catch(() => null), // the baseline has no audit endpoints
    ]);
    return {
      state: 'up',
      status: timed.s,
      rtt: timed.rtt, // round trip from this browser to the node, in milliseconds
      reports: reports.reports,
      conflicts: conflicts.conflicts,
      heads: heads ? heads.heads : null,
    };
  } catch (err) {
    if (err.status === 503) return { state: 'paused', error: err.message };
    // A paused node still answers its health check. Older servers sent the 503 without
    // cross-origin headers, so the browser saw a network error; this tells the two apart.
    try {
      await api.health(base);
      return { state: 'paused', error: 'Paused' };
    } catch {
      return { state: 'down', error: err.message };
    }
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
