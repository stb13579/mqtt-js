# Fleet Management Demo for Gatling

A fully functional demo showcasing **real-time fleet tracking** using:

- **MQTT** for lightweight messaging
- **Gatling** for load testing in JavaScript/TypeScript
- **Node.js backend** for message processing
- **Web frontend** for live visualization
- **HTTP and WebSocket** endpoints, which can also be used for testing
---

## Features
- Simulate **thousands of vehicles** sending GPS data
- Real-time map visualization of vehicle movement with rollups and recent history panels
- gRPC analytics service for fleet snapshots, historical replay, and aggregate queries
- Gatling load tests for MQTT and gRPC traffic to **stress-test your system**
- End-to-end example of scalable IoT architecture

---

## Architecture

```
                               ┌────────────────────────────┐
                               │ Gatling MQTT virtual users │
                               └────────────┬───────────────┘
                                            │ MQTT publish
┌────────────────────────────┐              │
│ Simulator (optional load)  │──────────────┘ MQTT messages originate from Gatling or simulator
└──────────────┬─────────────┘
               │
               │ MQTT publish
        ┌──────▼────────┐
        │   MQTT broker │
        └──────┬────────┘
               │ subscribe
        ┌──────▼────────┐                     ┌────────────────────────────┐
        │ Backend/API   │                     │ Gatling gRPC / analytics   │
        │ + WS fan-out  │◄────────────────────┤ clients & dashboards       │
        │ + gRPC layer  │        gRPC calls   └────────────────────────────┘
        └──────┬────────┘
               │ WebSocket stream
        ┌──────▼────────┐
        │ Frontend UI   │
        └──────┬────────┘
               │ HTTP/WS
        ┌──────▼────────┐
        │Human operator │
        └───────────────┘
```



**Components:**
1. **MQTT Broker:** Handles publish/subscribe messaging (e.g., Mosquitto).
2. **Simulated Vehicles:** Scripted clients publishing GPS data.
3. **Backend:** Subscribes to MQTT topics, stores telemetry in SQLite, serves gRPC and HTTP APIs.
4. **gRPC Telemetry Service:** Fleet snapshots, historical replay, and aggregate queries.
5. **Frontend:** Displays live vehicles, rollup metrics, and recent telemetry history.
6. **Gatling Load Tests:** Simulates thousands of MQTT or gRPC clients.

---

## Prerequisites
- [Node.js](https://nodejs.org/) v20+
- [Mosquitto MQTT Broker](https://mosquitto.org/)
- [Gatling](https://gatling.io/open-source/)
- npm or yarn

---

## Quickstart

### Launch the local stack

1. Clone the repository and install the root dependencies:
   ```bash
   git clone https://github.com/stb13579/mqtt-js.git
   cd mqtt-js
   npm install
   ```
2. Copy the sample environment file and review the broker coordinates:
   ```bash
   cp example.env .env
   ```
   A minimal local configuration looks like:
   ```dotenv
   BROKER_HOST=localhost
   BROKER_HOST_CONTAINER=broker
   BROKER_PORT=1883
   BROKER_TLS=false
   SIM_TOPIC=fleet/demo/telemetry
   SIM_VEHICLES=250
   SIM_RATE=750ms
   SIM_REGION=berlin
   ```
3. Launch the Mosquitto broker in Docker:
   ```bash
   docker compose up -d broker
   ```
4. Start the backend subscriber in a new terminal:
   ```bash
   npm run backend
   ```
   The API answers on `http://localhost:8080` with readiness at `/readyz`, stats at `/stats`, WebSocket stream at `/stream`, and gRPC on an ephemeral port logged as `gRPC server listening` (set `GRPC_PORT=50051` for a fixed port).
5. Start the frontend in a separate terminal:
   ```bash
   npm run dev
   ```
   Vite serves the dashboard at `http://localhost:5173`. Use `npm run build && npm run start` if you prefer the production build on port `4173`.
6. (Optional) Generate background telemetry:
   ```bash
   npm run simulate -- --vehicles=25 --rate=1s --region=paris
  ```
   Stop the simulator with `Ctrl+C` once you have the desired sample load.

### gRPC telemetry API

The backend persists telemetry in SQLite and serves a gRPC surface for dashboards, workers, or load tests. Pin the listener to a predictable port, then query it with `grpcurl` (reflection is off so point at the local proto):

```bash
GRPC_PORT=50051 npm run backend

grpcurl -plaintext \
  -import-path protos \
  -proto telemetry.proto \
  -d '{}' \
  localhost:50051 telemetry.v1.TelemetryService/GetFleetSnapshot

START=$(($(date +%s) - 600))
END=$(date +%s)
grpcurl -plaintext \
  -import-path protos \
  -proto telemetry.proto \
  -d "{\"range\":{\"start\":{\"seconds\":$START},\"end\":{\"seconds\":$END}},\"limit\":50}" \
  localhost:50051 telemetry.v1.TelemetryService/QueryTelemetryHistory
```

For environments that prefer REST, the backend exposes analytics facades backed by the same rollups and history:

- `GET /telemetry/summary?windowSeconds=900&durationSeconds=900` &mdash; aggregated speed, fuel, and distance metrics.
- `GET /telemetry/history?durationSeconds=900&limit=20` &mdash; most recent telemetry samples (optionally filter with `vehicleId=<id>`).

The frontend sidebar consumes these endpoints to render rolling KPIs and a recent telemetry table.

### Smoke test with Gatling (TypeScript)

```bash
cd gatling/typescript
npm install
npx gatling run --typescript --simulation deliveryVehicleSimulation \
  loadProfile=smoke \
  brokerHost=localhost \
  brokerPort=1883 \
  brokerTls=false \
  telemetryIntervalMs=1000 \
  telemetryDurationSeconds=120
```

Gatling creates reports under `gatling/typescript/target/gatling/<timestamp>`. Open `index.html` in that folder to review charts and assertions.

### Smoke test with Gatling (JavaScript)

```bash
cd gatling/javascript
npm install
npx gatling run --simulation deliveryVehicleSimulation \
  loadProfile=smoke \
  brokerHost=localhost \
  brokerPort=1883 \
  brokerTls=false \
  telemetryIntervalMs=1000 \
  telemetryDurationSeconds=120
```

Use identical key/value arguments across languages; Gatling resolves them through the `getParameter()` helper. Append `deviceCount=20` or `topic=fleet/demo/telemetry` to override defaults.

### gRPC Gatling sample

When the Gatling JS gRPC module ships, run the bundled TelemetryService scenarios to exercise historical queries under load:

```bash
# JavaScript
cd gatling/javascript
npm install
npx gatling run --simulation telemetryGrpcSimulation \
  grpcHost=localhost \
  grpcPort=50051 \
  grpcTls=false \
  windowSeconds=900

# TypeScript
cd ../typescript
npm install
npx gatling run --typescript --simulation telemetryGrpcSimulation \
  grpcHost=localhost \
  grpcPort=50051 \
  grpcTls=false \
  windowSeconds=900
```

See `gatling/README.md` for additional parameters (`fleetUsers`, `historyUsers`, `historyDurationSeconds`, etc.).

## Backend Layout & Configuration

The backend runtime is now composed of small modules that make it easier to test and extend:

```
backend/
├── index.js               # Application bootstrap & graceful shutdown
├── config/
│   └── index.js           # Environment parsing and logger setup
├── middleware/
│   ├── cors.js            # Minimal CORS preflight handling
│   └── error-handler.js   # Uniform HTTP error responses
├── routes/
│   └── api.js             # /healthz, /readyz, /stats, /telemetry/* endpoints
├── services/
│   ├── grpc-service.js    # TelemetryService gRPC surface
│   ├── mqtt-service.js    # Broker subscription and telemetry enrichment
│   ├── telemetry-repository.js # SQLite persistence, rollups, and queries
│   ├── vehicle-store.js   # In-memory cache with TTL eviction
│   └── websocket-service.js # Stream fan-out and backpressure guardrails
├── db/
│   ├── index.js           # SQLite bootstrap and migration runner
│   └── migrations/        # Versioned schema migrations
├── workers/
│   └── rollup-worker.js   # CLI worker for backfilling rollups
└── utils/
    ├── message-metrics.js # Sliding window message rate calculations
    ├── validation.js      # Telemetry schema validation helpers
    └── geo.js             # Haversine helpers shared by MQTT + persistence
```

`backend/config/index.js` centralises defaults for the environment variables listed below. Override them in `.env` or the process environment to change behaviour without touching code.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Pino log level for all backend modules. |
| `BROKER_HOST` | `localhost` | MQTT broker host. |
| `BROKER_PORT` | `1883` | MQTT broker port. |
| `BROKER_USERNAME` / `BROKER_PASSWORD` | empty | Optional broker authentication. |
| `BROKER_TLS` | `false` | Enable TLS (`mqtts`). |
| `BROKER_TLS_REJECT_UNAUTHORIZED` | `true` | Validate broker certificates when TLS is enabled. |
| `BROKER_CLIENT_ID` | empty | Override MQTT client identifier. |
| `SUB_TOPIC` | `fleet/+/telemetry` | Telemetry subscription topic. |
| `PORT` | `8080` | HTTP server port for `/healthz`, `/readyz`, `/stats`, and `/stream`. |
| `VEHICLE_CACHE_SIZE` | `1000` | Maximum vehicles retained in memory before oldest eviction. |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Sliding window used to compute messages-per-second. |
| `VEHICLE_TTL_MS` | `60000` | Time-to-live for inactive vehicles (set to `0` to disable). |
| `TELEMETRY_DB_PATH` | `<repo>/data/telemetry.db` | SQLite file used for historical storage (created on launch). |
| `TELEMETRY_ROLLUP_WINDOW_SECONDS` | `300` | Base aggregation window (seconds) for rollups. |
| `TELEMETRY_ROLLUP_WINDOWS` | empty | Optional comma-separated additional rollup windows (e.g., `900,3600`). |
| `TELEMETRY_ROLLUP_INTERVAL_MS` | `60000` | Frequency for the rollup scheduler to compute new buckets. |
| `TELEMETRY_ROLLUP_CATCHUP_WINDOWS` | `1` | How many extra windows to recompute when catching up after downtime. |
| `GRPC_ENABLED` | `true` | Enable the TelemetryService gRPC server. |
| `GRPC_HOST` | `0.0.0.0` | Bind address for the gRPC server. |
| `GRPC_PORT` | `0` | gRPC port (`0` lets the OS assign one; override for fixed ports). |
| `GRPC_STREAM_INTERVAL_MS` | `1000` | Poll interval for `StreamVehicleSnapshots` fallback updates. |

The service-level tests under `test/mqtt-service.test.js`, `test/websocket-service.test.js`, and `test/vehicle-store.test.js` provide focused coverage for telemetry validation, cache expiry, and WebSocket backpressure.

Need to backfill analytics after importing data? Run the rollup worker:

```bash
ROLLUP_WINDOWS=900,3600 ROLLUP_START="2024-01-01T00:00:00Z" npm run rollups
```

The worker shares the same configuration parser as the backend, so env overrides like `TELEMETRY_DB_PATH` apply automatically.

## Managed MQTT Broker

1. Provision your broker (HiveMQ Cloud, EMQX, Amazon IoT Core, etc.) and collect the host, port, credentials, and TLS requirements.
2. Update `.env` with the managed endpoint:
   ```dotenv
   BROKER_HOST=your-cluster-name.s1.eu.hivemq.cloud
   BROKER_PORT=8883
   BROKER_USERNAME=demo-user
   BROKER_PASSWORD=super-secret
   BROKER_TLS=true
   BROKER_TLS_REJECT_UNAUTHORIZED=true
   BROKER_HOST_CONTAINER=your-cluster-name.s1.eu.hivemq.cloud
   ```
3. Skip the local Mosquitto instance when starting Docker Compose:
   ```bash
   docker compose up --build backend frontend
   ```
4. Run the simulator or Gatling tests with the same credentials:
   ```bash
   BROKER_HOST=your-cluster-name.s1.eu.hivemq.cloud \
   BROKER_PORT=8883 \
   BROKER_TLS=true \
   BROKER_USERNAME=demo-user \
   BROKER_PASSWORD=super-secret \
   npm run simulate -- --vehicles=100 --rate=1s
   ```
   For Gatling, append the same values as key/value pairs (for example `brokerHost=your-cluster-name.s1.eu.hivemq.cloud brokerTls=true`).
5. If your provider exposes a custom CA chain, mount it inside containers and temporarily set `BROKER_TLS_REJECT_UNAUTHORIZED=false` until the certificate store is updated. Re-enable strict verification afterwards.

## Load Testing Scenarios

### Components

- **Connection handshake:** Each virtual device performs an MQTT connect with correlation on the `vehicleId`.
- **Stateful telemetry loop:** Vehicles publish JSON payloads that include coordinates, engine status, fuel level, and timestamps.
- **Profile-controlled injection:** Predefined scenarios (`ramp`, `spike`, `steady`, `soak`, `smoke`) regulate user counts and duration.
- **Assertions:** The simulation enforces 99% successful connects, under 200 ms publish latency at the 95th percentile, and fewer than 0.1% publish failures.
- **Extensibility:** Adjust geography, cadence, and topics without modifying source by supplying extra `key=value` parameters.

### Profiles

| Profile | Virtual devices | Default duration | Injection strategy | Primary use |
| --- | --- | --- | --- | --- |
| `smoke` | 2 | 2 minutes | `atOnceUsers(2)` | Quick integration validation. |
| `ramp` | 5000 | 10 minutes | Linear ramp over 10 minutes | Confidence before sustained load. |
| `spike` | 2000 | 10 minutes | Ramp over 30 seconds | Burst traffic and throttle testing. |
| `steady` | 3000 | 30 minutes | Step to constant load | Throughput and resource sizing. |
| `soak` | 1000 | 2 hours | Constant load | Long-running stability checks. |

Override `deviceCount` or `telemetryDurationSeconds` to resize a profile while preserving its shape.

### Artifacts

- **TypeScript simulation:** `gatling/typescript/src/deliveryVehicleSimulation.gatling.ts` - run with `--typescript`, results in `gatling/typescript/target/gatling`.
- **JavaScript simulation:** `gatling/javascript/src/deliveryVehicleSimulation.gatling.js` - run without extra flags, results in `gatling/javascript/target/gatling`.
- Use `npx gatling run --help` to inspect global CLI switches such as `--results-folder` or `--memory`.

## CLI and Environment Reference

### Application commands

| Command | Purpose |
| --- | --- |
| `npm run backend` | Start the Node.js backend (HTTP + WebSocket). |
| `npm run simulate [-- <flags>]` | Produce synthetic telemetry with the CLI or `.env` settings. |
| `npm run dev` | Launch the Vite dev server for the frontend on port 5173. |
| `npm run build` | Build the production frontend bundle. |
| `npm run start` | Serve the built frontend on port 4173. |
| `docker compose up --build backend frontend broker` | Run backend, frontend, and broker containers together. |
| `docker compose --profile simulator up --build simulator` | Run the simulator container against the active broker. |
| `docker compose down` | Stop and remove Compose services. |

### Simulator CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `--host` | `localhost` | MQTT broker host to publish against. |
| `--port` | `1883` | MQTT broker port. |
| `--username` / `--password` | none | Optional MQTT credentials. |
| `--tls` | `false` | Enable TLS (`mqtts`). |
| `--reject-unauthorized` | `true` | Enforce broker certificate validation when TLS is on. |
| `--topic` | `fleet/demo/telemetry` | Publish topic (can include wildcards). |
| `--qos` | `0` | MQTT QoS level (0, 1, or 2). |
| `--vehicles` | `1` | Number of simulated vehicles. |
| `--max-messages` | unlimited | Stop after emitting this many messages. |
| `--rate` | `1s` | Base interval between publishes; accepts `ms`, `s`, or `m`. |
| `--jitter` | `0ms` | Random jitter window added/subtracted from the interval. |
| `--region` | `paris` | Region preset for coordinate generation. |
| `--seed` | none | Seed for deterministic vehicle IDs. |
| `--help` |  | Show usage and exit. |

CLI arguments take precedence over environment variables.

### Environment variables

**Broker and shared settings**

| Variable | Default | Description |
| --- | --- | --- |
| `BROKER_HOST` | `localhost` | Hostname used by local Node processes. |
| `BROKER_PORT` | `1883` | Plain MQTT port. |
| `BROKER_HOST_CONTAINER` | `broker` | Hostname used inside Docker containers. |
| `BROKER_USERNAME` / `BROKER_PASSWORD` | none | MQTT credentials. |
| `BROKER_TLS` | `false` | Set `true` to enable TLS. |
| `BROKER_TLS_REJECT_UNAUTHORIZED` | `true` | Reject invalid certificates when TLS is enabled. |
| `BROKER_CLIENT_ID` | none | Override MQTT client ID for the backend. |

**Backend**

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port for the backend service. |
| `SUB_TOPIC` | `fleet/+/telemetry` | MQTT subscription filter. |
| `VEHICLE_CACHE_SIZE` | `1000` | Maximum cached vehicles for replay to WebSocket clients. |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Sliding window for throughput metrics. |
| `VEHICLE_TTL_MS` | `60000` | Time-to-live before inactive vehicles are purged (`0` disables). |
| `LOG_LEVEL` | `info` | Pino logger verbosity. |

**Simulator**

| Variable | Default | Description |
| --- | --- | --- |
| `SIM_HOST` / `SIM_PORT` | inherit `BROKER_*` | Alternative host/port aliases. |
| `SIM_TOPIC` | `fleet/demo/telemetry` | Publish topic. |
| `SIM_QOS` | `0` | QoS level. |
| `SIM_VEHICLES` | `1` | Number of vehicles. |
| `SIM_MAX_MESSAGES` | unlimited | Maximum messages before exit. |
| `SIM_RATE` | `1000` | Interval in ms (accepts suffixes). |
| `SIM_JITTER` | `0` | Jitter window. |
| `SIM_REGION` | `paris` | Region preset. |
| `SIM_SEED` | none | Deterministic seed. |
| `SIM_USERNAME` / `SIM_PASSWORD` | none | Broker credentials. |
| `SIM_TLS` | `false` | Enable TLS. |
| `SIM_TLS_REJECT_UNAUTHORIZED` | `true` | TLS certificate validation toggle. |

**Docker Compose overrides**

| Variable | Default | Description |
| --- | --- | --- |
| `BACKEND_PORT` | `8080` | Host port exposed for the backend container. |
| `FRONTEND_PORT` | `4173` | Host port exposed for the frontend container. |
| `HOST_BROKER_PORT` | `1883` | Host port mapped to Mosquitto MQTT. |
| `HOST_BROKER_WS_PORT` | `9001` | Host port mapped to Mosquitto WebSocket. |

### Gatling CLI

- Use `npx gatling run [options] [key=value ...]` from `gatling/typescript` or `gatling/javascript`.
- `--typescript` compiles TypeScript sources; omit it for JavaScript.
- Add `--results-folder <path>` or `--memory <MiB>` as needed.
- Reports are generated in the `target/gatling` folder within the language-specific project.

### Gatling parameter catalog

| Parameter | Default | Description |
| --- | --- | --- |
| `brokerHost` | `broker.hivemq.com` | MQTT broker host for virtual devices. |
| `brokerPort` | `8883` | MQTT broker port. |
| `brokerTls` | `true` | Enable TLS for the MQTT connection. |
| `loadProfile` | `ramp` | One of `ramp`, `spike`, `steady`, `soak`, `smoke`. |
| `deviceCount` | profile default | Number of virtual vehicles to inject. |
| `telemetryDurationSeconds` | profile default | How long each device sends telemetry. |
| `telemetryIntervalMs` | `1000` | Delay between telemetry messages. |
| `engineStatus` | `idle` | Engine status string inserted into payloads. |
| `topic` | auto-generated | Publish topic; defaults to per-vehicle channel. |
| `baseLat` | `37.7749` | Latitude for the fleet centroid. |
| `baseLng` | `-122.4194` | Longitude for the fleet centroid. |
| `spawnRadius` | `0.05` | Degrees of random offset for initial positions. |
| `movementStep` | `0.005` | Degrees travelled per update. |
| `startingFuel` | `95` | Initial fuel level percentage. |
| `minimumFuel` | `15` | Lower bound for fuel depletion. |

Pass overrides as `key=value` pairs at the end of the `npx gatling run` command. Combine them with CI variables or `.env` exports for reproducible runs.
