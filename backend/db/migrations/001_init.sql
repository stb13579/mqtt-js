PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id TEXT PRIMARY KEY,
  first_seen_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  last_latitude REAL,
  last_longitude REAL,
  last_engine_status TEXT,
  last_fuel_level REAL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  recorded_at DATETIME NOT NULL,
  ingest_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  speed_kmh REAL NOT NULL,
  fuel_level REAL NOT NULL,
  engine_status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_vehicle_time
  ON telemetry_events(vehicle_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_ingest_time
  ON telemetry_events(ingest_at);

CREATE TABLE IF NOT EXISTS telemetry_distance_cache (
  vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  last_event_id INTEGER NOT NULL REFERENCES telemetry_events(event_id) ON DELETE CASCADE,
  cumulative_km REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_rollups (
  bucket_start DATETIME NOT NULL,
  bucket_end DATETIME NOT NULL,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(vehicle_id) ON DELETE CASCADE,
  avg_speed_kmh REAL,
  max_speed_kmh REAL,
  min_fuel_level REAL,
  total_distance_km REAL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (bucket_start, bucket_end, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_rollups_vehicle_time
  ON telemetry_rollups(vehicle_id, bucket_start);
