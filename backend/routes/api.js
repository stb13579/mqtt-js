const http = require('node:http');
const { URL } = require('node:url');
const { applyCors } = require('../middleware/cors');
const { handleRequestError } = require('../middleware/error-handler');
const { calculateRate } = require('../utils/message-metrics');

function createApiServer({ config, logger, state, vehicleStore, telemetryRepository, getClientCount }) {
  const server = http.createServer((req, res) => {
    try {
      if (applyCors(req, res)) {
        return;
      }

      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET,OPTIONS');
        return sendJson(res, { error: 'Method not allowed' });
      }

      let parsedUrl;
      let pathname = '/';
      try {
        parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        pathname = parsedUrl.pathname;
      } catch (err) {
        logger.warn({ err, url: req.url }, 'Failed to parse request URL');
      }

      switch (pathname) {
        case '/healthz':
          return sendJson(res, { status: 'ok' });
        case '/readyz':
          return sendJson(res, {
            status: state.mqttConnected ? 'ready' : 'not_ready'
          }, state.mqttConnected ? 200 : 503);
        case '/stats':
          return sendJson(res, buildStats({ config, state, vehicleStore, getClientCount }));
        case '/telemetry/summary':
          return handleTelemetrySummary({
            res,
            url: parsedUrl,
            config,
            logger,
            telemetryRepository
          });
        case '/telemetry/history':
          return handleTelemetryHistory({
            res,
            url: parsedUrl,
            telemetryRepository,
            config,
            logger
          });
        default:
          res.statusCode = 404;
          return sendJson(res, { error: 'Not found' });
      }
    } catch (err) {
      handleRequestError(err, req, res, logger);
    }
  });

  server.on('clientError', (err, socket) => {
    logger.warn({ err }, 'HTTP client error');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function sendJson(res, payload, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function buildStats({ config, state, vehicleStore, getClientCount }) {
  const rate = calculateRate(state, config.messageWindowMs, Date.now());
  return {
    totalMessages: state.totalMessages,
    invalidMessages: state.invalidMessages,
    vehiclesTracked: vehicleStore.size(),
    connectedClients: typeof getClientCount === 'function' ? getClientCount() : 0,
    messageRatePerSecond: Number(rate.toFixed(3)),
    windowSeconds: config.messageWindowMs / 1000
  };
}

function handleTelemetrySummary({ res, url, config, logger, telemetryRepository }) {
  if (!telemetryRepository) {
    res.statusCode = 501;
    return sendJson(res, { error: 'Telemetry summary not available' });
  }

  const params = url?.searchParams;
  const now = new Date();
  const end = params?.get('end') || now.toISOString();
  const durationSeconds = clampPositiveInt(params?.get('durationSeconds'), 900);
  const windowSeconds = clampPositiveInt(params?.get('windowSeconds'), config.telemetryDb?.rollupWindowSeconds || 300);
  const aggregateParam = params?.getAll('aggregate') || [];
  const aggregateList = aggregateParam.flatMap(value => value.split(',')).map(item => item.trim()).filter(Boolean);
  const vehicleIds = parseVehicleIds(params);

  const startIso = params?.get('start') || new Date(Date.parse(end) - durationSeconds * 1000).toISOString();
  const endIso = end;

  const buckets = telemetryRepository.queryHistoricalAggregates({
    vehicleIds,
    start: startIso,
    end: endIso,
    aggregates: aggregateList,
    windowSeconds
  });

  const summary = summariseBuckets(buckets);

  return sendJson(res, {
    windowSeconds,
    durationSeconds,
    range: {
      start: startIso,
      end: endIso
    },
    vehicleIds,
    buckets,
    metrics: summary
  });
}

function handleTelemetryHistory({ res, url, telemetryRepository, config }) {
  if (!telemetryRepository) {
    res.statusCode = 501;
    return sendJson(res, { error: 'Telemetry history not available' });
  }

  const params = url?.searchParams;
  const limit = clampPositiveInt(params?.get('limit'), 100);
  const durationSeconds = clampPositiveInt(params?.get('durationSeconds'), 600);
  const end = params?.get('end') || new Date().toISOString();
  const start = params?.get('start') || new Date(Date.parse(end) - durationSeconds * 1000).toISOString();
  const vehicleIds = parseVehicleIds(params);

  const result = telemetryRepository.queryTelemetryHistory({
    vehicleIds,
    start,
    end,
    limit: Math.min(limit * 4, 2000)
  });

  const items = result.events
    .slice()
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .slice(0, limit)
    .map(event => ({
      vehicleId: event.vehicleId,
      recordedAt: event.recordedAt,
      latitude: event.latitude,
      longitude: event.longitude,
      speedKmh: event.speedKmh,
      fuelLevel: event.fuelLevel,
      engineStatus: event.engineStatus,
      distanceKm: event.distanceKm
    }));

  return sendJson(res, {
    range: { start, end },
    vehicleIds,
    limit,
    sampleCount: items.length,
    nextPageToken: result.nextPageToken,
    events: items
  });
}

function clampPositiveInt(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

function parseVehicleIds(params) {
  if (!params) {
    return [];
  }
  const list = [];
  for (const entry of params.getAll('vehicleId')) {
    for (const part of entry.split(',')) {
      const trimmed = part.trim();
      if (trimmed) {
        list.push(trimmed);
      }
    }
  }
  return list;
}

function summariseBuckets(buckets) {
  let sumSpeed = 0;
  let sampleCount = 0;
  let maxSpeed = Number.NEGATIVE_INFINITY;
  let minFuel = Number.POSITIVE_INFINITY;
  let totalDistance = 0;

  for (const bucket of buckets) {
    const metrics = bucket.metrics || {};
    const bucketSamples = Number(bucket.sampleCount) || 0;
    if (bucketSamples > 0 && Number.isFinite(metrics.AVG_SPEED_KMH)) {
      sumSpeed += metrics.AVG_SPEED_KMH * bucketSamples;
      sampleCount += bucketSamples;
    }
    if (Number.isFinite(metrics.MAX_SPEED_KMH)) {
      maxSpeed = Math.max(maxSpeed, metrics.MAX_SPEED_KMH);
    }
    if (Number.isFinite(metrics.MIN_FUEL_LEVEL)) {
      minFuel = Math.min(minFuel, metrics.MIN_FUEL_LEVEL);
    }
    if (Number.isFinite(metrics.TOTAL_DISTANCE_KM)) {
      totalDistance += metrics.TOTAL_DISTANCE_KM;
    }
  }

  const avgSpeed = sampleCount > 0 ? sumSpeed / sampleCount : null;
  return {
    avgSpeedKmh: avgSpeed !== null ? Number(avgSpeed.toFixed(2)) : null,
    maxSpeedKmh: Number.isFinite(maxSpeed) ? Number(maxSpeed.toFixed(2)) : null,
    minFuelLevel: Number.isFinite(minFuel) ? Number(minFuel.toFixed(1)) : null,
    totalDistanceKm: Number(totalDistance.toFixed(3)),
    sampleCount
  };
}

module.exports = { createApiServer };
