# Fleet Management Demo with MQTT and Gatling

A fully functional demo showcasing **real-time fleet tracking** using:

- **MQTT** for lightweight messaging
- **Gatling** for load testing in JavaScript/TypeScript
- **Node.js backend** for message processing
- **Web frontend** for live visualization

---

## Features
- Simulate **thousands of vehicles** sending GPS data
- Real-time map visualization of vehicle movement
- Gatling load tests for MQTT to **stress-test your system**
- End-to-end example of scalable IoT architecture

---

## Architecture

[Simulated Fleet] --(MQTT publish)--> [Broker]
                                         |
                               [Backend subscriber]
                               |                 |
                        (WS broadcast)     (metrics/logs)
                               |
                          [Frontend UI]
                                ^
                                |
                 [Gatling MQTT VUs publish/subscribe]



**Components:**
1. **MQTT Broker:** Handles publish/subscribe messaging (e.g., Mosquitto).
2. **Simulated Vehicles:** Scripted clients publishing GPS data.
3. **Backend:** Subscribes to MQTT topics, forwards updates via WebSocket.
4. **Frontend:** Displays vehicle locations on a map.
5. **Gatling Load Tests:** Simulates thousands of MQTT clients.

---

## Prerequisites
- [Node.js](https://nodejs.org/) v20+
- [Mosquitto MQTT Broker](https://mosquitto.org/)
- [Gatling](https://gatling.io/open-source/)
- npm or yarn

---

## Getting Started

### 1. Clone the Repository
```bash
git clone https://github.com/your-org/fleet-mqtt-demo.git
cd fleet-mqtt-demo
```

### 2. Bootstrap Milestone 1

1. Start the Mosquitto broker:
   ```bash
   docker compose up -d broker
   ```
2. Install Node dependencies:
   ```bash
   npm install
   ```
3. Publish a demo telemetry message:
   ```bash
   npm run simulate
   ```
4. Run the backend subscriber to log incoming events:
   ```bash
   npm run backend
   ```

### Simulator configuration

The simulator accepts both CLI flags and environment variables (including values inside a `.env` file):

```bash
npm run simulate -- \
  --vehicles=500 \
  --rate=1s \
  --qos=1 \
  --jitter=200ms \
  --region=paris
```

**CLI flags** (CLI overrides environment variables):

- `--host` / `--port` — MQTT broker connection
- `--topic` — publish topic (default `fleet/demo/telemetry`)
- `--qos` — QoS level 0–2
- `--vehicles` — number of simulated vehicles (default 1)
- `--rate` — base publish interval (supports `ms`, `s`, `m` suffixes)
- `--jitter` — random jitter window to add/subtract from the interval
- `--region` — region label used in generated IDs
- `--seed` — optional seed to make generated IDs repeatable

**Environment variables** (can be set inline, exported, or via `.env`):

- `BROKER_HOST`, `BROKER_PORT` — broker connection
- `SIM_HOST`, `SIM_PORT` — aliases for the above
- `SIM_TOPIC` — publish topic
- `SIM_QOS` — QoS level
- `SIM_VEHICLES` — number of vehicles
- `SIM_RATE` — base publish interval (milliseconds, or with `ms`/`s`/`m` suffix)
- `SIM_JITTER` — jitter window (same units as `SIM_RATE`)
- `SIM_REGION` — region label
- `SIM_SEED` — optional deterministic seed
- `SUB_TOPIC` — adjusts the backend subscription pattern

Example `.env` snippet:

```dotenv
BROKER_HOST=localhost
BROKER_PORT=1883
SIM_TOPIC=fleet/demo/telemetry
SIM_VEHICLES=250
SIM_RATE=750ms
SIM_REGION=berlin
```

### Frontend dashboard (Milestone 4)

1. Start the backend (`npm run backend`) so the WebSocket stream (`ws://localhost:8080/stream`) and stats endpoint (`http://localhost:8080/stats`) are available.
2. Serve the static frontend (any static file server works). For example:
   ```bash
   python3 -m http.server 4173 --directory frontend
   ```
3. Open `http://localhost:4173` in your browser. The dashboard connects to the backend by default at `http://localhost:8080`; adjust the `window.APP_CONFIG` block in `frontend/index.html` if you host the backend elsewhere.

The UI renders a Leaflet map with live vehicle markers, short position trails, automatic marker clustering for large fleets, and a sidebar showing active vehicles, message throughput, and average latency. WebSocket reconnects use exponential backoff and you can trigger a manual reconnect from the sidebar.

Stop the docker stack when finished:
```bash
docker compose down
```
