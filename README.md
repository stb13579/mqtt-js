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

Environment variables you can override:

- `BROKER_HOST` / `BROKER_PORT` to point at a remote broker
- `SIM_TOPIC` to change the simulator publish topic
- `SUB_TOPIC` to adjust the backend subscription pattern

Stop the docker stack when finished:
```bash
docker compose down
```
