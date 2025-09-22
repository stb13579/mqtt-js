#!/usr/bin/env node
const mqtt = require('mqtt');

const host = process.env.BROKER_HOST || 'localhost';
const port = process.env.BROKER_PORT || '1883';
const topic = process.env.SIM_TOPIC || 'fleet/demo/telemetry';

const client = mqtt.connect({
  protocol: 'mqtt',
  host,
  port: Number(port),
  reconnectPeriod: 0
});

client.on('connect', () => {
  const payload = {
    vehicleId: `demo-${Date.now()}`,
    lat: 48.8566,
    lng: 2.3522,
    ts: new Date().toISOString()
  };

  const message = JSON.stringify(payload);
  client.publish(topic, message, { qos: 0 }, err => {
    if (err) {
      console.error('[simulator] publish failed', err);
      process.exitCode = 1;
    } else {
      console.log(`[simulator] published to ${topic}: ${message}`);
    }
    client.end(true, () => process.exit());
  });
});

client.on('error', err => {
  console.error('[simulator] connection error', err);
  process.exit(1);
});
