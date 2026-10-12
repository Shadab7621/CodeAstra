import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import ClusterView from './components/ClusterView';
import Compare from './components/Compare';
import Hero from './components/Hero';
import Settings from './components/Settings';
import { ToastProvider } from './components/Toast';
import TopBar from './components/TopBar';
import { environments, loadCloudUrls, loadToken, saveCloudUrls, saveToken } from './config';
import { useTheme } from './hooks';

// A hash such as #app, #baseline or #compare opens the dashboard directly (handy for demos).
function fromHash() {
  const h = window.location.hash.replace('#', '');
  if (['engine', 'baseline', 'compare'].includes(h)) return { entered: true, view: h };
  if (h === 'app') return { entered: true, view: 'engine' };
  return { entered: false, view: 'engine' };
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const initial = useMemo(fromHash, []);
  const [entered, setEntered] = useState(initial.entered);
  const [view, setView] = useState(initial.view);
  const [env, setEnv] = useState('local');
  const [cloudUrls, setCloudUrls] = useState(loadCloudUrls);
  const [token, setToken] = useState(loadToken);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}results.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setResults)
      .catch(() => setResults(null));
  }, []);

  const envs = environments(cloudUrls);
  const current = envs[env];

  const changeEnv = (next) => {
    setEnv(next);
    if (next === 'cloud' && view !== 'engine') setView('engine');
  };

  const enter = () => { setEntered(true); window.scrollTo(0, 0); };
  const home = () => { setEntered(false); window.location.hash = ''; };

  const saveSettings = (urls, secret) => {
    saveCloudUrls(urls);
    saveToken(secret);
    setCloudUrls(urls);
    setToken(secret);
    setSettingsOpen(false);
  };

  return (
    <ToastProvider>
      <AnimatePresence mode="wait">
        {!entered ? (
          <Hero key="hero" onEnter={enter} theme={theme} onToggleTheme={toggleTheme} results={results} />
        ) : (
          <motion.div
            key="app"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <TopBar
              view={view}
              onView={setView}
              env={env}
              onEnv={changeEnv}
              theme={theme}
              onToggleTheme={toggleTheme}
              onSettings={() => setSettingsOpen(true)}
              onHome={home}
            />
            <main className="container">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${view}-${env}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {view === 'compare' ? (
                    <Compare engineUrls={envs.local.engine} baselineUrls={envs.local.baseline} results={results} />
                  ) : (
                    <ClusterView
                      urls={view === 'baseline' ? current.baseline : current.engine}
                      kind={view === 'baseline' ? 'baseline' : 'engine'}
                      providers={current.providers}
                      token={token}
                      env={env}
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
  );
}
