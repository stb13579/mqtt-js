const { haversine } = require('../utils/geo');

function createTelemetryRepository({ db, logger, config }) {
  const telemetryConfig = config?.telemetryDb || {};
  const rollupWindows = sanitizeRollupWindows(telemetryConfig);
  const baseRollupWindow = rollupWindows[0];
  const rollupIntervalMs = normalizeInterval(telemetryConfig.rollupIntervalMs, 60_000);
  const rollupCatchUpWindows = Math.max(0, Math.trunc(telemetryConfig.rollupCatchUpWindows ?? 1));

  const upsertVehicle = db.prepare(`
    INSERT INTO vehicles (
      vehicle_id,
      first_seen_at,
      last_seen_at,
      last_latitude,
      last_longitude,
      last_engine_status,
      last_fuel_level,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(vehicle_id) DO UPDATE SET
      first_seen_at = CASE
        WHEN vehicles.first_seen_at <= excluded.first_seen_at THEN vehicles.first_seen_at
        ELSE excluded.first_seen_at
      END,
      last_seen_at = excluded.last_seen_at,
      last_latitude = excluded.last_latitude,
      last_longitude = excluded.last_longitude,
      last_engine_status = excluded.last_engine_status,
      last_fuel_level = excluded.last_fuel_level
  `);

  const insertEvent = db.prepare(`
    INSERT INTO telemetry_events (
      vehicle_id,
      recorded_at,
      latitude,
      longitude,
      speed_kmh,
      fuel_level,
      engine_status,
      distance_km
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getDistanceCache = db.prepare(
    'SELECT cumulative_km FROM telemetry_distance_cache WHERE vehicle_id = ?'
  );
  const insertDistanceCache = db.prepare(
    'INSERT INTO telemetry_distance_cache(vehicle_id, last_event_id, cumulative_km) VALUES (?, ?, ?)'
  );
  const updateDistanceCache = db.prepare(
    'UPDATE telemetry_distance_cache SET last_event_id = ?, cumulative_km = ? WHERE vehicle_id = ?'
  );

  const selectOldestEvent = db.prepare('SELECT MIN(recorded_at) AS min_recorded FROM telemetry_events');
  const getLastRollupEndStmt = db.prepare(
    `SELECT MAX(bucket_end) AS max_end
       FROM telemetry_rollups
      WHERE (strftime('%s', bucket_end) - strftime('%s', bucket_start)) = ?`
  );

  const rollupStatementCache = new Map();

  const applyRollups = db.transaction(rows => {
    const upsertRollup = db.prepare(`
      INSERT INTO telemetry_rollups (
        bucket_start,
        bucket_end,
        vehicle_id,
        avg_speed_kmh,
        max_speed_kmh,
        min_fuel_level,
        total_distance_km,
        sample_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start, bucket_end, vehicle_id) DO UPDATE SET
        avg_speed_kmh = excluded.avg_speed_kmh,
        max_speed_kmh = excluded.max_speed_kmh,
        min_fuel_level = excluded.min_fuel_level,
        total_distance_km = excluded.total_distance_km,
        sample_count = excluded.sample_count
    `);

    for (const row of rows) {
      upsertRollup.run(
        row.bucket_start,
        row.bucket_end,
        row.vehicle_id,
        row.avg_speed_kmh,
        row.max_speed_kmh,
        row.min_fuel_level,
        row.total_distance_km,
        row.sample_count
      );
    }
  });

  const recordTelemetryTx = db.transaction(({ message, previous, enriched }) => {
    const recordedAt = normalizeIso(message.ts);
    const lastSeen = normalizeIso(enriched.lastSeen);
    const deltaKm = computeDeltaKm(previous, message);

    upsertVehicle.run(
      message.vehicleId,
      recordedAt,
      lastSeen,
      message.lat,
      message.lng,
      message.engineStatus,
      message.fuelLevel
    );

    const eventInfo = insertEvent.run(
      message.vehicleId,
      recordedAt,
      message.lat,
      message.lng,
      enriched.speed,
      message.fuelLevel,
      message.engineStatus,
      deltaKm
    );

    const eventId = Number(eventInfo.lastInsertRowid);
    const totalKm = updateDistance(message.vehicleId, eventId, deltaKm);

    return {
      eventId,
      deltaKm,
      totalKm
    };
  });

  let rollupTimer = null;
  let initialRunTimer = null;

  function recordTelemetry(payload) {
    return recordTelemetryTx(payload);
  }

  function updateDistance(vehicleId, eventId, deltaKm) {
    const increment = Number.isFinite(deltaKm) && deltaKm > 0 ? deltaKm : 0;
    const existing = getDistanceCache.get(vehicleId);
    const nextTotal = (existing?.cumulative_km || 0) + increment;

    if (existing) {
      updateDistanceCache.run(eventId, nextTotal, vehicleId);
    } else {
      insertDistanceCache.run(vehicleId, eventId, nextTotal);
    }

    return nextTotal;
  }

  function computePendingRollups(now = Date.now(), options = {}) {
    const nowEpoch = Math.floor(now / 1000);
    const startOverride = toEpochSeconds(options.start);
    const endOverride = toEpochSeconds(options.end);
    const windows = resolveRollupWindows(options.windows);

    const details = [];
    let totalBuckets = 0;

    for (const windowSeconds of windows) {
      const result = computeWindowRollups({
        windowSeconds,
        nowEpoch,
        startOverride,
        endOverride,
        force: options.force === true
      });

      if (result.processed > 0) {
        totalBuckets += result.processed;
        details.push({ windowSeconds, processed: result.processed });
      }
    }

    return { processed: totalBuckets, details };
  }

  function computeWindowRollups({ windowSeconds, nowEpoch, startOverride, endOverride, force }) {
    const earliestEpoch = getEarliestEventEpoch();
    if (!Number.isFinite(earliestEpoch)) {
      return { processed: 0 };
    }

    let effectiveEndEpoch = Number.isFinite(endOverride)
      ? alignToWindow(endOverride, windowSeconds)
      : alignToWindow(nowEpoch, windowSeconds);

    if (effectiveEndEpoch <= earliestEpoch) {
      return { processed: 0 };
    }

    let effectiveStartEpoch = Number.isFinite(startOverride)
      ? alignToWindow(startOverride, windowSeconds)
      : alignToWindow(earliestEpoch, windowSeconds);

    if (!force) {
      const lastProcessedEpoch = getLastRollupEnd(windowSeconds);
      if (Number.isFinite(lastProcessedEpoch)) {
        const catchUpSeconds = windowSeconds * Math.max(1, rollupCatchUpWindows);
        const candidate = alignToWindow(lastProcessedEpoch - catchUpSeconds, windowSeconds);
        if (!Number.isFinite(startOverride)) {
          effectiveStartEpoch = Math.min(candidate, effectiveStartEpoch);
        }
      }
    }

    const floorEarliest = alignToWindow(earliestEpoch, windowSeconds);
    if (!Number.isFinite(startOverride)) {
      effectiveStartEpoch = Math.max(effectiveStartEpoch, floorEarliest);
    }

    if (effectiveStartEpoch >= effectiveEndEpoch) {
      return { processed: 0 };
    }

    const stmt = getRollupStatement(windowSeconds);
    const startIso = toIsoString(effectiveStartEpoch);
    const endIso = toIsoString(effectiveEndEpoch);
    const rows = stmt.all(startIso, endIso);

    if (rows.length === 0) {
      return { processed: 0 };
    }

    applyRollups(
      rows.map(row => ({
        bucket_start: row.bucket_start,
        bucket_end: row.bucket_end,
        vehicle_id: row.vehicle_id,
        avg_speed_kmh: row.avg_speed_kmh ?? 0,
        max_speed_kmh: row.max_speed_kmh ?? 0,
        min_fuel_level: row.min_fuel_level ?? null,
        total_distance_km: row.total_distance_km ?? 0,
        sample_count: row.sample_count ?? 0
      }))
    );

    logger?.debug(
      { windowSeconds, start: startIso, end: endIso, buckets: rows.length },
      'Computed telemetry rollups'
    );

    return { processed: rows.length };
  }

  function startRollupScheduler() {
    if (!rollupIntervalMs || rollupIntervalMs <= 0) {
      logger?.info('Rollup scheduler disabled');
      return;
    }

    if (rollupTimer) {
      return;
    }

    const run = () => {
      try {
        computePendingRollups();
      } catch (err) {
        logger?.error({ err }, 'Failed to compute telemetry rollups');
      }
    };

    rollupTimer = setInterval(run, rollupIntervalMs);
    if (typeof rollupTimer.unref === 'function') {
      rollupTimer.unref();
    }

    initialRunTimer = setTimeout(run, Math.min(rollupIntervalMs, 5_000));
    if (typeof initialRunTimer.unref === 'function') {
      initialRunTimer.unref();
    }
  }

  function stopRollupScheduler() {
    if (rollupTimer) {
      clearInterval(rollupTimer);
      rollupTimer = null;
    }
    if (initialRunTimer) {
      clearTimeout(initialRunTimer);
      initialRunTimer = null;
    }
  }

  function queryTelemetryHistory({ vehicleIds = [], start, end, limit = 500, pageToken } = {}) {
    const clauses = [];
    const params = [];

    if (vehicleIds.length > 0) {
      const placeholders = vehicleIds.map(() => '?').join(',');
      clauses.push(`vehicle_id IN (${placeholders})`);
      params.push(...vehicleIds);
    }
    if (start) {
      clauses.push('recorded_at >= ?');
      params.push(start);
    }
    if (end) {
      clauses.push('recorded_at <= ?');
      params.push(end);
    }
    if (pageToken) {
      clauses.push('event_id > ?');
      params.push(Number(pageToken));
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const effectiveLimit = clampLimit(limit, 5_000);
    const sql = `
      SELECT event_id, vehicle_id, recorded_at, latitude, longitude, speed_kmh,
             fuel_level, engine_status, distance_km
      FROM telemetry_events
      ${whereClause}
      ORDER BY recorded_at ASC, event_id ASC
      LIMIT ?
    `;

    const statement = db.prepare(sql);
    const rows = statement.all(...params, effectiveLimit);

    const nextPageToken = rows.length === effectiveLimit ? String(rows[rows.length - 1].event_id) : null;

    return {
      events: rows.map(row => ({
        eventId: row.event_id,
        vehicleId: row.vehicle_id,
        recordedAt: row.recorded_at,
        latitude: row.latitude,
        longitude: row.longitude,
        speedKmh: row.speed_kmh,
        fuelLevel: row.fuel_level,
        engineStatus: row.engine_status,
        distanceKm: row.distance_km
      })),
      nextPageToken
    };
  }

  function queryHistoricalAggregates({
    vehicleIds = [],
    start,
    end,
    aggregates = [],
    windowSeconds
  } = {}) {
    const effectiveWindowSeconds = normalizePositiveNumber(windowSeconds, baseRollupWindow);
    const resolvedWindowSeconds = Math.max(effectiveWindowSeconds, baseRollupWindow);
    const sourceWindowSeconds = rollupWindows.includes(resolvedWindowSeconds)
      ? resolvedWindowSeconds
      : baseRollupWindow;

    const clauses = [`(strftime('%s', bucket_end) - strftime('%s', bucket_start)) = ?`];
    const params = [sourceWindowSeconds];

    if (vehicleIds.length > 0) {
      const placeholders = vehicleIds.map(() => '?').join(',');
      clauses.push(`vehicle_id IN (${placeholders})`);
      params.push(...vehicleIds);
    }
    if (start) {
      clauses.push('bucket_end > datetime(?)');
      params.push(start);
    }
    if (end) {
      clauses.push('bucket_start < datetime(?)');
      params.push(end);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `
      SELECT bucket_start, bucket_end, vehicle_id, avg_speed_kmh, max_speed_kmh,
             min_fuel_level, total_distance_km, sample_count
        FROM telemetry_rollups
        ${whereClause}
        ORDER BY bucket_start ASC, vehicle_id ASC
    `;
    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
      return [];
    }

    const aggregateKeys = buildAggregateKeySet(aggregates);

    if (resolvedWindowSeconds === sourceWindowSeconds) {
      return rows.map(row => ({
        bucketStart: sqliteDateToIso(row.bucket_start) || row.bucket_start,
        bucketEnd: sqliteDateToIso(row.bucket_end) || row.bucket_end,
        sampleCount: row.sample_count ?? 0,
        metrics: buildMetrics(
          {
            sampleCount: row.sample_count ?? 0,
            sumSpeed: (row.avg_speed_kmh ?? 0) * (row.sample_count ?? 0),
            maxSpeed: Number.isFinite(row.max_speed_kmh) ? row.max_speed_kmh : -Infinity,
            minFuel: Number.isFinite(row.min_fuel_level) ? row.min_fuel_level : Infinity,
            totalDistance: row.total_distance_km ?? 0
          },
          aggregateKeys
        )
      }));
    }

    const targetWindowMs = resolvedWindowSeconds * 1000;
    const bucketMap = new Map();

    for (const row of rows) {
      const bucketStartDate = parseSqliteDate(row.bucket_start);
      if (!bucketStartDate) {
        continue;
      }

      const bucketStartMs = bucketStartDate.getTime();
      const alignedStartMs = Math.floor(bucketStartMs / targetWindowMs) * targetWindowMs;
      const key = alignedStartMs;
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          bucketStart: new Date(alignedStartMs).toISOString(),
          bucketEnd: new Date(alignedStartMs + targetWindowMs).toISOString(),
          sampleCount: 0,
          sumSpeed: 0,
          maxSpeed: -Infinity,
          minFuel: Infinity,
          totalDistance: 0
        });
      }

      const bucket = bucketMap.get(key);
      const samples = row.sample_count ?? 0;
      bucket.sampleCount += samples;
      bucket.sumSpeed += (row.avg_speed_kmh ?? 0) * samples;
      bucket.totalDistance += row.total_distance_km ?? 0;

      if (Number.isFinite(row.max_speed_kmh)) {
        bucket.maxSpeed = Math.max(bucket.maxSpeed, row.max_speed_kmh);
      }
      if (Number.isFinite(row.min_fuel_level)) {
        bucket.minFuel = Math.min(bucket.minFuel, row.min_fuel_level);
      }
    }

    return Array.from(bucketMap.values())
      .sort((a, b) => Date.parse(a.bucketStart) - Date.parse(b.bucketStart))
      .map(bucket => ({
        bucketStart: bucket.bucketStart,
        bucketEnd: bucket.bucketEnd,
        sampleCount: bucket.sampleCount,
        metrics: buildMetrics(bucket, aggregateKeys)
      }));
  }

  function runRollupJob(options = {}) {
    const now = options.now ?? Date.now();
    return computePendingRollups(now, { ...options, force: options.force ?? true });
  }

  function resolveRollupWindows(requested) {
    if (!requested || requested.length === 0) {
      return rollupWindows;
    }

    const merged = new Set(rollupWindows);
    for (const value of requested) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        merged.add(Math.trunc(numeric));
      }
    }

    return Array.from(merged).sort((a, b) => a - b);
  }

  function getRollupStatement(windowSeconds) {
    const key = Number(windowSeconds);
    if (rollupStatementCache.has(key)) {
      return rollupStatementCache.get(key);
    }
    const statement = db.prepare(buildRollupSourceSql(key));
    rollupStatementCache.set(key, statement);
    return statement;
  }

  function getEarliestEventEpoch() {
    const row = selectOldestEvent.get();
    if (!row?.min_recorded) {
      return null;
    }
    const parsed = Date.parse(row.min_recorded);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }

  function getLastRollupEnd(windowSeconds) {
    const row = getLastRollupEndStmt.get(windowSeconds);
    if (!row?.max_end) {
      return null;
    }
    const parsed = Date.parse(row.max_end);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }

  function getRollupWindows() {
    return rollupWindows.slice();
  }

  return {
    recordTelemetry,
    queryTelemetryHistory,
    queryHistoricalAggregates,
    computePendingRollups,
    runRollupJob,
    startRollupScheduler,
    stopRollupScheduler,
    getRollupWindows
  };
}

function computeDeltaKm(previous, currentMessage) {
  if (!previous) {
    return 0;
  }

  const prevLat = Number(previous.lat);
  const prevLng = Number(previous.lng);
  const nextLat = Number(currentMessage.lat);
  const nextLng = Number(currentMessage.lng);

  if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng) || !Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
    return 0;
  }

  return haversine(prevLat, prevLng, nextLat, nextLng);
}

function normalizeIso(value) {
  if (typeof value === 'string') {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return numeric > 0 ? Math.trunc(numeric) : fallback;
}

function normalizeInterval(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  return fallback;
}

function clampLimit(value, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 100;
  }
  return Math.min(Math.trunc(numeric), max);
}

function buildRollupSourceSql(windowSeconds) {
  return `
    SELECT
      vehicle_id,
      datetime((strftime('%s', recorded_at) / ${windowSeconds}) * ${windowSeconds}, 'unixepoch') AS bucket_start,
      datetime(((strftime('%s', recorded_at) / ${windowSeconds}) * ${windowSeconds}) + ${windowSeconds}, 'unixepoch') AS bucket_end,
      AVG(speed_kmh) AS avg_speed_kmh,
      MAX(speed_kmh) AS max_speed_kmh,
      MIN(fuel_level) AS min_fuel_level,
      SUM(distance_km) AS total_distance_km,
      COUNT(*) AS sample_count
    FROM telemetry_events
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY vehicle_id, bucket_start
    ORDER BY bucket_start ASC, vehicle_id ASC
  `;
}

function buildAggregateKeySet(aggregates) {
  if (!Array.isArray(aggregates) || aggregates.length === 0) {
    return new Set(['AVG_SPEED_KMH', 'MAX_SPEED_KMH', 'MIN_FUEL_LEVEL', 'TOTAL_DISTANCE_KM']);
  }

  return new Set(
    aggregates
      .map(value => {
        if (typeof value === 'string') {
          const upperValue = value.toUpperCase();
          // Handle full enum names from gRPC
          if (upperValue.startsWith('AGGREGATE_TYPE_')) {
            return upperValue.substring('AGGREGATE_TYPE_'.length);
          }
          return upperValue;
        }
        switch (value) {
          case 1:
            return 'AVG_SPEED_KMH';
          case 2:
            return 'MAX_SPEED_KMH';
          case 3:
            return 'TOTAL_DISTANCE_KM';
          case 4:
            return 'MIN_FUEL_LEVEL';
          default:
            return null;
        }
      })
      .filter(Boolean)
  );
}

function buildMetrics(bucket, aggregateKeys) {
  const metrics = {};

  if (aggregateKeys.has('AVG_SPEED_KMH')) {
    metrics.AVG_SPEED_KMH = bucket.sampleCount > 0 ? bucket.sumSpeed / bucket.sampleCount : 0;
  }

  if (aggregateKeys.has('MAX_SPEED_KMH') && bucket.maxSpeed !== -Infinity) {
    metrics.MAX_SPEED_KMH = bucket.maxSpeed;
  }

  if (aggregateKeys.has('MIN_FUEL_LEVEL') && bucket.minFuel !== Infinity) {
    metrics.MIN_FUEL_LEVEL = bucket.minFuel;
  }

  if (aggregateKeys.has('TOTAL_DISTANCE_KM')) {
    metrics.TOTAL_DISTANCE_KM = bucket.totalDistance;
  }

  return metrics;
}

function sanitizeRollupWindows(telemetryConfig) {
  const baseWindow = normalizePositiveNumber(telemetryConfig.rollupWindowSeconds, 300);
  const configured = Array.isArray(telemetryConfig.rollupWindows)
    ? telemetryConfig.rollupWindows.filter(win => Number.isFinite(win) && win > 0)
    : [];
  const merged = new Set([baseWindow, ...configured.map(win => Math.trunc(win))]);
  const sorted = Array.from(merged).filter(win => win > 0).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : [baseWindow];
}

function toEpochSeconds(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function toIsoString(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

function alignToWindow(epochSeconds, windowSeconds) {
  return Math.floor(epochSeconds / windowSeconds) * windowSeconds;
}

function parseSqliteDate(value) {
  if (!value) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const withZone = /[zZ]$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sqliteDateToIso(value) {
  const date = parseSqliteDate(value);
  return date ? date.toISOString() : null;
}

module.exports = {
  createTelemetryRepository
};
