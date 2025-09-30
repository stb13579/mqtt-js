const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const { createDatabase } = require('../backend/db');
const { createTelemetryRepository } = require('../backend/services/telemetry-repository');
const { VehicleStore } = require('../backend/services/vehicle-store');
const { createGrpcService } = require('../backend/services/grpc-service');
const { haversine } = require('../backend/utils/geo');

const PROTO_PATH = path.join(__dirname, '..', 'protos', 'telemetry.proto');
const PACKAGE_DEFINITION = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const telemetryPackage = grpc.loadPackageDefinition(PACKAGE_DEFINITION).telemetry;
const TelemetryServiceClient = telemetryPackage.v1.TelemetryService;

function createLoggerStub() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

test('gRPC TelemetryService integration', async t => {
  await t.test('GetFleetSnapshot returns live fleet data and metrics', async t => {
    const ctx = await createIntegrationContext();
    t.after(() => ctx.close());

    const now = Date.now();
    ctx.state.totalMessages = 5;
    ctx.state.invalidMessages = 1;
    ctx.state.messageTimestamps.push(now - 200, now - 100, now);
    ctx.setClientCount(2);

    const vehicle = {
      vehicleId: 'veh-live-1',
      lat: 40.7128,
      lng: -74.006,
      ts: '2024-01-01T12:00:00.000Z',
      lastSeen: '2024-01-01T12:00:05.000Z',
      speed: 63.5,
      fuelLevel: 48.2,
      engineStatus: 'running'
    };
    ctx.vehicleStore.set(vehicle.vehicleId, vehicle);

    const getFleetSnapshot = promisify(ctx.client.getFleetSnapshot.bind(ctx.client));
    const response = await getFleetSnapshot({ vehicleIds: [vehicle.vehicleId], includeMetrics: true });

    assert.equal(response.snapshots.length, 1);
    const snapshot = response.snapshots[0];
    assert.equal(snapshot.vehicleId, vehicle.vehicleId);
    assert.equal(snapshot.telemetry.vehicleId, vehicle.vehicleId);
    assert.equal(snapshot.telemetry.latitude, vehicle.lat);
    assert.equal(snapshot.telemetry.longitude, vehicle.lng);
    assert.equal(snapshot.telemetry.speedKmh, vehicle.speed);
    assert.equal(snapshot.telemetry.engineStatus, vehicle.engineStatus);
    assert.ok(response.metrics);
    assert.equal(response.metrics.totalMessages, 5);
    assert.equal(response.metrics.invalidMessages, 1);
    assert.equal(response.metrics.connectedClients, 2);
    assert.equal(response.metrics.windowSeconds, 1);
  });

  await t.test('StreamVehicleSnapshots pushes updates as vehicles change', async t => {
    const ctx = await createIntegrationContext({ streamIntervalMs: 25 });
    t.after(() => ctx.close());

    const vehicleId = 'veh-stream-1';
    ctx.vehicleStore.set(vehicleId, {
      vehicleId,
      lat: 34.0522,
      lng: -118.2437,
      ts: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-01T00:00:00.000Z',
      speed: 0,
      fuelLevel: 70,
      engineStatus: 'idle'
    });

    const stream = ctx.client.streamVehicleSnapshots({ vehicleIds: [vehicleId] });
    const metadataPromise = once(stream, 'metadata');
    stream.on('error', () => {});

    const [initial] = await once(stream, 'data');
    assert.equal(initial.vehicleId, vehicleId);
    assert.equal(initial.telemetry.speedKmh, 0);
    const [metadata] = await metadataPromise;
    assert.equal(metadata.get('active-stream-count')[0], '1');
    assert.equal(ctx.state.grpcStreams, 1);
    assert.equal(ctx.grpcService.activeStreamCount(), 1);

    ctx.vehicleStore.set(vehicleId, {
      vehicleId,
      lat: 34.0622,
      lng: -118.2437,
      ts: '2024-01-01T00:05:00.000Z',
      lastSeen: '2024-01-01T00:05:00.000Z',
      speed: 54.3,
      fuelLevel: 68,
      engineStatus: 'running'
    });

    const [update] = await once(stream, 'data');
    assert.equal(update.telemetry.speedKmh, 54.3);
    assert.equal(update.telemetry.engineStatus, 'running');
    assert.notEqual(update.lastSeen.seconds, initial.lastSeen.seconds);

    stream.cancel();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ctx.state.grpcStreams, 0);
    assert.equal(ctx.grpcService.activeStreamCount(), 0);
  });

  await t.test('QueryTelemetryHistory streams persisted telemetry with pagination metadata', async t => {
    const ctx = await createIntegrationContext();
    t.after(() => ctx.close());

    const vehicleId = 'veh-hist-1';
    const messages = [
      buildTelemetry(vehicleId, '2024-01-01T00:00:00.000Z', 52.52, 13.405, 82, 'running'),
      buildTelemetry(vehicleId, '2024-01-01T00:05:00.000Z', 52.53, 13.415, 79, 'running'),
      buildTelemetry(vehicleId, '2024-01-01T00:10:00.000Z', 52.54, 13.425, 76, 'idle')
    ];
    for (const message of messages) {
      await ingestTelemetry(ctx, message);
    }

    const call = ctx.client.queryTelemetryHistory({ vehicleIds: [vehicleId], limit: 2 });
    const metadataPromise = once(call, 'metadata');
    const received = [];
    call.on('data', data => received.push(data));
    await new Promise((resolve, reject) => {
      call.on('end', resolve);
      call.on('error', reject);
    });
    const [metadata] = await metadataPromise;

    assert.equal(received.length, 2);
    assert.equal(received[0].vehicleId, vehicleId);
    assert.equal(received[0].engineStatus, 'running');
    assert.equal(received[1].engineStatus, 'running');
    assert.ok(metadata.get('next-page-token')[0]);
  });

  await t.test('GetHistoricalAggregates returns aggregated metrics from rollups', async t => {
    const ctx = await createIntegrationContext();
    t.after(() => ctx.close());

    const vehicleId = 'veh-agg-1';
    const messages = [
      buildTelemetryWithSpeed(vehicleId, '2024-01-01T00:00:00.000Z', 40.7128, -74.006, 90, 'running', 50),
      buildTelemetryWithSpeed(vehicleId, '2024-01-01T00:05:00.000Z', 40.7228, -74.001, 87, 'running', 60),
      buildTelemetryWithSpeed(vehicleId, '2024-01-01T00:10:00.000Z', 40.7328, -73.996, 84, 'idle', 30)
    ];
    let previous;
    for (const message of messages) {
      previous = await ingestTelemetry(ctx, message, previous);
    }

    await ctx.telemetryRepository.computePendingRollups(Date.parse('2024-01-01T00:20:00.000Z'), {
      force: true,
      windows: [60, 300]
    });
    


    const getHistoricalAggregates = promisify(ctx.client.getHistoricalAggregates.bind(ctx.client));
    const response = await getHistoricalAggregates({
      vehicleIds: [vehicleId],
      range: {
        start: toTimestamp('2024-01-01T00:00:00.000Z'),
        end: toTimestamp('2024-01-01T00:30:00.000Z')
      },
      window: { seconds: 300 },
      aggregates: [1, 2, 3, 4]
    });

    assert.ok(response.buckets.length >= 1);
    const bucket = response.buckets[0];
    assert.ok(bucket.metrics.AVG_SPEED_KMH >= 0);
    assert.ok(bucket.metrics.TOTAL_DISTANCE_KM >= 0);
    assert.ok(bucket.metrics.MIN_FUEL_LEVEL <= 90);
  });
});

async function createIntegrationContext({ streamIntervalMs } = {}) {
  const logger = createLoggerStub();
  const config = {
    cacheLimit: 200,
    vehicleTtlMs: 0,
    messageWindowMs: 1000,
    grpc: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      streamIntervalMs: streamIntervalMs ?? 50,
      streamHeartbeatMs: 0
    },
    telemetryDb: {
      path: ':memory:',
      rollupWindowSeconds: 60,
      rollupWindows: [60, 300],
      rollupIntervalMs: 0,
      rollupCatchUpWindows: 1
    }
  };

  const { db, close: closeDatabase } = createDatabase({ config, logger });
  const telemetryRepository = createTelemetryRepository({ db, logger, config });
  const vehicleStore = new VehicleStore({ limit: config.cacheLimit, ttlMs: config.vehicleTtlMs, logger });
  const state = { totalMessages: 0, invalidMessages: 0, messageTimestamps: [], grpcStreams: 0 };
  let clientCount = 0;

  const grpcService = createGrpcService({
    config,
    logger,
    vehicleStore,
    telemetryRepository,
    state,
    getClientCount: () => clientCount
  });

  await grpcService.waitForReady();
  const port = grpcService.port();
  const client = new TelemetryServiceClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

  return {
    client,
    grpcService,
    vehicleStore,
    telemetryRepository,
    state,
    config,
    setClientCount: value => {
      clientCount = value;
    },
    close: async () => {
      client.close();
      await new Promise(resolve => grpcService.close(resolve));
      telemetryRepository.stopRollupScheduler();
      vehicleStore.stop();
      closeDatabase();
    }
  };
}

async function ingestTelemetry(ctx, message, previous) {
  const prior = previous || ctx.vehicleStore.get(message.vehicleId) || null;
  const speed = message.speed !== undefined ? message.speed : (prior ? computeSpeed(prior, message) : 0);
  const enriched = {
    vehicleId: message.vehicleId,
    lat: message.lat,
    lng: message.lng,
    ts: message.ts,
    speed,
    fuelLevel: message.fuelLevel,
    engineStatus: message.engineStatus,
    lastSeen: message.ts
  };

  ctx.vehicleStore.set(message.vehicleId, enriched);
  ctx.state.totalMessages += 1;
  ctx.state.messageTimestamps.push(Date.now());
  ctx.telemetryRepository.recordTelemetry({ message, previous: prior, enriched });

  return enriched;
}

function buildTelemetry(vehicleId, ts, lat, lng, fuelLevel, engineStatus) {
  return {
    vehicleId,
    ts,
    lat,
    lng,
    fuelLevel,
    engineStatus
  };
}

function buildTelemetryWithSpeed(vehicleId, ts, lat, lng, fuelLevel, engineStatus, speed) {
  return {
    vehicleId,
    ts,
    lat,
    lng,
    fuelLevel,
    engineStatus,
    speed
  };
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
  return deltaHours > 0 ? distanceKm / deltaHours : 0;
}

function toTimestamp(iso) {
  const date = new Date(iso);
  const millis = date.getTime();
  return {
    seconds: Math.floor(millis / 1000),
    nanos: (millis % 1000) * 1_000_000
  };
}
