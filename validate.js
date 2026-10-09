import { DEFAULT_NODE_ID } from './config.js';

const RANGES = {
  temperature: [-40, 125],
  humidity: [0, 100],
  waterDistance: [0, 1000], // cm
  mq2: [0, 4095],           // ESP32 12-bit ADC
  mq135: [0, 4095],
  soil: [0, 4095],
  rain: [0, 4095],
};

/**
 * Strict validation. A sensor that failed to read should be sent as null (or omitted).
 * Wrong types / out-of-range values reject the whole packet with HTTP 400.
 */
export function validatePayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }
  const errors = [];
  const reading = {};
  let valid = 0;

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = body[key];
    if (v === undefined || v === null) { reading[key] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${key}: must be a number`);
    else if (v < min || v > max) errors.push(`${key}: ${v} is outside ${min}..${max}`);
    else { reading[key] = v; valid++; }
  }

  const f = body.flame;
  if (f === undefined || f === null) reading.flame = null;
  else if (f === 0 || f === 1) { reading.flame = f; valid++; }
  else if (f === true || f === false) { reading.flame = f ? 1 : 0; valid++; }
  else errors.push('flame: must be 0 or 1');

  let nodeId = DEFAULT_NODE_ID;
  if (body.nodeId !== undefined) {
    if (typeof body.nodeId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(body.nodeId)) nodeId = body.nodeId;
    else errors.push('nodeId: 1-32 characters, letters, digits, "_" or "-"');
  }

  let location = null;
  const hasLat = body.lat !== undefined && body.lat !== null;
  const hasLon = body.lon !== undefined && body.lon !== null;
  if (hasLat || hasLon) {
    if (typeof body.lat === 'number' && typeof body.lon === 'number' &&
        Math.abs(body.lat) <= 90 && Math.abs(body.lon) <= 180) location = { lat: body.lat, lon: body.lon };
    else errors.push('lat/lon: both must be numbers within range');
  }

  if (body.simulated !== undefined && typeof body.simulated !== 'boolean') errors.push('simulated: must be boolean');
  if (!errors.length && valid === 0) errors.push('No valid sensor values supplied');

  return errors.length
    ? { ok: false, errors }
    : { ok: true, nodeId, reading, location, simulated: body.simulated === true };
}
