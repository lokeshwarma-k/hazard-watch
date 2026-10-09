import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createDb } from './db.js';
import { THRESHOLDS, OFFLINE_AFTER_MS, RETENTION_DAYS, configuredLocation } from './config.js';
import { validatePayload } from './validate.js';
import { assess, offlineHazards, ALERTABLE, HAZARD_LABELS } from './hazards.js';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const INGEST_KEY = process.env.INGEST_KEY || '';

if (isProd && !INGEST_KEY) {
  log('error', 'INGEST_KEY must be set in production. Refusing to start without an API key for ESP32 uploads.');
  process.exit(1);
}
if (!INGEST_KEY) log('warn', 'INGEST_KEY not set: POST /api/sensor-data is open (acceptable for local development only).');

let db;
try { db = await createDb(); await db.init(); }
catch (e) { log('error', `storage init failed: ${e.message}`); process.exit(1); }
log('info', `Storage backend: ${db.name}`);

/* Active alerts are kept in memory (loaded from storage) so a hazard raises ONE alert until its level changes. */
const alertState = new Map();
for (const a of await db.getActiveAlerts()) alertState.set(`${a.nodeId}|${a.hazard}`, a);

async function syncAlerts(nodeId, hazards, now) {
  for (const hazard of ALERTABLE) {
    const h = hazards[hazard];
    const key = `${nodeId}|${hazard}`;
    const cur = alertState.get(key);
    if (h.status === 'WARNING' || h.status === 'DANGER') {
      if (cur && cur.level === h.status) continue;
      if (cur) await db.resolveAlert(cur.id, now);
      const a = { nodeId, hazard, level: h.status, message: h.reason, startedAt: now };
      a.id = await db.openAlert(a);
      alertState.set(key, a);
      log('info', `ALERT ${h.status} ${nodeId} ${hazard}: ${h.reason}`);
    } else if (h.status === 'SAFE' && cur) {
      await db.resolveAlert(cur.id, now);
      alertState.delete(key);
      log('info', `ALERT cleared ${nodeId} ${hazard}`);
    }
  }
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

if (process.env.CORS_ORIGIN) {
  app.use('/api', (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

function requireKey(req, res, next) {
  if (!INGEST_KEY) return next();
  const given = Buffer.from(req.get('x-api-key') || '');
  const want = Buffer.from(INGEST_KEY);
  if (given.length === want.length && timingSafeEqual(given, want)) return next();
  log('warn', `rejected POST from ${req.ip}: bad or missing x-api-key`);
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

/* ------------------------------- API routes ------------------------------ */
app.get('/api/health', async (req, res) => {
  const base = { name: 'Hazard Watch API', version: '2.0', storage: db.name, hazards: Object.keys(HAZARD_LABELS), uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() };
  try { await db.ping(); res.json({ ...base, status: 'online' }); }
  catch (e) { log('error', `health check failed: ${e.message}`); res.status(503).json({ ...base, status: 'degraded', error: 'storage_unavailable' }); }
});

app.post('/api/sensor-data', requireKey, express.json({ limit: '2kb' }), async (req, res) => {
  const v = validatePayload(req.body ?? null);
  if (!v.ok) {
    log('warn', `invalid payload from ${req.ip}: ${v.errors.join('; ')}`);
    return res.status(400).json({ ok: false, errors: v.errors });
  }
  const now = new Date();
  try {
    const { firstSeen } = await db.saveReading(v.nodeId, v.reading, v.location, v.simulated, now);
    if (firstSeen) log('info', `registered new node ${v.nodeId}`);
  } catch (e) {
    log('error', `failed to store reading from ${v.nodeId}: ${e.message}`);
    return res.status(503).json({ ok: false, error: 'storage_failed' });
  }
  try { await syncAlerts(v.nodeId, assess(v.reading, THRESHOLDS).hazards, now); }
  catch (e) { log('error', `alert update failed for ${v.nodeId}: ${e.message}`); }
  res.status(201).json({ ok: true, stored: true, nodeId: v.nodeId, receivedAt: now.toISOString() });
});

app.get('/api/latest', async (req, res) => {
  try {
    const [rows, latest] = await Promise.all([db.getNodes(), db.getLatestReadings()]);
    const nowMs = Date.now();
    const nodes = rows.map((n) => {
      const last = latest.get(n.id);
      const ageMs = Math.max(0, nowMs - new Date(n.lastSeen).getTime());
      const online = ageMs <= OFFLINE_AFTER_MS;
      const a = last ? assess(last.reading, THRESHOLDS) : null;
      const cfg = configuredLocation(n.id);
      const location = cfg || (n.lat != null && n.lon != null ? { lat: n.lat, lon: n.lon } : null);
      return {
        id: n.id, online, simulated: n.simulated,
        firstSeen: new Date(n.firstSeen).toISOString(), lastSeen: new Date(n.lastSeen).toISOString(),
        ageSeconds: Math.round(ageMs / 100) / 10, location,
        reading: last ? { ...last.reading, receivedAt: new Date(last.ts).toISOString() } : null,
        sensors: a?.sensors ?? null,
        hazards: a ? (online ? a.hazards : offlineHazards(a.hazards)) : null,
      };
    });
    const live = nodes.filter((n) => n.online && n.hazards);
    const levels = live.flatMap((n) => Object.values(n.hazards).map((h) => h.status));
    const alerts = [...alertState.values()]
      .map((a) => ({ id: a.id, nodeId: a.nodeId, hazard: a.hazard, label: HAZARD_LABELS[a.hazard], level: a.level, message: a.message, startedAt: new Date(a.startedAt).toISOString() }))
      .sort((x, y) => (x.level === y.level ? y.startedAt.localeCompare(x.startedAt) : x.level === 'DANGER' ? -1 : 1));
    res.set('Cache-Control', 'no-store').json({
      serverTime: new Date(nowMs).toISOString(),
      offlineAfterSeconds: OFFLINE_AFTER_MS / 1000,
      thresholds: THRESHOLDS,
      summary: {
        nodesTotal: nodes.length, nodesOnline: nodes.filter((n) => n.online).length,
        nodesOffline: nodes.filter((n) => !n.online).length,
        activeHazards: levels.filter((s) => s === 'WARNING' || s === 'DANGER').length,
        warnings: levels.filter((s) => s === 'WARNING').length, dangers: levels.filter((s) => s === 'DANGER').length,
      },
      nodes, alerts,
    });
  } catch (e) {
    log('error', `GET /api/latest failed: ${e.message}`);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

const RANGES = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
app.get('/api/history', async (req, res) => {
  const range = req.query.range || '1h';
  if (!RANGES[range]) return res.status(400).json({ error: 'invalid_range', allowed: Object.keys(RANGES) });
  try {
    let nodeId = req.query.nodeId;
    if (nodeId !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(String(nodeId))) return res.status(400).json({ error: 'invalid_nodeId' });
    if (!nodeId) {
      const nodes = await db.getNodes();
      nodeId = nodes.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))[0]?.id;
    }
    if (!nodeId) return res.set('Cache-Control', 'no-store').json({ range, nodeId: null, bucketSeconds: null, count: 0, points: [], message: 'No node has reported yet' });
    const bucketSeconds = Math.ceil(RANGES[range] / 300);
    const rows = await db.history(nodeId, new Date(Date.now() - RANGES[range] * 1000), bucketSeconds);
    const round = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const points = rows.map((p) => ({
      t: p.t, temperature: round(p.temperature), humidity: round(p.humidity), waterDistance: round(p.waterDistance),
      mq2: round(p.mq2), mq135: round(p.mq135), soil: round(p.soil), rain: round(p.rain), flame: p.flame,
    }));
    res.set('Cache-Control', 'no-store').json({ range, nodeId, bucketSeconds, count: points.length, points });
  } catch (e) {
    log('error', `GET /api/history failed: ${e.message}`);
    res.status(503).json({ error: 'storage_unavailable' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

/* ------------------------ Frontend (built by Vite) ----------------------- */
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
} else {
  log('warn', 'dist/ not found: run "npm run build" to serve the frontend (or use "npm run dev" with Vite).');
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'payload_too_large' });
  log('error', `unhandled error: ${err.stack || err.message}`);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

const cleanupTimer = setInterval(async () => {
  try {
    const n = await db.cleanup(new Date(Date.now() - RETENTION_DAYS * 86400000));
    if (n) log('info', `retention cleanup removed ${n} old readings`);
  } catch (e) { log('error', `cleanup failed: ${e.message}`); }
}, 3600000);
cleanupTimer.unref();

const server = app.listen(PORT, '0.0.0.0', () => log('info', `Hazard Watch API listening on port ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log('info', `${sig} received, shutting down`);
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  });
}
