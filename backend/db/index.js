const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createDatabase({ config, logger }) {
  const dbPath = config.telemetryDb?.path;
  if (!dbPath) {
    throw new Error('telemetryDb.path is required');
  }

  ensureDirectory(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db, logger);

  logger?.info({ dbPath }, 'SQLite telemetry database ready');

  return {
    db,
    close: () => {
      db.close();
      logger?.info('SQLite telemetry database closed');
    }
  };
}

function runMigrations(db, logger) {
  const migrationsDir = path.join(__dirname, 'migrations');
  ensureDirectory(migrationsDir);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at DATETIME NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(appliedRows.map(row => row.version));

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))'
  );

  const applyMigration = db.transaction((version, sql) => {
    db.exec(sql);
    insertMigration.run(version);
  });

  for (const file of migrationFiles) {
    const version = file.replace(/\.sql$/u, '');
    if (applied.has(version)) {
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    logger?.info({ version, file }, 'Applying SQLite migration');
    applyMigration(version, sql);
  }
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

module.exports = {
  createDatabase
};
