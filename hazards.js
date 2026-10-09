export const HAZARD_LABELS = {
  flood: 'Flood',
  landslide: 'Landslide',
  airPollution: 'Air Pollution',
  waterPollution: 'Water Pollution',
  forestFire: 'Forest Fire',
};
export const ALERTABLE = ['flood', 'landslide', 'airPollution', 'forestFire'];

const H = (status, reason) => ({ status, reason });
const r1 = (v) => Math.round(v * 10) / 10;
const toneOf = (s) =>
  s == null ? null
    : ['SATURATED', 'HEAVY', 'HIGH', 'DANGER', 'DETECTED'].includes(s) ? 'danger'
    : ['WET', 'ELEVATED', 'WARNING'].includes(s) ? 'warn' : 'ok';

/** Turns one reading into hazard statuses + per-sensor states. Pure function. */
export function assess(r, T) {
  const n = (k) => (typeof r[k] === 'number' ? r[k] : null);
  const d = n('waterDistance'), rain = n('rain'), soil = n('soil');
  const mq2 = n('mq2'), mq135 = n('mq135'), temp = n('temperature'), flameRaw = n('flame');

  const floodState = d === null ? null : d <= T.flood.dangerBelowCm ? 'DANGER' : d <= T.flood.warnBelowCm ? 'WARNING' : 'NORMAL';
  const rainState = rain === null ? null : rain <= T.rain.heavyBelow ? 'HEAVY' : rain <= T.rain.wetBelow ? 'WET' : 'DRY';
  const soilState = soil === null ? null : soil <= T.soil.saturatedBelow ? 'SATURATED' : soil <= T.soil.wetBelow ? 'WET' : 'NORMAL';
  const smokeState = mq2 === null ? null : mq2 >= T.smoke.dangerAbove ? 'HIGH' : mq2 >= T.smoke.warnAbove ? 'ELEVATED' : 'NORMAL';
  const airState = mq135 === null ? null : mq135 >= T.air.dangerAbove ? 'HIGH' : mq135 >= T.air.warnAbove ? 'ELEVATED' : 'NORMAL';
  const flame = flameRaw === null ? null : flameRaw === T.fire.flameActiveValue;

  const flood =
    d === null ? H('UNKNOWN', 'Water-level reading missing')
    : floodState === 'DANGER' ? H('DANGER', `Water ${r1(d)} cm from sensor (danger at ${T.flood.dangerBelowCm} cm or less)`)
    : floodState === 'WARNING' ? H('WARNING', `Water ${r1(d)} cm from sensor (warning at ${T.flood.warnBelowCm} cm or less)`)
    : H('SAFE', `Water ${r1(d)} cm from sensor`);

  const mix = soilState && rainState ? `Soil ${soilState.toLowerCase()}, rain ${rainState.toLowerCase()}` : '';
  const landslide =
    soil === null || rain === null ? H('UNKNOWN', 'Soil or rain reading missing')
    : soilState === 'SATURATED' && rainState === 'HEAVY' ? H('DANGER', mix)
    : soilState === 'SATURATED' || (soilState === 'WET' && rainState !== 'DRY') ? H('WARNING', mix)
    : H('SAFE', mix);

  const airPollution =
    mq135 === null ? H('UNKNOWN', 'MQ-135 reading missing')
    : airState === 'HIGH' ? H('DANGER', `MQ-135 raw ${mq135} (uncalibrated) is high`)
    : airState === 'ELEVATED' ? H('WARNING', `MQ-135 raw ${mq135} (uncalibrated) is elevated`)
    : H('SAFE', `MQ-135 raw ${mq135} (uncalibrated)`);

  let forestFire;
  if (flame === null && mq2 === null && temp === null) forestFire = H('UNKNOWN', 'Flame, smoke and temperature readings missing');
  else if (flame === true) forestFire = H('DANGER', 'Flame sensor triggered');
  else if (smokeState === 'HIGH' && temp !== null && temp >= T.fire.tempWarnAbove)
    forestFire = H('DANGER', `High MQ-2 smoke/gas reading with ${r1(temp)} °C`);
  else if (smokeState === 'HIGH' || smokeState === 'ELEVATED' || (temp !== null && temp >= T.fire.tempWarnAbove)) {
    const parts = [];
    if (smokeState && smokeState !== 'NORMAL') parts.push(`MQ-2 raw ${mq2} ${smokeState.toLowerCase()}`);
    if (temp !== null && temp >= T.fire.tempWarnAbove) parts.push(`temperature ${r1(temp)} °C`);
    forestFire = H('WARNING', parts.join('; '));
  } else forestFire = H('SAFE', `${flame === false ? 'No flame detected' : 'Flame sensor missing'}; smoke and temperature within limits`);

  const waterPollution = { status: 'UNAVAILABLE', reason: 'Sensor unavailable — no turbidity sensor connected' };

  const S = (state) => ({ state, tone: toneOf(state) });
  return {
    hazards: { flood, landslide, airPollution, waterPollution, forestFire },
    sensors: {
      flood: S(floodState), rain: S(rainState), soil: S(soilState), smoke: S(smokeState), air: S(airState),
      flame: S(flame === null ? null : flame ? 'DETECTED' : 'NONE'),
    },
  };
}

/** Hazards of an offline node: never present stale data as current. */
export function offlineHazards(h) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) =>
    k === 'waterPollution' ? [k, v]
      : [k, { status: 'UNKNOWN', reason: 'Node offline — no current data', lastKnown: v.status }]));
}
