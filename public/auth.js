// Session helpers. The token is validated by the server before the session exists;
// nothing here decides whether a token is good, it only remembers one that worked.
//
// Known P0 limitation: the agent token lives in localStorage, so any script that
// manages to run on this origin could read it. Acceptable for a localhost dev tool,
// replace with an httpOnly cookie before this is exposed beyond localhost.

const SESSION_KEY = 'agent-tickets.session';

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || typeof session.token !== 'string' || session.token.length === 0) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Calls the API with the stored token (if any). */
export async function apiFetch(path, options = {}) {
  const session = getSession();
  const headers = { ...(options.headers ?? {}) };
  if (session && session.token) headers.authorization = `Bearer ${session.token}`;

  let payload;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const response = await fetch(path, { method: options.method ?? 'GET', headers, body: payload });
  return { ok: response.ok, status: response.status, payload: await parseJson(response) };
}

/** Validates a candidate token without storing it. */
export async function checkToken(token) {
  const response = await fetch('/api/me', { headers: { authorization: `Bearer ${token}` } });
  return { ok: response.ok, status: response.status, payload: await parseJson(response) };
}

export function errorMessage(payload, fallback) {
  const code = payload && payload.error ? payload.error.code : null;
  const message = payload && payload.error ? payload.error.message : null;
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  return fallback;
}
