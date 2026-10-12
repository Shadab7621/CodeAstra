export const NODES = ['mum', 'hyd', 'sin'];

export const REGION = {
  mum: { name: 'Mumbai', short: 'MUM' },
  hyd: { name: 'Hyderabad', short: 'HYD' },
  sin: { name: 'Singapore', short: 'SIN' },
};

const local = (base) => ({
  mum: `http://127.0.0.1:${base + 1}`,
  hyd: `http://127.0.0.1:${base + 2}`,
  sin: `http://127.0.0.1:${base + 3}`,
});

// Cloud addresses of the current deployment. They are editable in Settings and kept in the
// browser, because the addresses change whenever the cluster is redeployed.
export const DEFAULT_CLOUD = {
  mum: 'http://13.200.213.148:8001',
  hyd: 'http://18.60.126.62:8002',
  sin: 'http://4.193.189.41:8003',
};

const CLOUD_KEY = 'disastersync.cloud';
const TOKEN_KEY = 'disastersync.token';

export function loadCloudUrls() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
    if (saved && NODES.every((n) => typeof saved[n] === 'string')) return saved;
  } catch { /* fall through */ }
  return DEFAULT_CLOUD;
}

export function saveCloudUrls(urls) {
  try { localStorage.setItem(CLOUD_KEY, JSON.stringify(urls)); } catch { /* private mode */ }
}

export function loadToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function saveToken(token) {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}

export function environments(cloudUrls) {
  return {
    local: {
      label: 'Local',
      providers: { mum: 'Local', hyd: 'Local', sin: 'Local' },
      engine: local(8000),
      baseline: local(9000),
    },
    cloud: {
      label: 'Cloud',
      providers: { mum: 'AWS', hyd: 'AWS', sin: 'Azure' },
      engine: cloudUrls,
      baseline: null,
    },
  };
}
