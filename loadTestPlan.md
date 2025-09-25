
The purpose of these tests is to **simulate real-world conditions** such as network flakiness, sudden load spikes, and scaling challenges.

---

## 1. Broker- & Protocol-Level Issues

### **1.1 QoS/Inflight Pressure (QoS 1 Storms)**
- **Problem:** With thousands of vehicles on QoS 1, PUBACK round-trips and inflight message windows create backpressure.
- **How to Simulate:**
  - Simulator: publish QoS=1 at high frequency.
  - Gatling: ramp up clients quickly with a low inflight window.
  - Broker: limit `max_inflight_messages`.
- **Metrics:**
  - p95/p99 publish latency
  - PUBACK latency
  - Message backlog size
  - Broker CPU load

---

### **1.2 Retained Message Bloat**
- **Problem:** Retained telemetry for every vehicle causes memory and startup floods.
- **How to Simulate:**
  - Simulator sets `retain=true` for all messages.
  - New dashboard clients subscribe repeatedly to simulate cold-start.
- **Metrics:**
  - Broker memory usage
  - Latency for initial subscription delivery

---

### **1.3 Wildcard Subscription Fan-out**
- **Problem:** Subscribing to `fleet/+/telemetry` creates broker fan-out overhead.
- **How to Simulate:**
  - Backend uses a wildcard subscription.
  - Increase message rate to force heavy fan-out.
- **Metrics:**
  - Broker routing CPU usage
  - Latency between publish and delivery to subscriber

---

### **1.4 Persistent Sessions & Offline Queues**
- **Problem:** Vehicles that disconnect cause queued messages to accumulate.
- **How to Simulate:**
  - 10% of simulated vehicles disconnect for 2–5 minutes.
  - Use `cleanSession=false` and session expiry.
- **Metrics:**
  - Queue growth rate
  - Time to drain queue after reconnect

---

### **1.5 LWT (Last Will and Testament) Storms**
- **Problem:** Sudden network failures trigger a flood of "vehicle offline" LWT messages.
- **How to Simulate:**
  - Configure LWT per vehicle.
  - Kill a large set of connections simultaneously.
- **Metrics:**
  - LWT message throughput
  - Broker recovery time

---

## 2. Network & Transport Faults

### **2.1 Cellular-Style Impairments**
- **Problem:** Real-world mobile networks are unstable.
- **How to Simulate:**
  - Use `tc netem` to inject:
    - Delay (latency)
    - Jitter
    - Packet loss
    - Bandwidth throttling
- **Metrics:**
  - Publish → delivery latency
  - Retransmissions
  - Connect failure rates

---

### **2.2 Reconnect/Churn Storms**
- **Problem:** Large groups reconnect at once after a network outage.
- **How to Simulate:**
  - Drop all simulator connections, then reconnect quickly.
  - Minimal jitter in reconnect timing.
- **Metrics:**
  - Connection success rate
  - Broker file descriptor usage
  - CONNACK latency

---

### **2.3 NAT/Keepalive Timeouts**
- **Problem:** Idle MQTT sessions dropped by aggressive NAT devices.
- **How to Simulate:**
  - Increase keepalive interval.
  - Pause publishing for some clients.
- **Metrics:**
  - Idle disconnect frequency
  - Reconnect events over time

---

## 3. Payload & Topic Behavior

### **3.1 Payload Size Growth**
- **Problem:** Payloads grow from 200B to several KB due to extra telemetry fields.
- **How to Simulate:**
  - Simulator publishes small → medium → large payloads during a test run.
- **Metrics:**
  - Broker throughput
  - Backend deserialization time
  - WebSocket bandwidth

---

### **3.2 Publish Rate Drift & Bursts**
- **Problem:** Real devices don't publish on perfect intervals; event spikes happen.
- **How to Simulate:**
  - Add jitter to publish intervals.
  - Introduce sudden bursts (e.g., ignition ON events).
- **Metrics:**
  - Short-window message throughput spikes
  - Dropped WS frames
  - UI frame rate drops

---

### **3.3 Topic Explosion vs. Aggregation**
- **Problem:** Too many topics cause inefficiency; aggregated topics cause hot shards.
- **How to Simulate:**
  - Some vehicles publish to individual topics.
  - Others use regional aggregate topics.
- **Metrics:**
  - Per-topic throughput
  - Latency differences between patterns

---

## 4. Security & Persistence Scenarios

### **4.1 TLS Handshake Storm**
- **Problem:** TLS handshakes saturate broker CPU during mass reconnects.
- **How to Simulate:**
  - Enable TLS on broker.
  - Ramp up connection rate aggressively.
- **Metrics:**
  - TLS handshake time
  - Broker CPU load

---

### **4.2 ACL/Authentication Bottlenecks**
- **Problem:** Broker performs expensive checks on every message.
- **How to Simulate:**
  - Enable username/password or JWT authentication.
  - Mock auth latency by adding delay in backend or plugin.
- **Metrics:**
  - Publish ACK latency
  - Connection setup time

---

## 5. Gatling Scenario Templates

### **5.1 Ramp + Steady Load**
Simulates realistic growth:
- Ramp from 0 → 5,000 connections over 10 minutes.
- Hold steady for 30 minutes.

```javascript
export const rampScenario = mqttScenario()
  .connect({ count: 0 })
  .rampTo(5000).during(600)
  .holdFor(1800);
```
### **5.2 Spike Test**

Simulates a sudden surge of connections:

- **+2,000 clients in 30 seconds**

```javascript
export const spikeScenario = mqttScenario()
    .connect({ count: 2000, rate: "66/sec" })
    .holdFor(300);
```

---

### **5.3 Churn Simulation**

Simulates mass disconnects and reconnects:

```javascript
export const churnScenario = mqttScenario()
    .connect({ count: 1000 })
    .disconnectAfter(60)
    .reconnectAllAfter(10)
    .holdFor(600);
```

---

### **5.4 Impairment Simulation**

Mix of latency profiles:

- **Cohort A:** 50ms ±20ms
- **Cohort B:** 200ms ±80ms + 1% packet loss
- **Cohort C:** periodic 30s blackouts

```javascript
export const impairmentScenario = mqttScenario()
    .withCohorts([
        { name: "A", latency: "50ms ±20ms" },
        { name: "B", latency: "200ms ±80ms", loss: "1%" },
        { name: "C", blackoutInterval: "30s" }
    ]);
```

---

### **5.5 Payload Escalation**

Step payload size from 200B → 2KB → 8KB.

```javascript
export const payloadScenario = mqttScenario()
    .stepPayloadSizes([200, 2000, 8000])
    .holdFor(900);
```
