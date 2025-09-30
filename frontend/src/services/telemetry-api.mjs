function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function fetchTelemetrySummary({
  baseUrl,
  windowSeconds,
  durationSeconds,
  vehicleIds,
  aggregates,
  fetchImpl = (...args) => fetch(...args),
  signal
} = {}) {
  if (!baseUrl) {
    throw new Error('fetchTelemetrySummary requires baseUrl');
  }

  const url = buildUrl(baseUrl, '/telemetry/summary', {
    windowSeconds,
    durationSeconds,
    vehicleId: vehicleIds,
    aggregate: aggregates
  });

  const response = await fetchImpl(url, { signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Telemetry summary request failed with ${response.status}`);
  }
  return response.json();
}

export async function fetchTelemetryHistory({
  baseUrl,
  durationSeconds,
  limit,
  vehicleIds,
  fetchImpl = (...args) => fetch(...args),
  signal
} = {}) {
  if (!baseUrl) {
    throw new Error('fetchTelemetryHistory requires baseUrl');
  }

  const url = buildUrl(baseUrl, '/telemetry/history', {
    durationSeconds,
    limit,
    vehicleId: vehicleIds
  });

  const response = await fetchImpl(url, { signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Telemetry history request failed with ${response.status}`);
  }
  return response.json();
}
