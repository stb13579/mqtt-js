const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const grpc = require('@grpc/grpc-js');

function createLoggerStub() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

class FakeServer {
  constructor() {
    this.handlers = null;
    this.address = null;
    this.tryShutdownCalled = false;
    this.forceShutdownCalled = false;
    FakeServer.instances.push(this);
  }

  addService(_definition, impl) {
    this.handlers = impl;
  }

  bindAsync(address, _credentials, callback) {
    this.address = address;
    if (FakeServer.bindError) {
      process.nextTick(() => callback(FakeServer.bindError));
      return;
    }
    const port = FakeServer.nextPort();
    this.port = port;
    process.nextTick(() => callback(null, port));
  }

  tryShutdown(callback) {
    this.tryShutdownCalled = true;
    const err = FakeServer.shutdownError || null;
    process.nextTick(() => callback(err));
  }

  forceShutdown() {
    this.forceShutdownCalled = true;
  }

  static reset() {
    FakeServer.instances.length = 0;
    FakeServer.portCounter = 61_000;
    FakeServer.bindError = null;
    FakeServer.shutdownError = null;
  }

  static latest() {
    return FakeServer.instances[FakeServer.instances.length - 1] || null;
  }

  static nextPort() {
    FakeServer.portCounter += 1;
    return FakeServer.portCounter;
  }
}

FakeServer.instances = [];
FakeServer.portCounter = 61_000;
FakeServer.bindError = null;
FakeServer.shutdownError = null;

const { createGrpcService } = require('../backend/services/grpc-service');

test('gRPC TelemetryService handlers (unit)', async t => {
  t.after(() => {
    FakeServer.reset();
  });

  await t.test('GetFleetSnapshot returns filtered snapshots and metrics', async t => {
    const now = Date.now();
    const vehicles = new Map([
      [
        'veh-1',
        {
          vehicleId: 'veh-1',
          ts: '2024-01-01T00:00:00.000Z',
          lastSeen: '2024-01-01T00:00:10.000Z',
          lat: 37.7749,
          lng: -122.4194,
          speed: 42.5,
          fuelLevel: 76.3,
          engineStatus: 'idle'
        }
      ],
      [
        'veh-2',
        {
          vehicleId: 'veh-2',
          ts: '2024-01-01T00:05:00.000Z',
          lastSeen: '2024-01-01T00:05:05.000Z',
          lat: 48.8566,
          lng: 2.3522,
          speed: 58.1,
          fuelLevel: 54.2,
          engineStatus: 'running'
        }
      ]
    ]);

    const vehicleStore = {
      entries: () => vehicles.entries()
    };

    const state = {
      totalMessages: 12,
      invalidMessages: 1,
      messageTimestamps: [now - 200, now - 100, now]
    };

    const config = {
      messageWindowMs: 1000,
      grpc: { enabled: true, host: '127.0.0.1', port: 0, streamIntervalMs: 25 }
    };

    const ctx = createServiceContext({ vehicleStore, state, config, getClientCount: () => 3 });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const response = await new Promise((resolve, reject) => {
      ctx.server.handlers.GetFleetSnapshot(
        { request: { vehicleIds: ['veh-2'], includeMetrics: true } },
        (err, payload) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(payload);
        }
      );
    });

    assert.equal(response.snapshots.length, 1);
    const snapshot = response.snapshots[0];
    assert.equal(snapshot.vehicleId, 'veh-2');
    assert.equal(snapshot.telemetry.vehicleId, 'veh-2');
    assert.equal(snapshot.telemetry.engineStatus, 'running');
    assert.equal(snapshot.telemetry.speedKmh, 58.1);
    assert.equal(snapshot.telemetry.latitude, 48.8566);
    assert.equal(snapshot.telemetry.longitude, 2.3522);
    assert.equal(snapshot.telemetry.recordedAt.seconds > 0, true);
    assert.ok(response.metrics);
    assert.equal(response.metrics.totalMessages, 12);
    assert.equal(response.metrics.invalidMessages, 1);
    assert.equal(response.metrics.connectedClients, 3);
    assert.equal(response.metrics.messageRatePerSecond, 3);
    assert.equal(response.metrics.windowSeconds, 1);

  });

  await t.test('GetFleetSnapshot maps thrown errors to INTERNAL status', async t => {
    const fault = new Error('vehicle lookup failed');
    const ctx = createServiceContext({
      vehicleStore: {
        entries: () => {
          throw fault;
        }
      }
    });

    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const err = await new Promise(resolve => {
      ctx.server.handlers.GetFleetSnapshot({ request: {} }, error => resolve(error));
    });

    assert.equal(err.code, grpc.status.INTERNAL);
    assert.equal(err.details, fault.message);
  });

  await t.test('StreamVehicleSnapshots streams updates and cleans up intervals', async t => {
    const timers = [];
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    global.setInterval = (fn, ms) => {
      const timer = { fn, ms, cleared: false, unrefCalled: false };
      timer.unref = () => {
        timer.unrefCalled = true;
      };
      timers.push(timer);
      return timer;
    };
    global.clearInterval = timer => {
      timer.cleared = true;
    };

    t.after(() => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    });

    const vehicles = new Map([
      [
        'veh-9',
        {
          vehicleId: 'veh-9',
          ts: '2024-01-01T00:00:00.000Z',
          lastSeen: '2024-01-01T00:00:00.000Z',
          lat: 52.52,
          lng: 13.405,
          speed: 0,
          fuelLevel: 88,
          engineStatus: 'idle'
        }
      ]
    ]);

    const vehicleStore = {
      entries: () => vehicles.entries()
    };

    const ctx = createServiceContext({ vehicleStore, config: { messageWindowMs: 1000, grpc: { enabled: true, host: '127.0.0.1', port: 0, streamIntervalMs: 10 } } });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createStreamingCall({ vehicleIds: [] });
    ctx.server.handlers.StreamVehicleSnapshots(call);
    await flushAsync();

    assert.equal(call.writes.length, 1);
    const timer = timers[0];
    assert.ok(timer);
    assert.equal(timer.unrefCalled, true);
    assert.ok(call.sentMetadata);
    assert.equal(call.sentMetadata.get('active-stream-count')[0], '1');
    assert.equal(ctx.state.grpcStreams, 1);
    assert.equal(ctx.service.activeStreamCount(), 1);

    vehicles.set('veh-9', {
      vehicleId: 'veh-9',
      ts: '2024-01-01T00:00:05.000Z',
      lastSeen: '2024-01-01T00:00:05.000Z',
      lat: 52.53,
      lng: 13.415,
      speed: 12,
      fuelLevel: 87,
      engineStatus: 'running'
    });

    timer.fn();
    await flushAsync();
    assert.equal(call.writes.length, 2);
    assert.equal(call.writes[1].telemetry.speedKmh, 12);
    assert.equal(call.writes[1].telemetry.engineStatus, 'running');

    call.emit('cancelled');
    await flushAsync();
    assert.equal(timer.cleared, true);
    assert.equal(ctx.state.grpcStreams, 0);
    assert.equal(ctx.service.activeStreamCount(), 0);
  });

  await t.test('StreamVehicleSnapshots propagates errors from vehicle iteration', async t => {
    const fault = new Error('iteration failed');
    const ctx = createServiceContext({
      vehicleStore: {
        entries: () => {
          throw fault;
        }
      },
      config: { messageWindowMs: 1000, grpc: { enabled: true, host: '127.0.0.1', port: 0, streamIntervalMs: 10 } }
    });

    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createStreamingCall({});
    ctx.server.handlers.StreamVehicleSnapshots(call);
    await flushAsync();

    assert.equal(call.errors.length, 1);
    assert.equal(call.errors[0].code, grpc.status.INTERNAL);
    assert.equal(call.errors[0].details, fault.message);
  });

  await t.test('StreamVehicleSnapshots waits for backpressure drain events', async t => {
    const timers = [];
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    global.setInterval = (fn, ms) => {
      const timer = { fn, ms, cleared: false, unrefCalled: false };
      timer.unref = () => {
        timer.unrefCalled = true;
      };
      timers.push(timer);
      return timer;
    };
    global.clearInterval = timer => {
      timer.cleared = true;
    };

    t.after(() => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    });

    const vehicles = new Map([
      [
        'veh-back',
        {
          vehicleId: 'veh-back',
          ts: '2024-01-01T00:00:00.000Z',
          lastSeen: '2024-01-01T00:00:00.000Z',
          lat: 10,
          lng: 10,
          speed: 0,
          fuelLevel: 50,
          engineStatus: 'idle'
        }
      ]
    ]);

    const vehicleStore = {
      entries: () => vehicles.entries()
    };

    const ctx = createServiceContext({ vehicleStore, config: { messageWindowMs: 1000, grpc: { enabled: true, host: '127.0.0.1', port: 0, streamIntervalMs: 5, streamHeartbeatMs: 0 } } });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createStreamingCall({ vehicleIds: [] }, { backpressureOnce: true });
    ctx.server.handlers.StreamVehicleSnapshots(call);
    await flushAsync();

    assert.equal(call.writes.length, 1);
    assert.equal(ctx.state.grpcStreams, 1);
    assert.equal(ctx.service.activeStreamCount(), 1);

    // Flush is waiting for the client to drain.
    const timer = timers[0];
    assert.ok(timer);

    vehicles.set('veh-back', {
      vehicleId: 'veh-back',
      ts: '2024-01-01T00:00:05.000Z',
      lastSeen: '2024-01-01T00:00:05.000Z',
      lat: 11,
      lng: 11,
      speed: 42,
      fuelLevel: 49,
      engineStatus: 'running'
    });

    timer.fn();
    await flushAsync();
    assert.equal(call.writes.length, 1, 'no new data until drain');

    call.emit('drain');
    await flushAsync();

    timer.fn();
    await flushAsync();
    assert.equal(call.writes.length, 2, 'update delivered after drain');

    call.emit('cancelled');
    await flushAsync();
    assert.equal(timer.cleared, true);
    assert.equal(ctx.state.grpcStreams, 0);
    assert.equal(ctx.service.activeStreamCount(), 0);
  });

  await t.test('QueryTelemetryHistory streams results and pagination metadata', async t => {
    let capturedArgs;
    const telemetryRepository = {
      queryTelemetryHistory: args => {
        capturedArgs = args;
        return {
          nextPageToken: '42',
          events: [
            {
              vehicleId: 'veh-1',
              latitude: 51.5,
              longitude: -0.12,
              speedKmh: 45.6,
              fuelLevel: 72.1,
              engineStatus: 'running',
              recordedAt: '2024-01-01T00:00:01.000Z'
            },
            {
              vehicleId: 'veh-1',
              latitude: 51.51,
              longitude: -0.11,
              speedKmh: 47.2,
              fuelLevel: 71.8,
              engineStatus: 'running',
              recordedAt: '2024-01-01T00:00:11.000Z'
            }
          ]
        };
      },
      queryHistoricalAggregates: () => []
    };

    const ctx = createServiceContext({ telemetryRepository });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createHistoryCall({
      vehicleIds: ['veh-1', '', 123, ' veh-1 '],
      range: {
        start: toTimestamp('2024-01-01T00:00:00.000Z'),
        end: toTimestamp('2024-01-01T00:01:00.000Z')
      },
      limit: 2,
      pageToken: '3'
    });

    ctx.server.handlers.QueryTelemetryHistory(call);

    assert.equal(capturedArgs.vehicleIds.length, 1);
    assert.equal(capturedArgs.vehicleIds[0], 'veh-1');
    assert.equal(capturedArgs.start, '2024-01-01T00:00:00.000Z');
    assert.equal(capturedArgs.end, '2024-01-01T00:01:00.000Z');
    assert.equal(capturedArgs.limit, 2);
    assert.equal(capturedArgs.pageToken, '3');

    assert.equal(call.metadata?.get('next-page-token')[0], '42');
    assert.equal(call.writes.length, 2);
    assert.equal(call.writes[0].vehicleId, 'veh-1');
    assert.equal(call.writes[0].telemetry, undefined);
    assert.equal(call.writes[0].speedKmh, 45.6);
    assert.equal(call.writes[0].engineStatus, 'running');
    assert.equal(call.ended, true);
    assert.equal(call.errors.length, 0);
  });

  await t.test('QueryTelemetryHistory maps repository failures to INTERNAL errors', async t => {
    const fault = new Error('db unavailable');
    const telemetryRepository = {
      queryTelemetryHistory: () => {
        throw fault;
      },
      queryHistoricalAggregates: () => []
    };

    const ctx = createServiceContext({ telemetryRepository });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createHistoryCall({});
    ctx.server.handlers.QueryTelemetryHistory(call);

    assert.equal(call.errors.length, 1);
    assert.equal(call.errors[0].code, grpc.status.INTERNAL);
    assert.equal(call.errors[0].details, fault.message);
  });

  await t.test('GetHistoricalAggregates translates repository payload', async t => {
    const telemetryRepository = {
      queryTelemetryHistory: () => ({ events: [], nextPageToken: null }),
      queryHistoricalAggregates: () => [
        {
          bucketStart: '2024-01-01T00:00:00.000Z',
          bucketEnd: '2024-01-01T00:05:00.000Z',
          metrics: {
            AVG_SPEED_KMH: 52.2,
            TOTAL_DISTANCE_KM: 4.5,
            MIN_FUEL_LEVEL: 68.4
          }
        }
      ]
    };

    const ctx = createServiceContext({ telemetryRepository });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const response = await new Promise((resolve, reject) => {
      ctx.server.handlers.GetHistoricalAggregates(
        { request: { vehicleIds: ['veh-1', null, ''], aggregates: [1, 3], window: { seconds: 300 } } },
        (err, payload) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(payload);
        }
      );
    });

    assert.equal(response.buckets.length, 1);
    const bucket = response.buckets[0];
    assert.equal(bucket.windowStart.seconds > 0, true);
    assert.equal(bucket.windowEnd.seconds > 0, true);
    assert.equal(bucket.metrics.AVG_SPEED_KMH, 52.2);
    assert.equal(bucket.metrics.TOTAL_DISTANCE_KM, 4.5);
    assert.equal(bucket.metrics.MIN_FUEL_LEVEL, 68.4);
  });

  await t.test('GetHistoricalAggregates maps repository errors to INTERNAL status', async t => {
    const fault = new Error('aggregation failed');
    const telemetryRepository = {
      queryTelemetryHistory: () => ({ events: [], nextPageToken: null }),
      queryHistoricalAggregates: () => {
        throw fault;
      }
    };

    const ctx = createServiceContext({ telemetryRepository });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const err = await new Promise(resolve => {
      ctx.server.handlers.GetHistoricalAggregates({ request: {} }, error => resolve(error));
    });

    assert.equal(err.code, grpc.status.INTERNAL);
    assert.equal(err.details, fault.message);
  });

  await t.test('QueryTelemetryHistory rejects invalid time range', async t => {
    const ctx = createServiceContext();
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const call = createHistoryCall({
      range: {
        start: toTimestamp('2024-01-01T00:10:00.000Z'),
        end: toTimestamp('2024-01-01T00:05:00.000Z')
      }
    });

    ctx.server.handlers.QueryTelemetryHistory(call);

    assert.equal(call.errors.length, 1);
    assert.equal(call.errors[0].code, grpc.status.INVALID_ARGUMENT);
    assert.equal(call.writes.length, 0);
  });

  await t.test('GetHistoricalAggregates rejects invalid time range', async t => {
    const telemetryRepository = {
      queryTelemetryHistory: () => ({ events: [], nextPageToken: null }),
      queryHistoricalAggregates: () => []
    };

    const ctx = createServiceContext({ telemetryRepository });
    t.after(() => new Promise(resolve => ctx.service.close(resolve)));
    await ctx.service.waitForReady();

    const err = await new Promise(resolve => {
      ctx.server.handlers.GetHistoricalAggregates(
        {
          request: {
            range: {
              start: toTimestamp('2024-01-01T01:00:00.000Z'),
              end: toTimestamp('2024-01-01T00:00:00.000Z')
            }
          }
        },
        error => resolve(error)
      );
    });

    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
  });
});

function createServiceContext({ vehicleStore, telemetryRepository, state, config, getClientCount } = {}) {
  FakeServer.reset();

  const resolvedState =
    state || { totalMessages: 0, invalidMessages: 0, messageTimestamps: [], grpcStreams: 0 };

  const service = createGrpcService({
    config:
      config ||
      {
        grpc: {
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          streamIntervalMs: 25,
          streamHeartbeatMs: 0
        },
        messageWindowMs: 1000
      },
    logger: createLoggerStub(),
    vehicleStore:
      vehicleStore || {
        entries: () => new Map().entries()
      },
    telemetryRepository:
      telemetryRepository || {
        queryTelemetryHistory: () => ({ events: [], nextPageToken: null }),
        queryHistoricalAggregates: () => []
      },
    state: resolvedState,
    getClientCount: getClientCount || (() => 0),
    serverFactory: options => new FakeServer(options)
  });

  const server = FakeServer.latest();
  assert.ok(server, 'server instance should be captured');

  return { service, server, state: resolvedState };
}

function createStreamingCall(request, options = {}) {
  const call = new EventEmitter();
  call.request = request;
  call.writes = [];
  call.errors = [];
  call.sentMetadata = null;
  call.ended = false;

  let backpressurePending = options.backpressureOnce === true;

  call.write = message => {
    call.writes.push(message);
    if (backpressurePending) {
      backpressurePending = false;
      return false;
    }
    return true;
  };
  call.sendMetadata = metadata => {
    call.sentMetadata = metadata;
  };
  call.end = () => {
    call.ended = true;
  };
  call.getPeer = () => options.peer || 'test://peer';
  call.on('error', err => {
    call.errors.push(err);
  });
  return call;
}

function createHistoryCall(request) {
  const call = new EventEmitter();
  call.request = request;
  call.writes = [];
  call.errors = [];
  call.metadata = null;
  call.ended = false;
  call.write = message => {
    call.writes.push(message);
  };
  call.sendMetadata = metadata => {
    call.metadata = metadata;
  };
  call.end = () => {
    call.ended = true;
  };
  call.on('error', err => {
    call.errors.push(err);
  });
  return call;
}

function toTimestamp(iso) {
  const date = new Date(iso);
  const millis = date.getTime();
  return {
    seconds: Math.floor(millis / 1000),
    nanos: (millis % 1000) * 1_000_000
  };
}

function flushAsync() {
  return new Promise(resolve => setImmediate(resolve));
}
