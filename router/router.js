import 'dotenv/config';
import express from 'express';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';

// ---------- Global crash guards ----------
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (router kept alive):', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (router kept alive):', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
});

// ---------- Config ----------
const PORT = Number(process.env.PORT ?? 8080);
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 15_000);
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 10_000);
// Only mark a backend unhealthy after this many consecutive probe failures.
// Prevents single network blips from flapping the backend and causing fake 503s.
const HEALTH_CHECK_FAILURE_THRESHOLD = Number(process.env.HEALTH_CHECK_FAILURE_THRESHOLD ?? 2);
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 600_000); // 10 min, must exceed backend job timeout

// Affinity cache: remembers which backend each unique request fingerprint went to,
// so retries of the same request always land on the same backend (so the backend's
// in-memory dedup correctly blocks the retry).
const AFFINITY_TTL_MS = Number(process.env.AFFINITY_TTL_MS ?? 10 * 60 * 1000); // 10 min

const BACKENDS = (process.env.BACKENDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (BACKENDS.length === 0) {
  console.error('[FATAL] No BACKENDS configured. Set BACKENDS env var to comma-separated URLs.');
  process.exit(1);
}

// ---------- State ----------
// backendUrl -> { healthy, lastCheck, error? }
const backendHealth = new Map();
BACKENDS.forEach(b => backendHealth.set(b, { healthy: true, lastCheck: 0 }));

// backendUrl -> count of currently in-flight requests being proxied to it.
// Drives least-loaded selection so traffic spreads naturally across backends.
const inFlightPerBackend = new Map();
BACKENDS.forEach(b => inFlightPerBackend.set(b, 0));

// dedupKey -> { backend, t }
// Records which backend each unique request fingerprint was sent to, so retries
// land on the same backend within AFFINITY_TTL_MS (critical for per-backend dedup).
const affinityCache = new Map();

// ---------- Hop-by-hop header stripping (RFC 7230 § 6.1) ----------
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'proxy-authenticate', 'proxy-authorization', 'upgrade'
]);
function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------- Affinity + routing ----------
// Must match the backend's dedup key formula so retries route consistently.
function buildDedupKey({ type, chatId, pageId, message, automation_name, idempotencyKey }) {
  if (idempotencyKey) return `explicit:${idempotencyKey}`;
  const payload = `${type}|${chatId}|${pageId}|${message ?? ''}|${automation_name ?? ''}`;
  return 'auto:' + crypto.createHash('sha1').update(payload).digest('hex');
}

function affinityGet(dedupKey) {
  const entry = affinityCache.get(dedupKey);
  if (!entry) return null;
  if (Date.now() - entry.t > AFFINITY_TTL_MS) {
    affinityCache.delete(dedupKey);
    return null;
  }
  // If the affined backend is gone or unhealthy, drop the entry so caller picks fresh.
  if (!BACKENDS.includes(entry.backend) || !backendHealth.get(entry.backend)?.healthy) {
    affinityCache.delete(dedupKey);
    return null;
  }
  return entry;
}

function affinitySet(dedupKey, backend) {
  affinityCache.set(dedupKey, { backend, t: Date.now() });
}

function trackInFlightStart(backend) {
  inFlightPerBackend.set(backend, (inFlightPerBackend.get(backend) ?? 0) + 1);
}

function trackInFlightEnd(backend) {
  const c = inFlightPerBackend.get(backend) ?? 0;
  inFlightPerBackend.set(backend, Math.max(0, c - 1));
}

// Pick the healthy backend with the fewest in-flight requests right now.
function pickLeastLoadedBackend() {
  const eligible = BACKENDS.filter(b => backendHealth.get(b)?.healthy);
  if (eligible.length === 0) return null;
  return eligible.sort((a, b) =>
    (inFlightPerBackend.get(a) ?? 0) - (inFlightPerBackend.get(b) ?? 0)
  )[0];
}

// Decide which backend should serve this request.
//  1. Affinity hit (retry of a recent request) -> same backend as before.
//  2. Otherwise -> least-loaded healthy backend right now.
function routeRequest({ dedupKey }) {
  const aff = affinityGet(dedupKey);
  if (aff) return { backend: aff.backend, decision: 'affinity' };

  const chosen = pickLeastLoadedBackend();
  if (!chosen) return { backend: null, decision: 'no-healthy-backend' };
  return { backend: chosen, decision: 'least-loaded' };
}

// Periodic cleanup of expired affinity entries so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of affinityCache.entries()) {
    if (now - v.t > AFFINITY_TTL_MS) affinityCache.delete(k);
  }
}, 60_000);

// ---------- Health checks ----------
function checkBackendHealth(backendUrl) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL('/healthz', backendUrl); }
    catch (e) { return resolve({ healthy: false, error: `bad URL: ${e.message}` }); }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      timeout: HEALTH_CHECK_TIMEOUT_MS
    }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      resolve({ healthy: ok, statusCode: res.statusCode });
    });
    req.on('error', (err) => resolve({ healthy: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ healthy: false, error: 'timeout' }); });
    req.end();
  });
}

async function runHealthChecks() {
  for (const backend of BACKENDS) {
    const probeResult = await checkBackendHealth(backend);
    const previous = backendHealth.get(backend);
    const previousFailures = previous?.consecutiveFailures ?? 0;

    // Count consecutive failures. Reset on any success.
    const consecutiveFailures = probeResult.healthy ? 0 : previousFailures + 1;

    // Only flip to unhealthy after N consecutive failures. Prevents single blips
    // (Cloudflare TLS handshakes, brief network latency, master under brief load)
    // from causing fake 503s for incoming traffic.
    const effectivelyHealthy = probeResult.healthy || consecutiveFailures < HEALTH_CHECK_FAILURE_THRESHOLD;

    backendHealth.set(backend, {
      healthy: effectivelyHealthy,
      consecutiveFailures,
      lastCheck: Date.now(),
      error: probeResult.error,
      statusCode: probeResult.statusCode
    });

    if (previous?.healthy !== effectivelyHealthy) {
      console.log(`Backend ${backend} health changed: ${previous?.healthy} -> ${effectivelyHealthy}${probeResult.error ? ` (last error: ${probeResult.error})` : ''}`);
    } else if (!probeResult.healthy) {
      // Log probe failures even while still considered healthy, for visibility.
      console.log(`Backend ${backend} probe failed (${consecutiveFailures}/${HEALTH_CHECK_FAILURE_THRESHOLD}): ${probeResult.error ?? 'no error message'}`);
    }
  }
}

setInterval(() => {
  runHealthChecks().catch(e => console.error('Health check loop error:', e.message));
}, HEALTH_CHECK_INTERVAL_MS);
runHealthChecks().catch(e => console.error('Initial health check error:', e.message));

// ---------- Express app ----------
const app = express();
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ---------- Forwarding ----------
function forwardTo(backendUrl, req, res) {
  let target;
  try { target = new URL(req.path, backendUrl); }
  catch (e) { return res.status(500).json({ error: `Bad backend URL ${backendUrl}: ${e.message}` }); }

  const lib = target.protocol === 'https:' ? https : http;
  const headers = stripHopByHop(req.headers);
  headers.host = target.host;
  if (req.rawBody) headers['content-length'] = req.rawBody.length;

  const proxyReq = lib.request({
    method: req.method,
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + (target.search || ''),
    headers,
    timeout: PROXY_TIMEOUT_MS
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, stripHopByHop(proxyRes.headers));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error to ${backendUrl}:`, err.message);
    if (res.headersSent) return;
    res.status(502).json({ error: `Backend ${backendUrl} unreachable: ${err.message}` });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Backend timeout' });
  });

  if (req.rawBody && req.rawBody.length > 0) proxyReq.write(req.rawBody);
  proxyReq.end();
}

// ---------- Routes ----------
app.get('/', (_req, res) => {
  res.json({
    service: 'ManyChat Clicker Router',
    status: 'running',
    config: {
      port: PORT,
      backends: BACKENDS,
      healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
      proxyTimeoutMs: PROXY_TIMEOUT_MS,
      affinityTtlMs: AFFINITY_TTL_MS,
      strategy: 'least-loaded with affinity-preserved dedup'
    }
  });
});

app.get('/healthz', (_req, res) => {
  const healthyBackends = BACKENDS.filter(b => backendHealth.get(b)?.healthy);
  res.status(healthyBackends.length > 0 ? 200 : 503).json({
    ok: healthyBackends.length > 0,
    healthyBackends: healthyBackends.length,
    totalBackends: BACKENDS.length
  });
});

app.get('/status', (_req, res) => {
  const backendStatus = BACKENDS.map(b => {
    const h = backendHealth.get(b);
    return {
      url: b,
      healthy: h?.healthy ?? false,
      lastCheck: h?.lastCheck ?? 0,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      lastError: h?.error,
      inFlight: inFlightPerBackend.get(b) ?? 0
    };
  });
  res.json({
    ok: true,
    backends: backendStatus,
    affinityCacheSize: affinityCache.size,
    totalInFlight: Array.from(inFlightPerBackend.values()).reduce((a, b) => a + b, 0)
  });
});

// Main route: /press is forwarded to the least-loaded healthy backend (or to the
// backend a previous identical request went to, if within the affinity window).
app.post('/press', (req, res) => {
  const body = req.body ?? {};
  const { pageId, type, chatId, message, automation_name } = body;
  const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];

  if (!pageId) {
    return res.status(400).json({ error: 'pageId is required' });
  }

  const dedupKey = buildDedupKey({ type, chatId, pageId, message, automation_name, idempotencyKey });
  const route = routeRequest({ dedupKey });

  if (!route.backend) {
    console.error(`No backend available: ${route.decision}`);
    return res.status(503).json({ error: `No backend available: ${route.decision}` });
  }

  if (route.decision === 'affinity') {
    console.log(`AFFINITY: routing to ${route.backend}`);
  } else {
    console.log(`LEAST-LOADED: routing to ${route.backend} (in-flight before: ${inFlightPerBackend.get(route.backend) ?? 0})`);
  }

  // Lock affinity so retries follow the same backend.
  affinitySet(dedupKey, route.backend);

  // Track in-flight for least-loaded calculation.
  trackInFlightStart(route.backend);
  let ended = false;
  const endOnce = () => {
    if (ended) return;
    ended = true;
    trackInFlightEnd(route.backend);
  };
  res.on('finish', endOnce);
  res.on('close', endOnce);

  forwardTo(route.backend, req, res);
});

// Catch-all: forward any other path to the first healthy backend (useful for
// admin endpoints like /healthz, /dedup-status, etc.).
app.use((req, res) => {
  const healthy = BACKENDS.find(b => backendHealth.get(b)?.healthy);
  if (!healthy) return res.status(503).json({ error: 'No healthy backends available' });
  forwardTo(healthy, req, res);
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`Router listening on :${PORT}`);
  console.log(`Backends (${BACKENDS.length}): ${BACKENDS.join(', ')}`);
  console.log(`Strategy: least-loaded with affinity-preserved dedup`);
  console.log(`Affinity cache TTL: ${AFFINITY_TTL_MS}ms`);
  console.log(`Health check: every ${HEALTH_CHECK_INTERVAL_MS}ms, timeout ${HEALTH_CHECK_TIMEOUT_MS}ms, threshold ${HEALTH_CHECK_FAILURE_THRESHOLD} consecutive failures`);
});
