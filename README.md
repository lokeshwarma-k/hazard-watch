# Hazard Watch

React + Vite frontend, Express API, PostgreSQL storage (JSON file fallback for local development).
The ESP32 posts readings straight to the API over Wi-Fi (no gateway).

## Run locally
```bash
npm install
cp .env.example .env           # optional; export the variables or use your shell
npm run dev:server             # API on :3000 (stores to ./data.json when DATABASE_URL is unset)
npm run dev                    # Vite on :5173, proxies /api to :3000
```
Or build and serve everything from Express: `npm run build && npm start` → http://localhost:3000

Test without hardware: `npm run simulate` sends readings flagged `"simulated": true` as node `demo-sim`
(shown with a SIMULATED badge). Real ESP32 data is never simulated.

## Deploy on Render
1. Push this folder to GitHub.
2. Render → New → Blueprint → select the repo (uses `render.yaml`: web service + Postgres, `INGEST_KEY` auto-generated).
   Manual setup: Build `npm install && npm run build`, Start `npm start`, health check `/api/health`,
   env `NODE_ENV=production`, `INGEST_KEY=<long random string>`, `DATABASE_URL=<Render Postgres internal URL>`.
3. Copy the generated `INGEST_KEY` from the service's Environment tab into your ESP32 firmware.
   Render's free Postgres expires after a period; use a paid plan for anything long-lived.

## ESP32 request
`POST https://<your-app>.onrender.com/api/sensor-data` with headers `Content-Type: application/json` and `x-api-key: <INGEST_KEY>`:
```json
{"temperature":29.0,"humidity":68.0,"waterDistance":42.5,"mq2":320,"mq135":410,"soil":1850,"rain":720,"flame":1}
```
- Optional: `"nodeId":"esp32-01"` (default `esp32-01`), `"lat"`/`"lon"` (real coordinates only).
- Send `null` (or omit) for a sensor that failed to read (e.g. DHT11). Wrong types or out-of-range values return HTTP 400 with details.
- Returns `201 {"ok":true,"stored":true,...}` only after the reading is saved.

## API
| Endpoint | Purpose |
|---|---|
| `POST /api/sensor-data` | validate + store a reading, auto-register the node (needs `x-api-key`) |
| `GET /api/latest` | nodes (online/offline, last seen, latest reading, hazards), alerts, summary, thresholds |
| `GET /api/history?range=15m\|1h\|6h\|24h&nodeId=` | averaged points for charts |
| `GET /api/health` | `{name,status,version,storage,hazards,...}`; 503 if storage is down |

A node is **offline** when no reading arrived for 10 s (`OFFLINE_AFTER_MS`). Hazard cards of an offline node show "No data".

## Configuration notes
- Thresholds are demonstration values in `server/config.js`; override with `THRESHOLDS_JSON` (see `.env.example`).
- MQ-2 / MQ-135 values are **raw ADC readings**, not calibrated gas concentrations.
- Rain/soil assume lower raw value = wetter. Flame assumes the module outputs `0` when flame is detected
  (`fire.flameActiveValue`); set it to `1` if yours is active-high.
- Water pollution is always "Sensor unavailable" (no turbidity sensor).
- The map shows a marker only for real coordinates: `NODE_LAT`/`NODE_LON`, `NODE_LOCATIONS`, or `lat`/`lon` sent by the node.
