const TIMEOUT_MS = 2500;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(base, path, { method = 'GET', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Admin-Token'] = token;
    const res = await fetch(base + path, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data && (data.message || data.error)) || res.statusText || 'Request failed';
      throw new ApiError(detail, res.status);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('No response (timed out)', 0);
    if (err instanceof ApiError) throw err;
    throw new ApiError('Unreachable', 0);
  } finally {
    clearTimeout(timer);
  }
}

const post = (base, path, body, token) => request(base, path, { method: 'POST', body: body ?? {}, token });

export const api = {
  health: (b) => request(b, '/healthz'),
  status: (b) => request(b, '/status'),
  reports: (b) => request(b, '/reports'),
  report: (b, id) => request(b, `/reports/${id}`),
  syncNow: (b, t) => post(b, '/admin/sync-now', {}, t),
  cluster: (b) => request(b, '/cluster'),
  conflicts: (b) => request(b, '/conflicts'),
  heads: (b) => request(b, '/audit/heads'),
  verify: (b) => request(b, '/audit/verify'),
  history: (b, id) => request(b, `/reports/${id}/history`),
  create: (b, body) => post(b, '/reports', body),
  patch: (b, id, body) => request(b, `/reports/${id}`, { method: 'PATCH', body }),
  block: (b, peer, t) => post(b, '/admin/block', { peer }, t),
  unblock: (b, peer, t) => post(b, '/admin/unblock', { peer }, t),
  pause: (b, t) => post(b, '/admin/pause', {}, t),
  resume: (b, t) => post(b, '/admin/resume', {}, t),
  clock: (b, offset_ms, t) => post(b, '/admin/clock', { offset_ms }, t),
  reset: (b, t) => post(b, '/admin/reset', {}, t),
  resolve: (b, id, chosen_event_id, operator, t) =>
    post(b, `/conflicts/${id}/resolve`, { chosen_event_id, operator }, t),
};
