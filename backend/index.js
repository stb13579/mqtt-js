#!/usr/bin/env node
const mqtt = require('mqtt');
const pino = require('pino');

const logger = pino({ name: 'backend', level: process.env.LOG_LEVEL || 'info' });

const host = process.env.BROKER_HOST || 'localhost';
const port = process.env.BROKER_PORT || '1883';
const topic = process.env.SUB_TOPIC || 'fleet/+/telemetry';

const client = mqtt.connect({
  protocol: 'mqtt',
  host,
  port: Number(port),
  keepalive: 30
});

client.on('connect', () => {
  logger.info({ host, port, topic }, 'Connected to broker, subscribing');
  client.subscribe(topic, err => {
    if (err) {
      logger.error({ err }, 'Subscription failed');
      process.exit(1);
    }
    logger.info({ topic }, 'Subscription complete');
  });
});

client.on('message', (receivedTopic, payload) => {
  const raw = payload.toString();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    logger.warn({ topic: receivedTopic, raw }, 'Received non-JSON payload');
    return;
  }

  logger.info({ topic: receivedTopic, data }, 'Received telemetry');
});

client.on('error', err => {
  logger.error({ err }, 'MQTT error');
});

process.on('SIGINT', () => {
  logger.info('Shutting down');
  client.end(false, () => process.exit(0));
});

process.on('SIGTERM', () => {
  logger.info('Shutting down');
  client.end(false, () => process.exit(0));
});
