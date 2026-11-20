const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const TOKEN_KEY = 'threadline.token';
const SESSIONLESS_PATHS = ['/api/auth/login', '/api/auth/register'];
// Recipients open shared handovers without an account, so a rejection there
// must never bounce them to the profile picker.
const PUBLIC_PATHS = ['/api/handovers/shared', '/api/demo'];

let unauthorizedHandler = null;
// Mirror of the stored token. Safari private mode and blocked third-party
// storage make localStorage throw, and a token that only lived there would
// leave the session looking signed in while every request went out anonymous.
let memoryToken = null;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export function getToken() {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch {
    /* storage can be unavailable in private mode */
  }
  return memoryToken;
}

export function setToken(token) {
  memoryToken = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* the in-memory copy above still keeps this tab's session alive */
  }
}

async function request(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  // A failed sign-in must not carry the previous persona's token: otherwise the
  // 401 handler below would sign the current user out mid-switch.
  const sessionless = SESSIONLESS_PATHS.some((prefix) => path.startsWith(prefix));
  const isPublic = PUBLIC_PATHS.some((prefix) => path.startsWith(prefix));
  const token = sessionless ? null : getToken();
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(
      'Cannot reach the Threadline API. Check that the backend is running and VITE_API_URL points to it.',
      { code: 'network_error' },
    );
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const detail = data?.error || {};
    // Sign out on any rejected authenticated call, even when no token was sent:
    // otherwise a stale page keeps rendering the API's raw "Bearer <token>"
    // message instead of returning the visitor to the profile picker.
    if (response.status === 401 && !sessionless && !isPublic && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(detail.message || `Request failed with status ${response.status}`, {
      status: response.status,
      code: detail.code || 'request_failed',
      details: detail.details || null,
    });
  }

  return data;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

/**
 * Fetches a file with the same Authorization header as every other call, then
 * hands it to the browser as a download. A plain anchor cannot send the token
 * when the API lives on another origin (for example Vercel calling Render).
 */
export async function downloadFile(path, fallbackName = 'download') {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers });
  } catch {
    throw new ApiError('Cannot reach the Threadline API to download this file.', {
      code: 'network_error',
    });
  }

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const detail = data?.error || {};
    if (response.status === 401 && !path.startsWith('/api/handovers/shared') && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(detail.message || `Download failed with status ${response.status}`, {
      status: response.status,
      code: detail.code || 'request_failed',
    });
  }

  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = match?.[1] || fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function uploadSource(projectId, { files, name, sensitivity, visibility }) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  if (name) form.append('name', name);
  form.append('sensitivity', sensitivity || 'internal');
  if (visibility) form.append('visibility', JSON.stringify(visibility));
  return request(`/api/projects/${projectId}/sources/upload`, { method: 'POST', body: form });
}

export function errorMessage(error) {
  if (error instanceof ApiError) {
    // A rejected form should say which field failed rather than only
    // "The request contains invalid fields".
    if (error.code === 'validation_error' && Array.isArray(error.details) && error.details.length > 0) {
      const messages = error.details
        .map((issue) => issue?.message)
        .filter((message) => typeof message === 'string' && message.length > 0);
      if (messages.length > 0) return messages.join(' · ');
    }
    if (error.code === 'unprocessable' && error.details?.pendingClaimIds?.length) {
      return `${error.message} (${error.details.pendingClaimIds.length} remaining)`;
    }
    return error.message;
  }
  return error?.message || 'Something went wrong';
}

export function errorCode(error) {
  return error instanceof ApiError ? error.code : 'unknown';
}
