#!/usr/bin/env node
const path = require('node:path');
const dotenv = require('dotenv');
const mqtt = require('mqtt');

const EARTH_RADIUS_KM = 6371;
const REGION_PRESETS = {
  paris: { name: 'Paris', lat: 48.8566, lng: 2.3522, radiusKm: 20 },
  london: { name: 'London', lat: 51.5072, lng: -0.1276, radiusKm: 22 },
  newyork: { name: 'New York', lat: 40.7128, lng: -74.006, radiusKm: 28 },
  singapore: { name: 'Singapore', lat: 1.3521, lng: 103.8198, radiusKm: 18 },
  tokyo: { name: 'Tokyo', lat: 35.6762, lng: 139.6503, radiusKm: 24 },
  sydney: { name: 'Sydney', lat: -33.8688, lng: 151.2093, radiusKm: 26 }
};

const cliTokens = process.argv.slice(2);

if (cliTokens.includes('-h') || cliTokens.includes('--help')) {
  console.log(`Usage: simulator [options]\n\n` +
    `Options:\n` +
    `  --host <hostname>        MQTT broker host (default: localhost)\n` +
    `  --port <number>          MQTT broker port (default: 1883)\n` +
    `  --topic <topic>          Telemetry topic (default: fleet/demo/telemetry)\n` +
    `  --qos <0|1|2>            Publish QoS level (default: 0)\n` +
    `  --vehicles <number>      Number of vehicles to simulate (default: 1)\n` +
    `  --max-messages <number>  Stop after publishing this many messages (default: unlimited)\n` +
    `  --rate <duration>        Base publish interval, accepts ms|s|m (default: 1s)\n` +
    `  --jitter <duration>      Publish jitter window (default: 0ms)\n` +
    `  --region <name>          Region label for generated vehicles (default: paris)\n` +
    `  --seed <value>           Optional seed for deterministic behaviour\n` +
    `  --help                   Show this message\n` +
    `\nEnvironment variables (take lower precedence than CLI):\n` +
    `  BROKER_HOST, BROKER_PORT, SIM_TOPIC, SIM_QOS, SIM_VEHICLES,\n` +
    `  SIM_MAX_MESSAGES, SIM_RATE, SIM_JITTER, SIM_REGION, SIM_SEED, SIM_HOST, SIM_PORT`);
  process.exit(0);
}

const dotenvResult = dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
  console.error('[simulator] failed to load environment variables from .env', dotenvResult.error);
  process.exit(1);
}

const DEFAULTS = {
  host: 'localhost',
  port: 1883,
  topic: 'fleet/demo/telemetry',
  qos: 0,
  vehicles: 1,
  maxMessages: 0,
  rate: 1000,
  jitter: 0,
  region: 'paris',
  seed: undefined
};

const ENV_ALIASES = {
  host: ['SIM_HOST', 'BROKER_HOST'],
  port: ['SIM_PORT', 'BROKER_PORT'],
  topic: ['SIM_TOPIC'],
  qos: ['SIM_QOS'],
  vehicles: ['SIM_VEHICLES'],
  maxMessages: ['SIM_MAX_MESSAGES'],
  rate: ['SIM_RATE'],
  jitter: ['SIM_JITTER'],
  region: ['SIM_REGION'],
  seed: ['SIM_SEED']
};

const cliArgs = parseCli(cliTokens);
const config = buildConfig(cliArgs);
const rng = createRng(config.seed);
const region = resolveRegion(config.region);
const vehicles = createVehicles(config.vehicles, region, rng);
const timers = new Map();
let shuttingDown = false;
let simulationStarted = false;
let offlineNotified = false;
let totalPublished = 0;

const client = mqtt.connect({
  protocol: 'mqtt',
  host: config.host,
  port: config.port,
  reconnectPeriod: 5000,
  connectTimeout: 30_000,
  keepalive: 30,
  queueQoSZero: true
});

client.on('connect', () => {
  offlineNotified = false;
  console.log('[simulator] connected', {
    host: config.host,
    port: config.port,
    topic: config.topic,
    qos: config.qos,
    vehicles: vehicles.length,
    rate: `${config.rate}ms`,
    jitter: `${config.jitter}ms`,
    region: region.slug,
    seed: config.seed ?? null
  });

  if (!simulationStarted) {
    simulationStarted = true;
    startSimulation();
  }
});

client.on('reconnect', () => {
  console.warn('[simulator] reconnecting to MQTT broker');
});

client.on('offline', () => {
  if (!offlineNotified) {
    offlineNotified = true;
    console.warn('[simulator] broker connection offline, telemetry will buffer until reconnect');
  }
});

client.on('close', () => {
  if (!shuttingDown) {
    console.warn('[simulator] MQTT connection closed');
  }
});

client.on('error', err => {
  console.error('[simulator] MQTT error', err);
});

process.on('SIGINT', () => initiateShutdown('SIGINT'));
process.on('SIGTERM', () => initiateShutdown('SIGTERM'));

function startSimulation() {
  console.log('[simulator] starting simulation', {
    vehicles: vehicles.length,
    region: region.slug,
    radiusKm: region.radiusKm
  });

  for (const vehicle of vehicles) {
    scheduleNextPublish(vehicle);
  }
}

function scheduleNextPublish(vehicle) {
  if (shuttingDown || (config.maxMessages > 0 && totalPublished >= config.maxMessages)) {
    return;
  }
  const delay = computePublishDelay(config.rate, config.jitter, rng);
  const timer = setTimeout(() => publishTelemetry(vehicle), delay);
  timers.set(vehicle.vehicleId, timer);
}

function publishTelemetry(vehicle) {
  if (shuttingDown) {
    return;
  }

  timers.delete(vehicle.vehicleId);

  const now = Date.now();
  const elapsedMs = vehicle.lastUpdateMs ? now - vehicle.lastUpdateMs : config.rate;
  advanceVehicle(vehicle, elapsedMs, region, rng);
  vehicle.lastUpdateMs = now;

  const payload = {
    vehicleId: vehicle.vehicleId,
    lat: Number(vehicle.lat.toFixed(6)),
    lng: Number(vehicle.lng.toFixed(6)),
    ts: new Date(now).toISOString(),
    fuelLevel: Number(vehicle.fuelLevel.toFixed(2)),
    engineStatus: vehicle.engineStatus
  };

  const message = JSON.stringify(payload);
  client.publish(config.topic, message, { qos: config.qos }, err => {
    if (err) {
      console.error('[simulator] publish failed', { vehicleId: vehicle.vehicleId, err });
      scheduleNextPublish(vehicle);
      return;
    }

    if (shuttingDown) {
      return;
    }

    if (!vehicle.reported) {
      vehicle.reported = true;
      console.log(`[simulator] first publish for ${vehicle.vehicleId}: ${message}`);
    }

    totalPublished += 1;

    if (config.maxMessages > 0 && totalPublished >= config.maxMessages) {
      console.log('[simulator] max messages reached, initiating shutdown', { maxMessages: config.maxMessages });
      initiateShutdown('max_messages');
      return;
    }

    scheduleNextPublish(vehicle);
  });
}

function advanceVehicle(vehicle, elapsedMs, regionInfo, rand) {
  const elapsedHours = elapsedMs / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return;
  }

  if (vehicle.engineStatus === 'running') {
    vehicle.speedKmh = clamp(vehicle.speedKmh + ((rand() - 0.5) * 12), 5, vehicle.maxSpeedKmh);
    vehicle.heading = normalizeBearing(vehicle.heading + (rand() - 0.5) * 25);

    const distanceKm = vehicle.speedKmh * elapsedHours;
    const nextPosition = movePoint(vehicle.lat, vehicle.lng, vehicle.heading, distanceKm);
    vehicle.lat = nextPosition.lat;
    vehicle.lng = nextPosition.lng;

    const fuelBurn = Math.max(0.05, distanceKm * 0.3);
    vehicle.fuelLevel = Math.max(0, vehicle.fuelLevel - fuelBurn);

    if (rand() < 0.07) {
      vehicle.engineStatus = 'idle';
      vehicle.speedKmh = 0;
    } else if (vehicle.fuelLevel <= 2) {
      vehicle.engineStatus = 'off';
      vehicle.speedKmh = 0;
    }
  } else if (vehicle.engineStatus === 'idle') {
    const idleDrain = elapsedHours * 1.2;
    vehicle.fuelLevel = Math.max(0, vehicle.fuelLevel - idleDrain);
    vehicle.speedKmh = 0;

    if (vehicle.fuelLevel <= 1) {
      vehicle.engineStatus = 'off';
    } else if (rand() < 0.45) {
      vehicle.engineStatus = 'running';
      vehicle.speedKmh = clamp(vehicle.cruiseSpeedKmh + (rand() - 0.5) * 10, 5, vehicle.maxSpeedKmh);
    }
  } else {
    if (vehicle.fuelLevel <= 1 && rand() < 0.12) {
      vehicle.fuelLevel = 70 + rand() * 25;
    }

    if (vehicle.fuelLevel > 5 && rand() < 0.5) {
      vehicle.engineStatus = 'idle';
    }

    vehicle.speedKmh = 0;
  }

  const distanceFromHome = haversine(vehicle.lat, vehicle.lng, vehicle.home.lat, vehicle.home.lng);
  if (distanceFromHome > vehicle.maxRadiusKm) {
    vehicle.heading = bearingBetween(vehicle.lat, vehicle.lng, vehicle.home.lat, vehicle.home.lng);
  }
}

function computePublishDelay(baseRate, jitter, rand) {
  if (jitter <= 0) {
    return baseRate;
  }
  const offset = (rand() * 2 - 1) * jitter;
  return Math.max(50, Math.round(baseRate + offset));
}

function createVehicles(count, regionInfo, rand) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(createVehicle(regionInfo, rand));
  }
  return results;
}

function createVehicle(regionInfo, rand) {
  const vehicleId = generateVehicleId(regionInfo.slug, rand);
  const home = pickStartingPoint(regionInfo, rand);
  const heading = rand() * 360;
  const cruiseSpeedKmh = 30 + rand() * 40;

  return {
    vehicleId,
    lat: home.lat,
    lng: home.lng,
    heading,
    speedKmh: cruiseSpeedKmh,
    cruiseSpeedKmh,
    maxSpeedKmh: 90 + rand() * 40,
    fuelLevel: 60 + rand() * 40,
    engineStatus: 'running',
    maxRadiusKm: regionInfo.radiusKm * (1.2 + rand() * 0.6),
    home,
    lastUpdateMs: Date.now()
  };
}

function generateVehicleId(prefix, rand) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet.charAt(Math.floor(rand() * alphabet.length));
  }
  return `${prefix}-${suffix}`;
}

function pickStartingPoint(regionInfo, rand) {
  const distanceKm = rand() * regionInfo.radiusKm;
  const bearing = rand() * 360;
  return movePoint(regionInfo.lat, regionInfo.lng, bearing, distanceKm);
}

function movePoint(lat, lng, bearingDeg, distanceKm) {
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearingRad = toRadians(bearingDeg);
  const latRad = toRadians(lat);
  const lngRad = toRadians(lng);

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinAD = Math.sin(angularDistance);
  const cosAD = Math.cos(angularDistance);

  const newLat = Math.asin(sinLat * cosAD + cosLat * sinAD * Math.cos(bearingRad));
  const newLng = lngRad + Math.atan2(
    Math.sin(bearingRad) * sinAD * cosLat,
    cosAD - sinLat * Math.sin(newLat)
  );

  return {
    lat: toDegrees(newLat),
    lng: normalizeLongitude(toDegrees(newLng))
  };
}

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function bearingBetween(lat1, lng1, lat2, lng2) {
  const dLng = toRadians(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRadians(lat2));
  const x = Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) - Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(dLng);
  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

function normalizeLongitude(value) {
  let result = value;
  while (result < -180) {
    result += 360;
  }
  while (result > 180) {
    result -= 360;
  }
  return result;
}

function normalizeBearing(value) {
  let result = value % 360;
  if (result < 0) {
    result += 360;
  }
  return result;
}

function toRadians(value) {
  return value * (Math.PI / 180);
}

function toDegrees(value) {
  return value * (180 / Math.PI);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveRegion(input) {
  const slug = String(input || '').toLowerCase();
  if (REGION_PRESETS[slug]) {
    return { slug, ...REGION_PRESETS[slug] };
  }

  console.warn('[simulator] unknown region provided, falling back to paris', { value: input });
  return { slug: 'paris', ...REGION_PRESETS.paris };
}

function initiateShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[simulator] received ${signal}, shutting down`);

  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();

  client.end(false, () => {
    console.log('[simulator] disconnected from broker');
    process.exit(0);
  });

  setTimeout(() => {
    console.warn('[simulator] force exiting after timeout');
    process.exit(1);
  }, 5000).unref();
}

function buildConfig(cliValues) {
  const result = {};

  for (const key of Object.keys(DEFAULTS)) {
    const rawValue = pickConfigValue(cliValues[key], key);

    try {
      result[key] = applyParser(key, rawValue);
    } catch (err) {
      console.error(`[simulator] ${err.message}`);
      process.exit(1);
    }
  }

  return result;
}

function pickConfigValue(cliValue, key) {
  if (cliValue !== undefined) {
    if (typeof cliValue === 'boolean') {
      throw new Error(`flag "--${key}" requires a value`);
    }
    return cliValue;
  }

  const envNames = ENV_ALIASES[key] || [];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined) {
      return process.env[envName];
    }
  }

  return DEFAULTS[key];
}

function applyParser(key, value) {
  switch (key) {
    case 'host':
    case 'topic':
    case 'region':
    case 'seed':
      return value === undefined ? undefined : String(value);
    case 'port':
      return coerceInteger('port', value, { min: 1, max: 65535 });
    case 'qos':
      return coerceInteger('qos', value, { min: 0, max: 2 });
    case 'vehicles':
      return coerceInteger('vehicles', value, { min: 1 });
    case 'maxMessages':
      return coerceInteger('maxMessages', value, { min: 0 });
    case 'rate':
    case 'jitter':
      return coerceDuration(key, value);
    default:
      return value;
  }
}

function coerceInteger(name, value, { min, max } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`invalid ${name} value: "${value}"`);
  }

  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }

  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }

  return parsed;
}

function coerceDuration(name, value) {
  if (typeof value === 'number') {
    return value;
  }

  const raw = String(value).trim().toLowerCase();

  if (raw.endsWith('ms')) {
    return coerceInteger(name, raw.slice(0, -2), { min: 0 });
  }

  if (raw.endsWith('s')) {
    const seconds = coerceInteger(name, raw.slice(0, -1), { min: 0 });
    return seconds * 1000;
  }

  if (raw.endsWith('m')) {
    const minutes = coerceInteger(name, raw.slice(0, -1), { min: 0 });
    return minutes * 60_000;
  }

  return coerceInteger(name, raw, { min: 0 });
}

function parseCli(tokens) {
  const values = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (!token.startsWith('--')) {
      continue;
    }

    const trimmed = token.slice(2);
    if (!trimmed) {
      continue;
    }

    if (trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      values[key] = rest.join('=');
      continue;
    }

    const next = tokens[i + 1];
    if (!next || next.startsWith('--')) {
      values[trimmed] = true;
      continue;
    }

    values[trimmed] = next;
    i += 1;
  }

  return values;
}

function createRng(seed) {
  if (seed === undefined) {
    return Math.random;
  }

  const seedString = String(seed);
  let state = 2166136261;
  for (let i = 0; i < seedString.length; i += 1) {
    state ^= seedString.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }

  return () => {
    state += 1;
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    const result = ((state ^ (state >>> 14)) >>> 0) / 4294967296;
    return result;
  };
}
