const path = require('node:path');
const pino = require('pino');

function envOrNull(name) {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? null : value;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseWindowList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map(part => Number(part.trim()))
    .filter(num => Number.isFinite(num) && num > 0)
    .map(num => Math.trunc(num));
}

const defaultRollupWindow = parseNumber(process.env.TELEMETRY_ROLLUP_WINDOW_SECONDS, 300);
const extraRollupWindows = parseWindowList(process.env.TELEMETRY_ROLLUP_WINDOWS);
const rollupWindows = Array.from(new Set([defaultRollupWindow, ...extraRollupWindows]))
  .filter(windowSeconds => Number.isFinite(windowSeconds) && windowSeconds > 0)
  .map(windowSeconds => Math.trunc(windowSeconds))
  .sort((a, b) => a - b);
const primaryRollupWindow = rollupWindows.length > 0 ? rollupWindows[0] : defaultRollupWindow;

const config = {
  logLevel: process.env.LOG_LEVEL || 'info',
  broker: {
    host: process.env.BROKER_HOST || 'localhost',
    port: parseNumber(process.env.BROKER_PORT, 1883),
    username: envOrNull('BROKER_USERNAME'),
    password: envOrNull('BROKER_PASSWORD'),
    useTls: parseBoolean(process.env.BROKER_TLS, false),
    rejectUnauthorized: parseBoolean(process.env.BROKER_TLS_REJECT_UNAUTHORIZED, true),
    clientId: envOrNull('BROKER_CLIENT_ID')
  },
  subscriptionTopic: process.env.SUB_TOPIC || 'fleet/+/telemetry',
  httpPort: parseNumber(process.env.PORT, 8080),
  cacheLimit: parseNumber(process.env.VEHICLE_CACHE_SIZE, 1000),
  messageWindowMs: parseNumber(process.env.MESSAGE_RATE_WINDOW_MS, 60_000),
  vehicleTtlMs: parseNumber(process.env.VEHICLE_TTL_MS, 60_000),
  websocket: {
    path: '/stream',
    payloadVersion: 1
  },
  telemetryDb: {
    path: process.env.TELEMETRY_DB_PATH || path.join(process.cwd(), 'data', 'telemetry.db'),
    rollupWindowSeconds: primaryRollupWindow,
    rollupWindows,
    rollupIntervalMs: parseNumber(process.env.TELEMETRY_ROLLUP_INTERVAL_MS, 60_000),
    rollupCatchUpWindows: parseNumber(process.env.TELEMETRY_ROLLUP_CATCHUP_WINDOWS, 1)
  },
  grpc: {
    enabled: parseBoolean(process.env.GRPC_ENABLED, true),
    host: process.env.GRPC_HOST || '0.0.0.0',
    port: parseNumber(process.env.GRPC_PORT, 0),
    streamIntervalMs: parseNumber(process.env.GRPC_STREAM_INTERVAL_MS, 1_000)
  }
};

const logger = pino({ name: 'backend', level: config.logLevel });

module.exports = { config, logger };
