import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import Convergence from './components/Convergence';
import Hero from './components/Hero';
import Infrastructure from './components/Infrastructure';
import Overview from './components/Overview';
import RegionLogs from './components/RegionLogs';
import Settings from './components/Settings';
import { ToastProvider } from './components/Toast';
import TopBar from './components/TopBar';
import { api } from './api';
import { NODES, environments, loadCloudUrls, loadToken, saveCloudUrls, saveToken } from './config';
import { ThemeContext, useTheme } from './hooks';
import { INFRA } from './infra';

const VIEWS = ['overview', 'infrastructure', 'logs', 'convergence'];

// A hash such as #overview, #infrastructure or #logs opens the console directly.
function fromHash() {
  const h = window.location.hash.replace('#', '');
  if (VIEWS.includes(h)) return { entered: true, view: h };
  if (h === 'app' || h === 'engine') return { entered: true, view: 'overview' };
  return { entered: false, view: 'overview' };
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const initial = useMemo(fromHash, []);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [entered, setEntered] = useState(initial.entered);
  const [view, setView] = useState(initial.view);
  const [env, setEnv] = useState(params.get('env') === 'cloud' ? 'cloud' : 'local');
  const [system, setSystem] = useState('engine');
  const [cloudUrls, setCloudUrls] = useState(loadCloudUrls);
  const [token, setToken] = useState(loadToken);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [results, setResults] = useState(null);
  const [logRegion, setLogRegion] = useState('mum');

  // Clicking a region on the Infrastructure page opens that region's log.
  const openLogs = (region) => {
    setLogRegion(region);
    setView('logs');
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}results.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setResults)
      .catch(() => setResults(null));
  }, []);

  // When a cloud server serves this page itself (at /ui), ask it where its peers are and
  // open on the cloud cluster, so a visitor needs no setup at all.
  useEffect(() => {
    const host = window.location.hostname;
    const onThisComputer = host === 'localhost' || host === '127.0.0.1';
    if (!window.location.pathname.startsWith('/ui') || onThisComputer) return; // local nodes are not cloud
    api.cluster(window.location.origin)
      .then((c) => {
        if (c && c.nodes && NODES.every((n) => typeof c.nodes[n] === 'string')) {
          setCloudUrls(c.nodes);
          setEnv('cloud');
        }
      })
      .catch(() => {});
  }, []);

  const envs = environments(cloudUrls);
  const current = envs[env];
  const meta = INFRA[env];

  const changeEnv = (next) => {
    setEnv(next);
    if (next === 'cloud') setSystem('engine');
  };

  const enter = (target = 'overview') => {
    setView(VIEWS.includes(target) ? target : 'overview');
    setEntered(true);
    window.scrollTo(0, 0);
  };
  const home = () => { setEntered(false); window.location.hash = ''; window.scrollTo(0, 0); };

  const saveSettings = (urls, secret) => {
    saveCloudUrls(urls);
    saveToken(secret);
    setCloudUrls(urls);
    setToken(secret);
    setSettingsOpen(false);
  };

  return (
    <ThemeContext.Provider value={theme}>
      <ToastProvider>
        <AnimatePresence mode="wait">
          {!entered ? (
            <Hero key="hero" onEnter={enter} onToggleTheme={toggleTheme} results={results} />
          ) : (
            <motion.div
              key="app" className="app"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}
            >
              <TopBar
                view={view} onView={setView} env={env} onEnv={changeEnv} theme={theme}
                onToggleTheme={toggleTheme} onSettings={() => setSettingsOpen(true)} onHome={home}
              />
              <main className="container">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={`${view}-${env}-${system}`}
                    initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.24, ease: [0.22, 0.61, 0.36, 1] }}
                  >
                    {view === 'infrastructure' && (
                      <Infrastructure urls={current.engine} meta={meta} token={token} env={env} onOpenLogs={openLogs} />
                    )}
                    {view === 'logs' && (
                      <RegionLogs urls={current.engine} meta={meta} region={logRegion} onRegion={setLogRegion} />
                    )}
                    {view === 'convergence' && <Convergence urls={current.engine} env={env} />}
                    {view === 'overview' && (
                      <Overview
                        engineUrls={current.engine} baselineUrls={current.baseline} meta={meta}
                        token={token} env={env} system={system} onSystem={setSystem}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </main>
              <AnimatePresence>
                {settingsOpen && (
                  <Settings cloudUrls={cloudUrls} token={token} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </ToastProvider>
    </ThemeContext.Provider>
  );
}
