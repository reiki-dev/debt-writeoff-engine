'use strict';

// ----------------------------------------------------------------------------
// Thin CRM API client.
//
// Two rules that shape the rest of the code:
//   1. HTTP 200 != success. The actual result is in the response envelope:
//        { status, error, message, data: { status: "success"|"failed", ... } }
//   2. By default, the key is sent in the x-api-key header (as specified),
//      but the API also accepts ?apiKey=; CRM_AUTH_MODE selects the method.
// ----------------------------------------------------------------------------

const { config } = require('./config');

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

function buildUrl(baseUrl, path, query, authMode, apiKey) {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (authMode === 'query') url.searchParams.set('apiKey', apiKey);
  return url;
}

// Return the parsed envelope; the calling code interprets it.
async function call(path, options = {}) {
  const {
    method = 'GET',
    query = {},
    body = null,
    cfg = config,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new ApiError('fetch is unavailable — Node 18+ is required or provide fetchImpl');
  }

  const url = buildUrl(cfg.BASE_URL, path, query, cfg.AUTH_MODE, cfg.API_KEY);

  const headers = { Accept: 'application/json' };
  if (cfg.AUTH_MODE === 'header') headers['x-api-key'] = cfg.API_KEY;

  const init = { method, headers };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.HTTP_TIMEOUT_MS);
  init.signal = ac.signal;

  let res;
  let text;
  try {
    res = await fetchImpl(url, init);
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(`timeout after ${cfg.HTTP_TIMEOUT_MS} ms: ${method} ${path}`, { path, method });
    }
    throw new ApiError(`network error: ${method} ${path}: ${err.message}`, { path, method, cause: err });
  } finally {
    clearTimeout(timer);
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new ApiError(
      `response is not JSON (HTTP ${res.status}) for ${method} ${path}: ${text.slice(0, 300)}`,
      { httpStatus: res.status, path, method, raw: text.slice(0, 2000) },
    );
  }

  if (envelope.status !== 200) {
    throw new ApiError(
      `API returned status=${envelope.status} for ${method} ${path}` +
      `${envelope.error ? ` (${envelope.error})` : ''}` +
      `${envelope.message ? `: ${envelope.message}` : ''}`,
      { apiStatus: envelope.status, apiError: envelope.error, apiMessage: envelope.message, path, method },
    );
  }

  return envelope;
}

module.exports = { call, buildUrl, ApiError };
