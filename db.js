// Storage layer with one interface and two backends:
//   - PostgreSQL (DATABASE_URL set)  -> used on Render
//   - JSON file  (data.json)         -> local development only
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const KEYS = ['temperature', 'humidity', 'waterDistance', 'mq2', 'mq135', 'soil', 'rain', 'flame'];
const num = (x) => (x == null ? null : Number(x));

export async function createDb() {
  if (process.env.DATABASE_URL) return pgBackend(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_FILE_STORAGE !== '1') {
    throw new Error('DATABASE_URL is required in production (file storage is not durable on Render).');
  }
  return fileBackend(process.env.DATA_FILE || path.resolve('data.json'));
}

/* ------------------------------ PostgreSQL ------------------------------ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION, lon DOUBLE PRECISION, simulated BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS readings(
  id BIGSERIAL PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), ts TIMESTAMPTZ NOT NULL,
  temperature REAL, humidity REAL, water_distance REAL, mq2 INTEGER, mq135 INTEGER,
  soil INTEGER, rain INTEGER, flame SMALLINT);
CREATE INDEX IF NOT EXISTS readings_node_ts ON readings(node_id, ts DESC);
CREATE TABLE IF NOT EXISTS alerts(
  id BIGSERIAL PRIMARY KEY, node_id TEXT NOT NULL, hazard TEXT NOT NULL, level TEXT NOT NULL,
  message TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS alerts_active ON alerts(node_id, hazard) WHERE resolved_at IS NULL;`;

const rowReading = (r) => ({
  temperature: num(r.temperature), humidity: num(r.humidity), waterDistance: num(r.water_distance),
  mq2: num(r.mq2), mq135: num(r.mq135), soil: num(r.soil), rain: num(r.rain), flame: num(r.flame),
});

async function pgBackend(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (e) => log('error', `pg pool error: ${e.message}`));

  return {
    name: 'postgres',
    async init() {
      for (let i = 1; ; i++) {
        try { await pool.query(SCHEMA); return; } catch (e) {
          if (i >= 5) throw e;
          log('warn', `database not ready (${e.message}); retry ${i}/5`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    },
    async ping() { await pool.query('SELECT 1'); },
    async saveReading(nodeId, r, loc, simulated, ts) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const up = await c.query(
          `INSERT INTO nodes(id, first_seen, last_seen, lat, lon, simulated) VALUES($1,$2,$2,$3,$4,$5)
           ON CONFLICT(id) DO UPDATE SET last_seen=EXCLUDED.last_seen,
             lat=COALESCE(EXCLUDED.lat, nodes.lat), lon=COALESCE(EXCLUDED.lon, nodes.lon), simulated=EXCLUDED.simulated
           RETURNING (xmax = 0) AS inserted`,
          [nodeId, ts, loc?.lat ?? null, loc?.lon ?? null, simulated]);
        await c.query(
          `INSERT INTO readings(node_id,ts,temperature,humidity,water_distance,mq2,mq135,soil,rain,flame)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [nodeId, ts, r.temperature, r.humidity, r.waterDistance, r.mq2, r.mq135, r.soil, r.rain, r.flame]);
        await c.query('COMMIT');
        return { firstSeen: up.rows[0].inserted };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    async getNodes() {
      const { rows } = await pool.query('SELECT * FROM nodes ORDER BY id');
      return rows.map((n) => ({ id: n.id, firstSeen: n.first_seen, lastSeen: n.last_seen, lat: n.lat, lon: n.lon, simulated: n.simulated }));
    },
    async getLatestReadings() {
      const { rows } = await pool.query('SELECT DISTINCT ON (node_id) * FROM readings ORDER BY node_id, ts DESC');
      return new Map(rows.map((r) => [r.node_id, { ts: r.ts, reading: rowReading(r) }]));
    },
    async history(nodeId, since, bucketSec) {
      const { rows } = await pool.query(
        `SELECT floor(extract(epoch FROM ts)/$3::int)*$3::int*1000 AS t,
                avg(temperature) AS temperature, avg(humidity) AS humidity, avg(water_distance) AS water_distance,
                avg(mq2) AS mq2, avg(mq135) AS mq135, avg(soil) AS soil, avg(rain) AS rain, max(flame) AS flame
         FROM readings WHERE node_id=$1 AND ts>=$2 GROUP BY 1 ORDER BY 1`,
        [nodeId, since, bucketSec]);
      return rows.map((r) => ({ t: Number(r.t), ...rowReading(r) }));
    },
    async getActiveAlerts() {
      const { rows } = await pool.query('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY started_at');
      return rows.map((a) => ({ id: Number(a.id), nodeId: a.node_id, hazard: a.hazard, level: a.level, message: a.message, startedAt: a.started_at }));
    },
    async openAlert(a) {
      const { rows } = await pool.query(
        'INSERT INTO alerts(node_id,hazard,level,message,started_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [a.nodeId, a.hazard, a.level, a.message, a.startedAt]);
      return Number(rows[0].id);
    },
    async resolveAlert(id, at) { await pool.query('UPDATE alerts SET resolved_at=$2 WHERE id=$1', [id, at]); },
    async cleanup(cutoff) {
      const r = await pool.query('DELETE FROM readings WHERE ts < $1', [cutoff]);
      await pool.query('DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < $1', [cutoff]);
      return r.rowCount;
    },
    async close() { await pool.end(); },
  };
}

/* ---------------------------- JSON file (dev) ---------------------------- */
const MAX_FILE_READINGS = 20000;

async function fileBackend(file) {
  let state = { nodes: {}, readings: [], alerts: [], nextAlertId: 1 };
  let timer = null;

  const flush = () => {
    timer = null;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(state));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { log('error', `could not write ${file}: ${e.message}`); }
  };
  const scheduleFlush = () => { if (!timer) { timer = setTimeout(flush, 1000); timer.unref?.(); } };

  return {
    name: `file (${path.basename(file)})`,
    async init() {
      log('warn', `Using JSON file storage at ${file}. Development only; set DATABASE_URL for deployment.`);
      if (fs.existsSync(file)) {
        try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
        catch (e) { log('error', `could not read ${file} (${e.message}); starting empty`); }
      }
    },
    async ping() { if (!state) throw new Error('storage unavailable'); },
    async saveReading(nodeId, r, loc, simulated, ts) {
      const iso = ts.toISOString();
      const existing = state.nodes[nodeId];
      state.nodes[nodeId] = {
        id: nodeId, firstSeen: existing?.firstSeen ?? iso, lastSeen: iso,
        lat: loc?.lat ?? existing?.lat ?? null, lon: loc?.lon ?? existing?.lon ?? null, simulated,
      };
      state.readings.push({ nodeId, ts: iso, ...r });
      if (state.readings.length > MAX_FILE_READINGS) state.readings.splice(0, state.readings.length - MAX_FILE_READINGS);
      scheduleFlush();
      return { firstSeen: !existing };
    },
    async getNodes() {
      return Object.values(state.nodes).sort((a, b) => a.id.localeCompare(b.id))
        .map((n) => ({ ...n, firstSeen: new Date(n.firstSeen), lastSeen: new Date(n.lastSeen) }));
    },
    async getLatestReadings() {
      const out = new Map();
      for (const r of state.readings) out.set(r.nodeId, r); // later entries overwrite earlier ones
      return new Map([...out].map(([id, r]) => [id, { ts: new Date(r.ts), reading: Object.fromEntries(KEYS.map((k) => [k, r[k] ?? null])) }]));
    },
    async history(nodeId, since, bucketSec) {
      const buckets = new Map();
      const from = since.getTime();
      for (const r of state.readings) {
        const t = Date.parse(r.ts);
        if (r.nodeId !== nodeId || t < from) continue;
        const b = Math.floor(t / 1000 / bucketSec) * bucketSec * 1000;
        let acc = buckets.get(b);
        if (!acc) buckets.set(b, (acc = Object.fromEntries(KEYS.map((k) => [k, { s: 0, n: 0, m: null }]))));
        for (const k of KEYS) if (typeof r[k] === 'number') { acc[k].s += r[k]; acc[k].n++; acc[k].m = Math.max(acc[k].m ?? -Infinity, r[k]); }
      }
      return [...buckets].sort((a, b) => a[0] - b[0]).map(([t, acc]) => ({
        t, ...Object.fromEntries(KEYS.map((k) => [k, acc[k].n ? (k === 'flame' ? acc[k].m : acc[k].s / acc[k].n) : null])),
      }));
    },
    async getActiveAlerts() {
      return state.alerts.filter((a) => !a.resolvedAt).map((a) => ({ ...a, startedAt: new Date(a.startedAt) }));
    },
    async openAlert(a) {
      const id = state.nextAlertId++;
      state.alerts.push({ id, nodeId: a.nodeId, hazard: a.hazard, level: a.level, message: a.message, startedAt: a.startedAt.toISOString(), resolvedAt: null });
      scheduleFlush();
      return id;
    },
    async resolveAlert(id, at) {
      const a = state.alerts.find((x) => x.id === id);
      if (a) a.resolvedAt = at.toISOString();
      scheduleFlush();
    },
    async cleanup(cutoff) {
      const before = state.readings.length;
      state.readings = state.readings.filter((r) => Date.parse(r.ts) >= cutoff.getTime());
      state.alerts = state.alerts.filter((a) => !a.resolvedAt || Date.parse(a.resolvedAt) >= cutoff.getTime());
      scheduleFlush();
      return before - state.readings.length;
    },
    async close() { if (timer) clearTimeout(timer); flush(); },
  };
}
