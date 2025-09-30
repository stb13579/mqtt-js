const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { calculateRate } = require('../utils/message-metrics');

const PROTO_PATH = path.join(__dirname, '..', '..', 'protos', 'telemetry.proto');
const PACKAGE_DEFINITION = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const telemetryPkg = grpc.loadPackageDefinition(PACKAGE_DEFINITION).telemetry;
const TelemetryServiceDefinition = telemetryPkg?.v1?.TelemetryService?.service;

const DEFAULT_KEEPALIVE_TIME_MS = 120_000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 20_000;

function createGrpcService({
  config,
  logger,
  vehicleStore,
  telemetryRepository,
  state,
  getClientCount,
  serverFactory
}) {
  const grpcConfig = validateGrpcConfig(config, logger);
  if (!TelemetryServiceDefinition) {
    logger?.warn('TelemetryService definition not found in proto package. gRPC server disabled.');
    return null;
  }

  if (!grpcConfig?.enabled) {
    logger?.info('gRPC service disabled via configuration');
    return null;
  }

  const host = grpcConfig.host || '0.0.0.0';
  const configuredPort = Number(grpcConfig.port);
  const address = `${host}:${Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 0}`;
  const pollIntervalMs = Number(grpcConfig.streamIntervalMs) > 0 ? Number(grpcConfig.streamIntervalMs) : 1_000;
  const heartbeatMs = Number(grpcConfig.streamHeartbeatMs);
  const keepaliveTimeMs = Number.isFinite(grpcConfig.keepaliveTimeMs) && grpcConfig.keepaliveTimeMs > 0
    ? grpcConfig.keepaliveTimeMs
    : DEFAULT_KEEPALIVE_TIME_MS;
  const keepaliveTimeoutMs = Number.isFinite(grpcConfig.keepaliveTimeoutMs) && grpcConfig.keepaliveTimeoutMs > 0
    ? grpcConfig.keepaliveTimeoutMs
    : DEFAULT_KEEPALIVE_TIMEOUT_MS;

  const serverOptions = {
    'grpc.keepalive_time_ms': keepaliveTimeMs,
    'grpc.keepalive_timeout_ms': keepaliveTimeoutMs
  };

  const makeServer =
    typeof serverFactory === 'function' ? serverFactory : options => new grpc.Server(options);
  const server = makeServer(serverOptions);
  if (!server) {
    throw new Error('gRPC server factory returned invalid instance');
  }
  const activeStreams = new Set();

  server.addService(TelemetryServiceDefinition, {
    GetFleetSnapshot: (call, callback) => {
      try {
        const request = call.request || {};
        const response = buildFleetSnapshot({
          request,
          vehicleStore,
          state,
          config,
          getClientCount
        });
        callback(null, response);
      } catch (err) {
        logger?.error({ err }, 'GetFleetSnapshot failed');
        callback(mapError(err));
      }
    },
    StreamVehicleSnapshots: call => {
      const vehicleIds = validateVehicleIds(call.request?.vehicleIds);
      const filterSet = buildFilterSet(vehicleIds);
      const tracker = new Map();
      const disconnect = registerStream(call, { activeStreams, state, logger });
      let closed = false;

      const metadata = new grpc.Metadata();
      metadata.set('stream-heartbeat-ms', String(Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 0));
      metadata.set('active-stream-count', String(activeStreams.size));
      call.sendMetadata(metadata);

      let flushChain = Promise.resolve();

      const runFlush = async ({ sendAll }) => {
        for (const vehicle of collectVehicles(vehicleStore, filterSet)) {
          if (closed) {
            return;
          }
          const payload = mapVehicleToSnapshot(vehicle);
          if (!payload) {
            continue;
          }
          const previousKey = tracker.get(payload.vehicleId);
          if (!sendAll && previousKey === payload.lastSeenKey) {
            continue;
          }
          tracker.set(payload.vehicleId, payload.lastSeenKey);
          await writeToStream(call, payload.message, () => closed);
        }
      };

      const enqueueFlush = sendAll => {
        flushChain = flushChain.then(() => runFlush({ sendAll })).catch(err => {
          reportStreamError(call, err, logger);
        });
        return flushChain;
      };

      enqueueFlush(true);

      const interval = setInterval(() => {
        enqueueFlush(false);
      }, pollIntervalMs);

      if (typeof interval.unref === 'function') {
        interval.unref();
      }

      const heartbeatTimer = Number.isFinite(heartbeatMs) && heartbeatMs > 0
        ? setInterval(() => {
            logger?.debug({ peer: call.getPeer?.(), activeStreams: activeStreams.size }, 'gRPC stream heartbeat');
          }, heartbeatMs)
        : null;

      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(interval);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        disconnect();
      };

      call.on('cancelled', cleanup);
      call.on('error', cleanup);
      call.on('close', cleanup);
      call.on('finish', cleanup);
    },
    QueryTelemetryHistory: call => {
      try {
        const vehicleIds = validateVehicleIds(call.request?.vehicleIds);
        const rangeInput = call.request?.range;
        let start = rangeInput?.start ? timestampToIso(rangeInput.start) : null;
        let end = rangeInput?.end ? timestampToIso(rangeInput.end) : null;

        if (rangeInput?.start && rangeInput?.end) {
          const validated = validateTimeRange(rangeInput);
          start = validated.start;
          end = validated.end;
        }

        const result = telemetryRepository.queryTelemetryHistory({
          vehicleIds,
          start,
          end,
          limit: call.request?.limit,
          pageToken: call.request?.pageToken
        });

        if (result.nextPageToken) {
          const metadata = new grpc.Metadata();
          metadata.set('next-page-token', result.nextPageToken);
          call.sendMetadata(metadata);
        }

        for (const event of result.events) {
          const point = mapTelemetryPoint(event);
          if (point.recordedAt) {
            call.write(point);
          }
        }

        call.end();
      } catch (err) {
        logger?.error({ err }, 'QueryTelemetryHistory failed');
        call.emit('error', mapError(err));
      }
    },
    GetHistoricalAggregates: (call, callback) => {
      try {
        const vehicleIds = validateVehicleIds(call.request?.vehicleIds);
        const rangeInput = call.request?.range;
        let start = rangeInput?.start ? timestampToIso(rangeInput.start) : null;
        let end = rangeInput?.end ? timestampToIso(rangeInput.end) : null;

        if (rangeInput?.start && rangeInput?.end) {
          const validated = validateTimeRange(rangeInput);
          start = validated.start;
          end = validated.end;
        }

        const response = telemetryRepository.queryHistoricalAggregates({
          vehicleIds,
          start,
          end,
          aggregates: call.request?.aggregates || [],
          windowSeconds: call.request?.window?.seconds
        });

        const payload = {
          buckets: response.map(bucket => ({
            windowStart: toTimestamp(bucket.bucketStart),
            windowEnd: toTimestamp(bucket.bucketEnd),
            metrics: filterMetricMap(bucket.metrics)
          }))
        };

        callback(null, payload);
      } catch (err) {
        logger?.error({ err }, 'GetHistoricalAggregates failed');
        callback(mapError(err));
      }
    }
  });

  let boundPort = null;
  const startPromise = new Promise((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        logger?.error({ err, address }, 'Failed to bind gRPC server');
        reject(err);
        return;
      }

      boundPort = port;
      logger?.info({ address: `${host}:${port}` }, 'gRPC server listening');
      resolve();
    });
  });

  startPromise.catch(err => {
    logger?.error({ err }, 'gRPC server encountered startup error');
    process.nextTick(() => process.exit(1));
  });

  return {
    close: callback => {
      server.tryShutdown(err => {
        if (err) {
          logger?.warn({ err }, 'Force closing gRPC server after shutdown error');
          server.forceShutdown();
        }
        callback?.(err);
      });
    },
    port: () => boundPort,
    waitForReady: () => startPromise,
    activeStreamCount: () => activeStreams.size
  };
}

function buildFleetSnapshot({ request, vehicleStore, state, config, getClientCount }) {
  const filterSet = buildFilterSet(request?.vehicleIds);
  const snapshots = [];

  for (const vehicle of collectVehicles(vehicleStore, filterSet)) {
    const payload = mapVehicleToSnapshot(vehicle);
    if (payload) {
      snapshots.push(payload.message);
    }
  }

  const response = { snapshots };
  if (request?.includeMetrics) {
    const rate = calculateRate(state, config.messageWindowMs, Date.now());
    response.metrics = {
      totalMessages: state.totalMessages,
      invalidMessages: state.invalidMessages,
      connectedClients: typeof getClientCount === 'function' ? getClientCount() : 0,
      messageRatePerSecond: Number(rate.toFixed(3)),
      windowSeconds: Math.floor(config.messageWindowMs / 1000)
    };
  }

  return response;
}

function collectVehicles(vehicleStore, filterSet) {
  const vehicles = [];
  const hasFilter = filterSet && filterSet.size > 0;

  for (const [vehicleId, vehicle] of vehicleStore.entries()) {
    if (hasFilter && !filterSet.has(vehicleId)) {
      continue;
    }
    vehicles.push(vehicle);
  }

  return vehicles;
}

function buildFilterSet(vehicleIds) {
  const validIds = validateVehicleIds(vehicleIds);
  if (validIds.length === 0) {
    return null;
  }
  return new Set(validIds.map(id => String(id)));
}

function mapVehicleToSnapshot(vehicle) {
  if (!vehicle || !vehicle.vehicleId) {
    return null;
  }

  const recordedIso = toIsoSafely(vehicle.ts);
  const lastSeenIso = toIsoSafely(vehicle.lastSeen) || recordedIso;

  return {
    vehicleId: vehicle.vehicleId,
    lastSeenKey: lastSeenIso || recordedIso || vehicle.vehicleId,
    message: {
      vehicleId: vehicle.vehicleId,
      lastSeen: toTimestamp(lastSeenIso),
      telemetry: {
        vehicleId: vehicle.vehicleId,
        latitude: Number(vehicle.lat) || 0,
        longitude: Number(vehicle.lng) || 0,
        speedKmh: Number.isFinite(vehicle.speed) ? vehicle.speed : 0,
        fuelLevel: Number.isFinite(vehicle.fuelLevel) ? vehicle.fuelLevel : 0,
        engineStatus: vehicle.engineStatus || '',
        recordedAt: toTimestamp(recordedIso)
      }
    }
  };
}

function mapTelemetryPoint(event) {
  return {
    vehicleId: event.vehicleId,
    latitude: Number(event.latitude) || 0,
    longitude: Number(event.longitude) || 0,
    speedKmh: Number.isFinite(event.speedKmh) ? event.speedKmh : 0,
    fuelLevel: Number.isFinite(event.fuelLevel) ? event.fuelLevel : 0,
    engineStatus: event.engineStatus || '',
    recordedAt: toTimestamp(event.recordedAt)
  };
}

function timestampToIso(timestamp) {
  if (!timestamp) {
    return null;
  }
  const seconds = Number(timestamp.seconds || 0);
  const nanos = Number(timestamp.nanos || 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const millis = seconds * 1000 + Math.floor(nanos / 1_000_000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = typeof value === 'string' ? new Date(value) : new Date(value);
  const millis = date.getTime();
  if (!Number.isFinite(millis)) {
    return null;
  }
  return {
    seconds: Math.floor(millis / 1000),
    nanos: (millis % 1000) * 1_000_000
  };
}

function toIsoSafely(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function filterMetricMap(metrics) {
  const result = {};
  if (!metrics) {
    return result;
  }
  for (const [key, value] of Object.entries(metrics)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      result[key] = numeric;
    }
  }
  return result;
}

function mapError(err) {
  if (err && err.code && Number.isInteger(err.code)) {
    return err;
  }
  return {
    code: grpc.status.INTERNAL,
    details: err?.message || 'Internal server error'
  };
}

function writeToStream(call, message, isClosed) {
  if (isClosed()) {
    return Promise.resolve();
  }

  let drained = true;
  try {
    drained = call.write(message);
  } catch (err) {
    return Promise.reject(err);
  }

  if (drained || isClosed()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      call.off('drain', onDrain);
      call.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = err => {
      cleanup();
      reject(err);
    };

    call.once('drain', onDrain);
    call.once('error', onError);
  });
}

function reportStreamError(call, err, logger) {
  if (!err) {
    return;
  }
  logger?.error({ err }, 'StreamVehicleSnapshots encountered error');
  call.emit('error', mapError(err));
}

function registerStream(call, { activeStreams, state, logger }) {
  activeStreams.add(call);
  updateGrpcStreamCount(state, 1);
  logger?.debug({ activeStreams: activeStreams.size }, 'gRPC stream connected');

  let disconnected = false;
  return () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    if (activeStreams.delete(call)) {
      updateGrpcStreamCount(state, -1);
    }
    logger?.debug({ activeStreams: activeStreams.size }, 'gRPC stream disconnected');
  };
}

function updateGrpcStreamCount(state, delta) {
  if (!state) {
    return;
  }
  const current = Number.isFinite(state.grpcStreams) ? state.grpcStreams : 0;
  state.grpcStreams = Math.max(0, current + delta);
}

function validateVehicleIds(vehicleIds) {
  if (!Array.isArray(vehicleIds)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const raw of vehicleIds) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function validateTimeRange(range) {
  if (!range?.start || !range?.end) {
    return null;
  }

  const startIso = timestampToIso(range.start);
  const endIso = timestampToIso(range.end);

  if (!startIso || !endIso) {
    const error = new Error('Invalid time range');
    error.code = grpc.status.INVALID_ARGUMENT;
    throw error;
  }

  const start = new Date(startIso);
  const end = new Date(endIso);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    const error = new Error('Invalid time range');
    error.code = grpc.status.INVALID_ARGUMENT;
    throw error;
  }

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function validateGrpcConfig(config, logger) {
  if (!config?.grpc) {
    throw new Error('gRPC configuration missing');
  }

  if (config.grpc.enabled && (!config.grpc.port || Number(config.grpc.port) === 0)) {
    logger?.warn('gRPC enabled but no port specified, using dynamic port');
  }

  return config.grpc;
}

module.exports = {
  createGrpcService
};
