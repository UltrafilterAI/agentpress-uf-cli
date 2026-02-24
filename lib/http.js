const axios = require('axios');

const HUB_URL = process.env.AGENTPRESS_HUB_URL || 'http://localhost:8787';
const REQUEST_TIMEOUT_MS = Number(process.env.AGENTPRESS_HTTP_TIMEOUT_MS || 15000);

const client = axios.create({
  baseURL: HUB_URL,
  timeout: Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0 ? REQUEST_TIMEOUT_MS : 15000,
  headers: {
    'Content-Type': 'application/json'
  }
});

function extractRequestId(headers = {}) {
  if (!headers || typeof headers !== 'object') return '';
  return String(headers['x-request-id'] || headers['X-Request-Id'] || '').trim();
}

function appendRequestId(message, headers = {}) {
  const requestId = extractRequestId(headers);
  if (!requestId) return message;
  return `${message} [request_id=${requestId}]`;
}

function formatApiError(label, response, fallback = 'unknown error') {
  const status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const headers = response && response.headers && typeof response.headers === 'object' ? response.headers : {};
  const errorText = data.error || fallback;
  const retryAfter = String(headers['retry-after'] || '').trim();
  const base = `${label} (${status}): ${errorText}`;
  const withRequestId = appendRequestId(base, headers);
  return retryAfter ? `${withRequestId} [retry_after=${retryAfter}s]` : withRequestId;
}

function toResponse(error) {
  if (error && error.response) {
    return {
      status: error.response.status,
      data: error.response.data || {},
      headers: error.response.headers || {},
      request_id: extractRequestId(error.response.headers || {})
    };
  }

  const wrapped = new Error(`Network request failed: ${error.message}`);
  wrapped.cause = error;
  throw wrapped;
}

async function requestJson(route, { method = 'GET', body, token } = {}) {
  try {
    const response = await client.request({
      url: route,
      method,
      data: body,
      responseType: 'json',
      validateStatus: () => true,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });

    return {
      status: response.status,
      data: response.data || {},
      headers: response.headers || {},
      request_id: extractRequestId(response.headers || {})
    };
  } catch (error) {
    return toResponse(error);
  }
}

async function requestRaw(route, { method = 'GET', body, token, headers = {} } = {}) {
  try {
    const response = await client.request({
      url: route,
      method,
      data: body,
      responseType: 'text',
      validateStatus: () => true,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });

    return {
      status: response.status,
      data: typeof response.data === 'string' ? response.data : '',
      headers: response.headers || {},
      request_id: extractRequestId(response.headers || {})
    };
  } catch (error) {
    return toResponse(error);
  }
}

module.exports = {
  requestJson,
  requestRaw,
  HUB_URL,
  extractRequestId,
  appendRequestId,
  formatApiError
};
