// Convergence preview server (separate from engine/). No database, no replication.
//   node convergence/server.js        then open http://localhost:4000
// Reads the two endpoint URLs from convergence/.env and fetches them server-side
// (avoids browser CORS and the ngrok interstitial page).
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const CACHE = path.join(DIR, "last_fetch.json");

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(DIR, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* handled below: missing URLs are reported to the page */ }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("WEB_") || k === "PORT")) };
}

const env = loadEnv();
const PORT = Number(env.PORT || 4000);
const TIMEOUT_MS = Number(env.WEB_FETCH_TIMEOUT_MS || 8000);
const ENDPOINTS = { all: env.WEB_INCIDENTS_URL, latest: env.WEB_INCIDENTS_LATEST_URL };

async function fetchOne(url) {
  if (!url) return { ok: false, error: "URL is not set in convergence/.env" };
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "ngrok-skip-browser-warning": "true" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ngrokCode = res.headers.get("ngrok-error-code");
    if (ngrokCode) {
      return { ok: false, status: res.status,
               error: `The tunnel is not reachable (ngrok ${ngrokCode}). Ask the web team to start ngrok.` };
    }
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch {
      return { ok: false, status: res.status, error: "Response was not valid JSON." };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `API answered HTTP ${res.status}.`, data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return { ok: false, error: timedOut ? `No answer within ${TIMEOUT_MS / 1000} s.` : `Network error: ${e.cause?.code || e.message}` };
  }
}

async function runFetch() {
  const [all, latest] = await Promise.all([fetchOne(ENDPOINTS.all), fetchOne(ENDPOINTS.latest)]);
  const result = { fetched_at: new Date().toISOString(), source: "live", all, latest };
  if (all.ok || latest.ok) {
    fs.writeFileSync(CACHE, JSON.stringify(result, null, 2));
    return result;
  }
  // Both failed: fall back to the last good copy so the page still has something to show.
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    return { ...cached, source: "cache", cached_from: cached.fetched_at, fetched_at: result.fetched_at,
             live_errors: { all: all.error, latest: latest.error } };
  } catch {
    return result;
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/fetch" && req.method === "POST") {
    return send(res, 200, "application/json", JSON.stringify(await runFetch()));
  }
  if (url.pathname === "/api/config") {
    // Never expose more than the host names; the full URLs stay on the server.
    const host = (u) => { try { return new URL(u).host; } catch { return null; } };
    return send(res, 200, "application/json", JSON.stringify({
      all: host(ENDPOINTS.all), latest: host(ENDPOINTS.latest) }));
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(DIR, "index.html")));
  }
  send(res, 404, "text/plain", "not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Convergence preview: http://localhost:${PORT}`);
  if (!ENDPOINTS.all || !ENDPOINTS.latest) console.log("Warning: set WEB_INCIDENTS_URL and WEB_INCIDENTS_LATEST_URL in convergence/.env");
});
