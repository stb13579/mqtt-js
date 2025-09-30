#!/usr/bin/env node
const { config, logger } = require('../config');
const { createDatabase } = require('../db');
const { createTelemetryRepository } = require('../services/telemetry-repository');

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

(async () => {
  const { db, close } = createDatabase({ config, logger });
  const telemetryRepository = createTelemetryRepository({ db, logger, config });

  const windows = parseWindowList(process.env.ROLLUP_WINDOWS);
  const start = process.env.ROLLUP_START || null;
  const end = process.env.ROLLUP_END || null;

  try {
    const result = telemetryRepository.runRollupJob({
      start,
      end,
      windows,
      force: true
    });

    logger.info({ processed: result.processed, details: result.details }, 'Telemetry rollup job complete');
  } catch (err) {
    logger.error({ err }, 'Telemetry rollup job failed');
    process.exitCode = 1;
  } finally {
    telemetryRepository.stopRollupScheduler();
    close();
  }
})();

process.on('unhandledRejection', err => {
  logger.error({ err }, 'Unhandled rejection in rollup worker');
  process.exit(1);
});

process.on('uncaughtException', err => {
  logger.error({ err }, 'Uncaught exception in rollup worker');
  process.exit(1);
});
