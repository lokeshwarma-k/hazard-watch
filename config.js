// Demonstration thresholds. Override per group with THRESHOLDS_JSON.
// Analog rain/soil sensors usually read LOWER when WETTER; MQ values are raw ADC (0-4095), not calibrated.
const defaults = {
  flood:  { warnBelowCm: 30, dangerBelowCm: 15 },          // distance sensor -> water surface
  rain:   { wetBelow: 2000, heavyBelow: 1000 },
  soil:   { wetBelow: 1800, saturatedBelow: 1200 },
  air:    { warnAbove: 1500, dangerAbove: 2500 },          // MQ-135 raw
  smoke:  { warnAbove: 1500, dangerAbove: 2500 },          // MQ-2 raw
  fire:   { tempWarnAbove: 45, flameActiveValue: 0 },      // most flame modules output 0 when flame is seen
};

let override = {};
try {
  if (process.env.THRESHOLDS_JSON) override = JSON.parse(process.env.THRESHOLDS_JSON);
} catch {
  console.error('THRESHOLDS_JSON is not valid JSON; using defaults');
}

export const THRESHOLDS = Object.fromEntries(
  Object.entries(defaults).map(([k, v]) => [k, { ...v, ...(override[k] || {}) }]),
);
export const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS) || 10000;
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 14;
export const DEFAULT_NODE_ID = process.env.DEFAULT_NODE_ID || 'esp32-01';

let locations = {};
try {
  if (process.env.NODE_LOCATIONS) locations = JSON.parse(process.env.NODE_LOCATIONS);
} catch {
  console.error('NODE_LOCATIONS is not valid JSON; ignoring');
}
const validLoc = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Coordinates configured by the operator. Never invented: returns null when not configured. */
export function configuredLocation(nodeId) {
  const l = locations[nodeId];
  if (l && validLoc(Number(l.lat), Number(l.lon))) return { lat: Number(l.lat), lon: Number(l.lon) };
  const lat = parseFloat(process.env.NODE_LAT);
  const lon = parseFloat(process.env.NODE_LON);
  return validLoc(lat, lon) ? { lat, lon } : null;
}
