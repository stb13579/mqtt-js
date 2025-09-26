#!/usr/bin/env node
const http = require('node:http');
const { URL } = require('node:url');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const pino = require('pino');

const logger = pino({ name: 'backend', level: process.env.LOG_LEVEL || 'info' });

const ENGINE_STATUS_VALUES = new Set(['running', 'idle', 'off']);

const brokerHost = process.env.BROKER_HOST || 'localhost';
const brokerPort = Number(process.env.BROKER_PORT || 1883);
const brokerUsername = envOrNull('BROKER_USERNAME');
const brokerPassword = envOrNull('BROKER_PASSWORD');
const brokerUseTls = parseBoolean(process.env.BROKER_TLS, false);
const brokerRejectUnauthorized = parseBoolean(process.env.BROKER_TLS_REJECT_UNAUTHORIZED, true);
const brokerClientId = envOrNull('BROKER_CLIENT_ID');
const subscriptionTopic = process.env.SUB_TOPIC || 'fleet/+/telemetry';
const httpPort = Number(process.env.PORT || 8080);
const cacheLimit = Number(process.env.VEHICLE_CACHE_SIZE || 1000);
const messageWindowMs = Number(process.env.MESSAGE_RATE_WINDOW_MS || 60_000);
const vehicleTtlMs = parseVehicleTtl(process.env.VEHICLE_TTL_MS, 60_000);

const state = {
  mqttConnected: false,
  totalMessages: 0,
  invalidMessages: 0,
  messageTimestamps: []
};

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

// WebSocket payloads stay intentionally small; the frontend relies on this schema.
// Any changes must bump the version and keep fields backward-compatible where possible.
const WS_PAYLOAD_VERSION = 1;

class VehicleStore {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }

  get(id) {
    return this.map.get(id);
  }

  set(id, value) {
    if (this.map.has(id)) {
      this.map.delete(id);
    }
    this.map.set(id, value);

    if (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
        logger.debug({ vehicleId: oldestKey }, 'Evicted vehicle due to cache limit');
      }
    }
  }

  size() {
    return this.map.size;
  }

  values() {
    return this.map.values();
  }

  entries() {
    return this.map.entries();
  }

  delete(id) {
    this.map.delete(id);
  }
}

const vehicleStore = new VehicleStore(cacheLimit);
const wsClients = new Set();
let expiryTimer = null;

const httpServer = http.createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Allow', 'GET');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let pathname = req.url || '/';
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = parsedUrl.pathname;
  } catch (err) {
    logger.warn({ err, url: req.url }, 'Failed to parse request URL');
    pathname = '/';
  }

  switch (pathname) {
    case '/healthz':
      sendJson(res, 200, { status: 'ok' });
      return;
    case '/readyz':
      sendJson(res, state.mqttConnected ? 200 : 503, {
        status: state.mqttConnected ? 'ready' : 'not_ready'
      });
      return;
    case '/stats':
      sendJson(res, 200, buildStats());
      return;
    default:
      sendJson(res, 404, { error: 'Not found' });
  }
});

const wss = new WebSocket.Server({ server: httpServer, path: '/stream' });

wss.on('connection', socket => {
  wsClients.add(socket);
  logger.info({ clients: wsClients.size }, 'WebSocket client connected');

  for (const vehicle of vehicleStore.values()) {
    sendSocketUpdate(socket, vehicle);
  }

  socket.on('close', () => {
    wsClients.delete(socket);
    logger.info({ clients: wsClients.size }, 'WebSocket client disconnected');
  });

  socket.on('error', err => {
    logger.warn({ err }, 'WebSocket client error');
  });
});

httpServer.listen(httpPort, () => {
  logger.info({ port: httpPort }, 'HTTP server listening');
});

const mqttOptions = {
  protocol: brokerUseTls ? 'mqtts' : 'mqtt',
  host: brokerHost,
  port: brokerPort,
  keepalive: 30
};

if (brokerUsername) {
  mqttOptions.username = brokerUsername;
}

if (brokerPassword) {
  mqttOptions.password = brokerPassword;
}

if (brokerUseTls) {
  mqttOptions.rejectUnauthorized = brokerRejectUnauthorized;
}

if (brokerClientId) {
  mqttOptions.clientId = brokerClientId;
}

const mqttClient = mqtt.connect(mqttOptions);

if (vehicleTtlMs > 0) {
  const intervalMs = Math.max(1000, Math.min(vehicleTtlMs, 15_000));
  expiryTimer = setInterval(() => pruneExpiredVehicles(vehicleTtlMs), intervalMs);
  if (typeof expiryTimer.unref === 'function') {
    expiryTimer.unref();
  }
  logger.info({ vehicleTtlMs, intervalMs }, 'Vehicle TTL enforcement enabled');
} else {
  logger.info('Vehicle TTL enforcement disabled');
}

mqttClient.on('connect', () => {
  state.mqttConnected = true;
  logger.info({
    host: brokerHost,
    port: brokerPort,
    protocol: mqttOptions.protocol,
    username: brokerUsername ? '[configured]' : undefined,
    subscriptionTopic
  }, 'Connected to broker');
  mqttClient.subscribe(subscriptionTopic, err => {
    if (err) {
      logger.error({ err }, 'Subscription failed');
      process.exit(1);
    }
    logger.info({ topic: subscriptionTopic }, 'Subscription complete');
  });
});

mqttClient.on('reconnect', () => {
  logger.warn('Reconnecting to MQTT broker');
});

mqttClient.on('close', () => {
  state.mqttConnected = false;
  logger.warn('MQTT connection closed');
});

mqttClient.on('error', err => {
  logger.error({ err }, 'MQTT error');
});

mqttClient.on('message', (receivedTopic, payload) => {
  const raw = payload.toString();
  const parsed = tryParseJson(raw);
  if (!parsed.ok) {
    state.invalidMessages += 1;
    logger.warn({ topic: receivedTopic, raw, error: parsed.error }, 'Invalid telemetry payload');
    return;
  }

  const validation = validateTelemetry(parsed.value);
  if (!validation.ok) {
    state.invalidMessages += 1;
    logger.warn({ topic: receivedTopic, raw, error: validation.error }, 'Telemetry validation failed');
    return;
  }

  const message = validation.value;
  const previous = vehicleStore.get(message.vehicleId);
  const speed = previous ? computeSpeed(previous, message) : 0;
  const enriched = {
    vehicleId: message.vehicleId,
    lat: message.lat,
    lng: message.lng,
    ts: message.ts,
    speed,
    fuelLevel: message.fuelLevel,
    engineStatus: message.engineStatus,
    lastSeen: new Date().toISOString()
  };

  vehicleStore.set(message.vehicleId, enriched);
  state.totalMessages += 1;
  recordMessageTimestamp(Date.now());

  broadcastUpdate(enriched);
  logger.debug({ topic: receivedTopic, vehicleId: message.vehicleId }, 'Processed telemetry');
});

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function buildStats() {
  const now = Date.now();
  pruneOldTimestamps(now);
  const windowSeconds = messageWindowMs / 1000;
  const perSecond = state.messageTimestamps.length === 0
    ? 0
    : state.messageTimestamps.length / windowSeconds;

  return {
    totalMessages: state.totalMessages,
    invalidMessages: state.invalidMessages,
    vehiclesTracked: vehicleStore.size(),
    connectedClients: wsClients.size,
    messageRatePerSecond: Number(perSecond.toFixed(3)),
    windowSeconds
  };
}

function tryParseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: 'invalid_json' };
  }
}

function validateTelemetry(payload) {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'payload must be an object' };
  }

  const { vehicleId, lat, lng, ts, fuelLevel, engineStatus } = payload;

  if (typeof vehicleId !== 'string' || vehicleId.trim() === '') {
    return { ok: false, error: 'vehicleId must be a non-empty string' };
  }

  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: 'lat must be a finite number between -90 and 90' };
  }

  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) {
    return { ok: false, error: 'lng must be a finite number between -180 and 180' };
  }

  if (ts === undefined || ts === null) {
    return { ok: false, error: 'ts is required' };
  }

  const timestamp = new Date(ts);
  if (Number.isNaN(timestamp.valueOf())) {
    return { ok: false, error: 'ts must be a valid date' };
  }

  if (!isFiniteNumber(fuelLevel) || fuelLevel < 0 || fuelLevel > 100) {
    return { ok: false, error: 'fuelLevel must be a finite number between 0 and 100' };
  }

  if (typeof engineStatus !== 'string' || !ENGINE_STATUS_VALUES.has(engineStatus.toLowerCase())) {
    return { ok: false, error: 'engineStatus must be one of running|idle|off' };
  }

  return {
    ok: true,
    value: {
      vehicleId: vehicleId.trim(),
      lat: Number(lat),
      lng: Number(lng),
      ts: timestamp.toISOString(),
      fuelLevel: Number(fuelLevel),
      engineStatus: engineStatus.toLowerCase()
    }
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function computeSpeed(previous, current) {
  const prevTime = Date.parse(previous.ts);
  const currTime = Date.parse(current.ts);
  if (!Number.isFinite(prevTime) || !Number.isFinite(currTime)) {
    return 0;
  }

  const deltaMs = currTime - prevTime;
  if (deltaMs <= 0) {
    return 0;
  }

  const distanceKm = haversine(previous.lat, previous.lng, current.lat, current.lng);
  const deltaHours = deltaMs / 3_600_000;
  if (deltaHours === 0) {
    return 0;
  }

  return distanceKm / deltaHours;
}

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = deg => deg * (Math.PI / 180);
  const R = 6371; // Earth radius in kilometers.

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function recordMessageTimestamp(now) {
  state.messageTimestamps.push(now);
  pruneOldTimestamps(now);
}

function pruneOldTimestamps(now) {
  while (state.messageTimestamps.length > 0 && now - state.messageTimestamps[0] > messageWindowMs) {
    state.messageTimestamps.shift();
  }
}

function broadcastUpdate(vehicle) {
  const payload = JSON.stringify(formatVehiclePayload(vehicle));
  for (const socket of wsClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

function broadcastRemoval(vehicleId) {
  const payload = JSON.stringify({
    type: 'vehicle_remove',
    version: WS_PAYLOAD_VERSION,
    vehicleId
  });

  for (const socket of wsClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

function sendSocketUpdate(socket, vehicle) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(formatVehiclePayload(vehicle)));
  }
}

function formatVehiclePayload(vehicle) {
  const telemetry = {
    timestamp: vehicle.ts,
    speed: Number.isFinite(vehicle.speed) ? Number(vehicle.speed) : null,
    fuelLevel: Number.isFinite(vehicle.fuelLevel) ? Number(vehicle.fuelLevel) : null,
    engineStatus: typeof vehicle.engineStatus === 'string' ? vehicle.engineStatus : null
  };

  return {
    type: 'vehicle_update',
    version: WS_PAYLOAD_VERSION,
    vehicleId: vehicle.vehicleId,
    position: {
      lat: vehicle.lat,
      lng: vehicle.lng
    },
    telemetry,
    filters: {
      engineStatus: telemetry.engineStatus,
      fuelLevel: telemetry.fuelLevel
    },
    lastSeen: vehicle.lastSeen
  };
}

function shutdown() {
  logger.info('Shutting down backend');
  if (expiryTimer) {
    clearInterval(expiryTimer);
  }
  wss.close(() => logger.info('WebSocket server closed'));
  httpServer.close(() => logger.info('HTTP server closed'));
  mqttClient.end(false, () => {
    logger.info('MQTT client disconnected');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function parseVehicleTtl(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function pruneExpiredVehicles(ttlMs) {
  const now = Date.now();
  const expiredIds = [];
  for (const [vehicleId, vehicle] of vehicleStore.entries()) {
    const lastSeen = Date.parse(vehicle?.lastSeen);
    if (!Number.isFinite(lastSeen)) {
      continue;
    }
    if (now - lastSeen >= ttlMs) {
      expiredIds.push(vehicleId);
    }
  }

  for (const vehicleId of expiredIds) {
    vehicleStore.delete(vehicleId);
    broadcastRemoval(vehicleId);
    logger.debug({ vehicleId }, 'Vehicle expired due to TTL and was removed');
  }
}
