import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import markerRetinaAsset from 'leaflet/dist/images/marker-icon-2x.png';
import markerAsset from 'leaflet/dist/images/marker-icon.png';
import markerShadowAsset from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';
import {
  escapeHtml,
  formatEngineStatus,
  formatFuelLevel,
  formatSpeed,
  normaliseFiniteNumber,
  normaliseStatus
} from './lib/formatting.mjs';

const resolveBundledAsset = asset => {
  if (!asset) {
    return asset;
  }
  if (/^(?:https?:|data:|blob:)/i.test(asset) || asset.startsWith('/')) {
    return asset;
  }
  try {
    return new URL(asset, import.meta.url).toString();
  } catch (_err) {
    return asset;
  }
};

const markerRetinaUrl = resolveBundledAsset(markerRetinaAsset);
const markerUrl = resolveBundledAsset(markerAsset);
const markerShadowUrl = resolveBundledAsset(markerShadowAsset);

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerRetinaUrl,
  iconUrl: markerUrl,
  shadowUrl: markerShadowUrl
});

const config = window.APP_CONFIG || {};
const HTTP_BASE = trimTrailingSlash(config.httpBase || 'http://localhost:8080');
const WS_URL = config.wsUrl || `${HTTP_BASE.replace(/^http/i, 'ws')}/stream`;
const STATS_REFRESH_MS = config.statsRefreshMs ?? 5000;
const RENDER_THROTTLE_MS = config.renderThrottleMs ?? 250;
const TRAIL_LENGTH = config.trailLength ?? 20;
const CLUSTER_THRESHOLD = config.clusterThreshold ?? 200;
const MAX_LATENCY_SAMPLES = config.maxLatencySamples ?? 200;
const RENDER_BATCH_SIZE = Math.max(1, config.renderBatchSize ?? 200);
const TILE_URL = config.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const WS_MESSAGE_TYPE = 'vehicle_update';
const WS_PAYLOAD_VERSION = 1;
const DEBUG_RENDER = Boolean(config.debugRenderTimings);

const now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const requestFrame = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame.bind(window)
  : (cb => setTimeout(() => cb(now()), 16));

const cancelFrame = typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
  ? window.cancelAnimationFrame.bind(window)
  : clearTimeout;

const elements = {
  connection: document.getElementById('connection-status'),
  active: document.getElementById('metric-active'),
  rate: document.getElementById('metric-rate'),
  latency: document.getElementById('metric-latency'),
  statsUpdated: document.getElementById('stats-updated'),
  reconnectBtn: document.getElementById('reconnect-btn'),
  toastContainer: document.getElementById('toast-container'),
  filterFuel: document.getElementById('filter-fuel'),
  filterFuelValue: document.getElementById('filter-fuel-value'),
  filterStatusButtons: Array.from(document.querySelectorAll('.js-status-filter-btn'))
};

const STATUS_OPTIONS = ['running', 'idle', 'off'];

const STATUS_STYLES = {
  running: { accent: '#38bdf8', label: 'Running' },
  idle: { accent: '#facc15', label: 'Idle' },
  off: { accent: '#94a3b8', label: 'Off' },
  unknown: { accent: '#64748b', label: 'Unknown' }
};

const FUEL_BANDS = {
  high: { min: 60, color: '#22c55e', label: '60%+' },
  medium: { min: 30, color: '#f97316', label: '30-59%' },
  low: { min: 0, color: '#ef4444', label: '<30%' },
  unknown: { min: -Infinity, color: '#94a3b8', label: 'Unknown' }
};

const ICON_SIZE = [42, 42];

function getFuelBandKey(value) {
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  if (value >= FUEL_BANDS.high.min) {
    return 'high';
  }
  if (value >= FUEL_BANDS.medium.min) {
    return 'medium';
  }
  if (value >= FUEL_BANDS.low.min) {
    return 'low';
  }
  return 'unknown';
}

function getStatusKey(value) {
  const normalised = normaliseStatus(value);
  if (normalised && STATUS_STYLES[normalised]) {
    return normalised;
  }
  return 'unknown';
}

function createTruckIcon(fuelBandKey, statusKey) {
  const band = FUEL_BANDS[fuelBandKey] || FUEL_BANDS.unknown;
  const status = STATUS_STYLES[statusKey] || STATUS_STYLES.unknown;
  const html = `
    <div class="vehicle-marker__wrapper" style="--fuel-color:${band.color}; --status-color:${status.accent};">
      <svg class="vehicle-marker__svg" viewBox="0 0 64 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M6 14c0-3.314 2.686-6 6-6h22c3.314 0 6 2.686 6 6v16H6V14z" fill="var(--fuel-color)" opacity="0.88" />
        <path d="M34 14h16c2.21 0 4 1.79 4 4v12H34V14z" fill="var(--fuel-color)" />
        <path d="M48 14h6c1.657 0 3 1.343 3 3v9h-9V14z" fill="var(--fuel-color)" opacity="0.85" />
        <path d="M6 30h51l3 4H6v-4z" fill="rgba(15, 23, 42, 0.15)" />
        <circle cx="18" cy="36" r="6" fill="#0f172a" stroke="#ffffff" stroke-width="2.5" />
        <circle cx="44" cy="36" r="6" fill="#0f172a" stroke="#ffffff" stroke-width="2.5" />
        <circle cx="49" cy="18" r="4" fill="var(--status-color)" stroke="#0f172a" stroke-width="2" />
        <rect x="12" y="22" width="22" height="3" rx="1.5" fill="rgba(15, 23, 42, 0.35)" />
      </svg>
    </div>
  `;
  return L.divIcon({
    className: 'vehicle-marker leaflet-div-icon',
    html: html.trim(),
    iconSize: ICON_SIZE,
    iconAnchor: [ICON_SIZE[0] / 2, ICON_SIZE[1] - 10],
    popupAnchor: [0, -ICON_SIZE[1] + 10],
    tooltipAnchor: [0, -ICON_SIZE[1] + 8]
  });
}

const map = L.map('map', { preferCanvas: true });
map.setView([48.8566, 2.3522], 5);

L.tileLayer(TILE_URL, {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

const clusterGroup = L.markerClusterGroup({
  chunkedLoading: true,
  chunkInterval: 200,
  disableClusteringAtZoom: 16,
  maxClusterRadius: 0
});

const trailLayer = L.layerGroup();

map.addLayer(clusterGroup);
map.addLayer(trailLayer);

const vehicles = new Map();
const latencySamples = [];
const updateQueue = [];
let rafHandle = null;
let lastFlushTimestamp = 0;
const MAX_TRAIL_LENGTH = Math.max(1, TRAIL_LENGTH);
let ws;
let reconnectAttempts = 0;
let reconnectTimer = null;
let skipNextReconnect = false;
let statsTimer = null;
let statsFailureNotified = false;
let initialViewportSettled = false;

const filterState = {
  minFuel: 0,
  statuses: new Set(STATUS_OPTIONS)
};

connectWebSocket();
startStatsPolling();
registerUiHandlers();

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  setConnectionStatus('connecting');

  let url;
  try {
    url = new URL(WS_URL, window.location.href);
  } catch (err) {
    console.error('[frontend] invalid WebSocket URL', err);
    showToast('Invalid WebSocket URL, check configuration.', 'error');
    return;
  }

  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setConnectionStatus('connected');
    reconnectAttempts = 0;
    skipNextReconnect = false;
  });

  ws.addEventListener('message', event => {
    try {
      const payload = JSON.parse(event.data);
      if (!isValidPayload(payload)) {
        return;
      }
      enqueueUpdate({
        data: payload,
        receivedAt: Date.now()
      });
    } catch (err) {
      console.error('[frontend] failed to parse update', err);
    }
  });

  ws.addEventListener('close', () => {
    setConnectionStatus('disconnected');
    ws = null;
    if (skipNextReconnect) {
      skipNextReconnect = false;
      connectWebSocket();
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', err => {
    console.error('[frontend] WebSocket error', err);
    showToast('WebSocket error occurred. Attempting to reconnect…', 'error');
    try {
      ws.close();
    } catch (closeErr) {
      console.error('[frontend] failed to close socket after error', closeErr);
    }
  });
}

function scheduleReconnect() {
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

function enqueueUpdate(entry) {
  updateQueue.push(entry);
  scheduleFlush();
}

function scheduleFlush() {
  if (updateQueue.length === 0 || rafHandle !== null) {
    return;
  }
  rafHandle = requestFrame(flushUpdates);
}

function flushUpdates(frameTime = now()) {
  rafHandle = null;
  if (frameTime - lastFlushTimestamp < RENDER_THROTTLE_MS) {
    scheduleFlush();
    return;
  }
  lastFlushTimestamp = frameTime;

  const batch = takeNextBatch(RENDER_BATCH_SIZE);
  if (batch.length === 0) {
    if (updateQueue.length > 0) {
      scheduleFlush();
    }
    return;
  }

  const aggregated = new Map();
  for (const entry of batch) {
    const vehicleId = entry?.data?.vehicleId;
    if (typeof vehicleId !== 'string') {
      continue;
    }
    let bucket = aggregated.get(vehicleId);
    if (!bucket) {
      bucket = [];
      aggregated.set(vehicleId, bucket);
    }
    bucket.push(entry);
  }

  let processedVehicles = 0;
  const frameStart = DEBUG_RENDER ? now() : 0;

  for (const updates of aggregated.values()) {
    if (applyAggregatedUpdates(updates)) {
      processedVehicles += 1;
    }
  }

  if (processedVehicles > 0) {
    updateClusterMode();
    clusterGroup.refreshClusters();
    updateMetrics();
    if (DEBUG_RENDER) {
      const frameDuration = now() - frameStart;
      console.debug(
        `[frontend] processed ${processedVehicles} vehicles in ${frameDuration.toFixed(2)}ms (batch size: ${batch.length})`
      );
    }
  }

  if (updateQueue.length > 0) {
    scheduleFlush();
  }
}

function takeNextBatch(limit) {
  if (limit <= 0 || updateQueue.length === 0) {
    return [];
  }
  const count = Math.min(limit, updateQueue.length);
  return updateQueue.splice(0, count);
}

function applyAggregatedUpdates(entries) {
  const normalisedUpdates = [];

  for (const entry of entries) {
    const normalised = normaliseUpdate(entry);
    if (normalised) {
      normalisedUpdates.push(normalised);
    }
  }

  if (normalisedUpdates.length === 0) {
    return false;
  }

  const latest = normalisedUpdates[normalisedUpdates.length - 1];
  let record = vehicles.get(latest.vehicleId);
  if (!record) {
    record = createVehicle(latest.vehicleId);
  }

  for (const update of normalisedUpdates) {
    record.trail.push(update.position);
    if (record.trail.length > MAX_TRAIL_LENGTH) {
      record.trail.splice(0, record.trail.length - MAX_TRAIL_LENGTH);
    }
    if (update.timestamp) {
      record.lastTimestamp = update.timestamp;
    }
    if (update.speed !== null) {
      record.lastSpeed = update.speed;
    }
    if (update.fuelLevel !== null) {
      record.lastFuelLevel = update.fuelLevel;
    }
    if (update.engineStatus !== null) {
      record.lastEngineStatus = update.engineStatus;
    }
    if (update.latencyMs !== null) {
      addLatencySample(update.latencyMs);
    }
  }

  record.marker.setLatLng(latest.position);
  record.polyline.setLatLngs(record.trail);
  updateMarkerAppearance(record);
  record.marker.setPopupContent(renderPopup({
    vehicleId: latest.vehicleId,
    speed: record.lastSpeed,
    timestamp: record.lastTimestamp,
    fuelLevel: record.lastFuelLevel,
    engineStatus: record.lastEngineStatus
  }));
  record.marker.setTooltipContent(renderTooltip({
    vehicleId: latest.vehicleId,
    speed: record.lastSpeed,
    fuelLevel: record.lastFuelLevel,
    engineStatus: record.lastEngineStatus
  }));

  updateEntryVisibility(record);
  return true;
}

function normaliseUpdate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const { data, receivedAt } = entry;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const { vehicleId, position, telemetry = {}, filters = {} } = data;
  if (typeof vehicleId !== 'string') {
    return null;
  }

  const latNum = Number(position?.lat);
  const lngNum = Number(position?.lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return null;
  }

  const timestampIso = telemetry.timestamp ?? null;
  const timestamp = timestampIso ? new Date(timestampIso) : null;
  const latencyMs = timestamp && !Number.isNaN(timestamp.valueOf())
    ? Math.max(0, receivedAt - timestamp.getTime())
    : null;

  return {
    vehicleId,
    position: [latNum, lngNum],
    timestamp,
    latencyMs,
    speed: normaliseFiniteNumber(telemetry.speed),
    fuelLevel: normaliseFiniteNumber(telemetry.fuelLevel ?? filters.fuelLevel),
    engineStatus: normaliseStatus(telemetry.engineStatus ?? filters.engineStatus)
  };
}

function createVehicle(vehicleId) {
  const marker = L.marker([0, 0], { title: vehicleId });
  const defaultIconKey = 'unknown:unknown';
  marker.setIcon(createTruckIcon('unknown', 'unknown'));
  marker.bindPopup('');
  marker.bindTooltip('', {
    direction: 'top',
    sticky: true,
    className: 'vehicle-tooltip'
  });

  const polyline = L.polyline([], {
    color: '#38bdf8',
    weight: 2,
    opacity: 0.7
  });

  const record = {
    marker,
    polyline,
    trail: [],
    lastTimestamp: null,
    lastSpeed: null,
    lastFuelLevel: null,
    lastEngineStatus: null,
    iconKey: defaultIconKey,
    visible: false
  };

  vehicles.set(vehicleId, record);
  return record;
}

function updateEntryVisibility(entry) {
  const shouldShow = matchesFilters(entry);

  if (shouldShow && !entry.visible) {
    clusterGroup.addLayer(entry.marker);
    trailLayer.addLayer(entry.polyline);
    entry.visible = true;
    applyInitialViewport(entry.marker.getLatLng());
  } else if (!shouldShow && entry.visible) {
    clusterGroup.removeLayer(entry.marker);
    trailLayer.removeLayer(entry.polyline);
    entry.marker.closePopup();
    entry.visible = false;
  }
}

function matchesFilters(entry) {
  const meetsFuel = entry.lastFuelLevel === null || entry.lastFuelLevel >= filterState.minFuel;
  const status = entry.lastEngineStatus;
  const meetsStatus = !status || filterState.statuses.has(status);
  return meetsFuel && meetsStatus;
}

function countVisibleVehicles() {
  let count = 0;
  for (const entry of vehicles.values()) {
    if (entry.visible) {
      count += 1;
    }
  }
  return count;
}

function getVisibleEntries() {
  return Array.from(vehicles.values()).filter(entry => entry.visible);
}

function applyFilters() {
  for (const entry of vehicles.values()) {
    updateEntryVisibility(entry);
  }
  updateClusterMode();
  clusterGroup.refreshClusters();
  updateMetrics();
  updateStatusFilterButtons();
}

function applyInitialViewport(position) {
  if (initialViewportSettled) {
    return;
  }

  const visibleEntries = getVisibleEntries();
  if (visibleEntries.length === 0) {
    return;
  }

  if (visibleEntries.length === 1 && position) {
    map.setView(position, 12);
    return;
  }

  if (visibleEntries.length >= 2) {
    const bounds = L.latLngBounds(visibleEntries.map(entry => entry.marker.getLatLng()));
    map.fitBounds(bounds.pad(0.25));
    initialViewportSettled = true;
  }
}

function updateClusterMode() {
  const visibleCount = countVisibleVehicles();
  const shouldCluster = visibleCount > CLUSTER_THRESHOLD;
  const desiredRadius = shouldCluster ? 80 : 0;
  if (clusterGroup.options.maxClusterRadius !== desiredRadius) {
    clusterGroup.options.maxClusterRadius = desiredRadius;
  }
}

function updateMarkerAppearance(record) {
  const fuelBandKey = getFuelBandKey(record.lastFuelLevel);
  const statusKey = getStatusKey(record.lastEngineStatus);
  const nextIconKey = `${fuelBandKey}:${statusKey}`;
  if (nextIconKey !== record.iconKey) {
    record.marker.setIcon(createTruckIcon(fuelBandKey, statusKey));
    record.iconKey = nextIconKey;
  }
}

function renderPopup({ vehicleId, speed, timestamp, fuelLevel, engineStatus }) {
  const safeId = escapeHtml(vehicleId);
  const speedText = formatSpeed(speed);
  const timeText = timestamp && !Number.isNaN(timestamp.valueOf())
    ? timestamp.toLocaleString()
    : 'Unknown time';
  const fuelText = formatFuelLevel(fuelLevel);
  const engineText = formatEngineStatus(engineStatus);
  return `
    <strong>${safeId}</strong><br>
    <span>Speed: ${speedText}</span><br>
    <span>Fuel: ${fuelText}</span><br>
    <span>Engine: ${engineText}</span><br>
    <span>Updated: ${escapeHtml(timeText)}</span>
  `;
}

function renderTooltip({ vehicleId, fuelLevel, engineStatus, speed }) {
  const safeId = escapeHtml(vehicleId);
  const fuelText = escapeHtml(String(formatFuelLevel(fuelLevel)));
  const engineText = escapeHtml(String(formatEngineStatus(engineStatus)));
  const speedText = escapeHtml(String(formatSpeed(speed)));
  return `
    <div class="vehicle-tooltip__content">
      <strong>${safeId}</strong>
      <div>Fuel: ${fuelText}</div>
      <div>Status: ${engineText}</div>
      <div>Speed: ${speedText}</div>
    </div>
  `.trim();
}

function updateMetrics() {
  const total = vehicles.size;
  const visible = countVisibleVehicles();
  elements.active.textContent = visible === total || total === 0
    ? `${visible}`
    : `${visible} / ${total}`;
  const averageLatency = getAverageLatency();
  elements.latency.textContent = averageLatency === null
    ? '—'
    : `${Math.round(averageLatency)} ms`;
}

function addLatencySample(value) {
  if (!Number.isFinite(value)) {
    return;
  }
  latencySamples.push(value);
  if (latencySamples.length > MAX_LATENCY_SAMPLES) {
    latencySamples.shift();
  }
}

function getAverageLatency() {
  if (latencySamples.length === 0) {
    return null;
  }
  const sum = latencySamples.reduce((acc, value) => acc + value, 0);
  return sum / latencySamples.length;
}

function startStatsPolling() {
  clearInterval(statsTimer);
  fetchAndUpdateStats();
  statsTimer = setInterval(fetchAndUpdateStats, STATS_REFRESH_MS);
}

async function fetchAndUpdateStats() {
  try {
    const response = await fetch(`${HTTP_BASE}/stats`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const stats = await response.json();
    if (typeof stats.messageRatePerSecond === 'number') {
      elements.rate.textContent = stats.messageRatePerSecond.toFixed(2);
    }
    elements.statsUpdated.textContent = new Date().toLocaleTimeString();
    statsFailureNotified = false;
  } catch (err) {
    console.error('[frontend] failed to fetch stats', err);
    if (!statsFailureNotified) {
      showToast('Unable to fetch /stats from backend.', 'warn');
      statsFailureNotified = true;
    }
  }
}

function setConnectionStatus(state) {
  const el = elements.connection;
  el.classList.remove('status--connected', 'status--disconnected', 'status--connecting');
  const labelMap = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting…'
  };
  el.classList.add(`status--${state}`);
  el.textContent = labelMap[state] || state;
}

function registerUiHandlers() {
  elements.reconnectBtn.addEventListener('click', () => {
    showToast('Reconnecting WebSocket…', 'info');
    skipNextReconnect = true;
    reconnectAttempts = 0;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, 'manual reconnect');
      } catch (err) {
        console.error('[frontend] failed to close socket on manual reconnect', err);
        connectWebSocket();
      }
    } else {
      connectWebSocket();
    }
  });

  if (elements.filterFuel) {
    const fuelValue = Number(elements.filterFuel.value);
    filterState.minFuel = Number.isFinite(fuelValue) ? fuelValue : filterState.minFuel;
    elements.filterFuel.addEventListener('input', event => {
      const nextValue = Number(event.target.value);
      filterState.minFuel = Number.isFinite(nextValue) ? nextValue : 0;
      updateFuelFilterLabel();
      applyFilters();
    });
  }

  updateFuelFilterLabel();
  updateStatusFilterButtons();

  if (elements.filterStatusButtons.length > 0) {
    elements.filterStatusButtons.forEach(button => {
      button.addEventListener('click', () => {
        handleStatusFilterButton(button);
      });
    });
  }
}

function showToast(message, variant = 'info') {
  const container = elements.toastContainer;
  if (!container) {
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast--hide');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}


function handleStatusFilterButton(button) {
  if (!button) {
    return;
  }
  const { status } = button.dataset;
  if (!status) {
    return;
  }

  if (status === 'all') {
    if (filterState.statuses.size !== STATUS_OPTIONS.length) {
      filterState.statuses = new Set(STATUS_OPTIONS);
      applyFilters();
    }
    return;
  }

  const statusKey = getStatusKey(status);
  if (statusKey === 'unknown') {
    return;
  }

  const isActive = filterState.statuses.has(statusKey);
  if (isActive && filterState.statuses.size === 1) {
    showToast('At least one engine status must remain selected.', 'warn');
    return;
  }

  if (isActive) {
    filterState.statuses.delete(statusKey);
  } else {
    filterState.statuses.add(statusKey);
  }

  applyFilters();
}

function updateStatusFilterButtons() {
  if (!elements.filterStatusButtons || elements.filterStatusButtons.length === 0) {
    return;
  }
  const allActive = filterState.statuses.size === STATUS_OPTIONS.length;
  elements.filterStatusButtons.forEach(button => {
    const { status } = button.dataset;
    if (status === 'all') {
      setStatusButtonState(button, allActive);
      return;
    }
    const statusKey = getStatusKey(status);
    const isActive = statusKey !== 'unknown' && filterState.statuses.has(statusKey);
    setStatusButtonState(button, isActive);
  });
}

function setStatusButtonState(button, isActive) {
  if (!button) {
    return;
  }
  button.classList.toggle('is-active', Boolean(isActive));
  button.setAttribute('aria-pressed', String(Boolean(isActive)));
}


function updateFuelFilterLabel() {
  if (elements.filterFuelValue) {
    elements.filterFuelValue.textContent = `${filterState.minFuel}%`;
  }
  if (elements.filterFuel) {
    elements.filterFuel.value = String(filterState.minFuel);
  }
}

function isValidPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.type !== WS_MESSAGE_TYPE || payload.version !== WS_PAYLOAD_VERSION) {
    return false;
  }
  if (typeof payload.vehicleId !== 'string') {
    return false;
  }
  if (!payload.position || !payload.telemetry) {
    return false;
  }
  return true;
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

window.addEventListener('beforeunload', () => {
  clearTimeout(reconnectTimer);
  clearInterval(statsTimer);
  if (rafHandle !== null) {
    cancelFrame(rafHandle);
    rafHandle = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
});
