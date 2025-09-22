# Development Plan

## Milestone 1 — Bootstrap & Broker (Day 0–1)

- `docker-compose.yml` with Mosquitto (default port 1883 + 9001 for WS if needed)
- Minimal simulator: publish one message to `fleet/demo/telemetry`
- Basic backend that connects to broker and logs messages

**docker-compose.yml (sketch):**
```yaml
services:
  broker:
    image: eclipse-mosquitto:2
    ports: ["1883:1883", "9001:9001"]
    volumes:
      - ./broker/mosquitto.conf:/mosquitto/config/mosquitto.conf
```

**mosquitto.conf (sketch):**
```conf
# Default MQTT
listener 1883
allow_anonymous true
persistence true

# Optional websocket listener
listener 9001
protocol websockets
```

---

## Milestone 2 — Simulator (Day 1–2)

- CLI: `npm run simulate -- --vehicles=500 --rate=1s --qos=1 --jitter=200ms --region=paris`
- Randomized routes (polyline paths), configurable seeds, graceful reconnects
- Optional command subscription: respond to `fleet/broadcast/commands` (e.g., set publish interval)

---

## Milestone 3 — Backend (Day 2–3)

- Subscribe to `fleet/+/telemetry`, validate JSON, enrich (derived speed, last seen)
- WebSocket broadcast channel: `ws://localhost:8080/stream` pushes minimal diffs (vehicleId, lat, lng, ts, speed)
- In-memory store: last-known state per vehicle (LRU for memory cap)
- Basic metrics endpoint `/metrics` (Prometheus) or simple JSON `/stats` (counts, msg/sec, connected vehicles)
- Health checks: `/healthz`, `/readyz`

---

## Milestone 4 — Frontend (Day 3–4)

- Map with Leaflet, real-time markers, small trail (last N points)
- Sidebar with counters (active vehicles, msg/sec, average latency) and filters (status, min fuel)
- Cluster markers when N is high; throttle renders (e.g., 250ms)
- Error handling for WS reconnects

---

## Milestone 5 — Gatling MQTT Tests (Day 4–5)

- Base scenario: N VUs connect → publish telemetry every T ms → optional subscribe to command topic

**Scenarios:**
  - **Ramp:** 0 → 5k devices over 10 min
  - **Spike:** sudden 2k joins in 30s
  - **Steady:** 3k devices for 30 min
  - **Soak:** 1k devices for 2h (CI optional)

**Assertions:**
  - Connection success rate ≥ 99%
  - Pub ack latency p95 < 200 ms
  - Message loss < 0.1%
  - Broker CPU < threshold (if observable)

- Parameterize via env (`BROKER_HOST`, `BROKER_PORT`, `QOS`, `PAYLOAD_SIZE`)

---

## Milestone 6 — Polish & Docs (Day 5)

- Screenshots/GIF of the dashboard under load
- README quickstart, Notion blog post (done), and doc “How it works” linking code
- Example results folder with sanitized Gatling report screenshots