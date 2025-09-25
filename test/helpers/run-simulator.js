const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const { withNodeOptions } = require('./backend-process');
const { attachFakeMqttBridge } = require('./fake-mqtt-bridge');

const repoRoot = path.resolve(__dirname, '..');
const simulatorPath = path.resolve(repoRoot, '../simulator/index.js');
const registerPath = path.resolve(__dirname, 'register-fake-mqtt.js');

async function runSimulator(args, envOverrides = {}) {
  const child = spawn(process.execPath, [simulatorPath, ...args], {
    env: {
      ...process.env,
      NODE_OPTIONS: withNodeOptions(`--require=${registerPath}`, process.env),
      FAKE_MQTT_ROLE: 'worker',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  const _bridge = attachFakeMqttBridge(child);

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const [code] = await once(child, 'exit');
  return {
    code,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

module.exports = {
  runSimulator
};
