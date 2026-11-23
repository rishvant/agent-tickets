// Minimal client-side session for the static demo.
// There is no backend: nothing is transmitted anywhere. Swapping this file for
// a real auth call is the only change needed when a server exists.

const SESSION_KEY = "agent-tickets.session";

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || typeof session.email !== "string") return null;
    return session;
  } catch {
    return null;
  }
}

export function signIn(email) {
  const session = { email, signedInAt: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
}
