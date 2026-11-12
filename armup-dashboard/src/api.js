/*
 * api.js
 * ------
 * apiFetch() looks like fetch(), but instead of calling a web server it
 * asks the Electron main process (window.armup, set up in electron/preload.cjs).
 * It returns a real Response object, so the pages keep using
 * res.ok / res.json() exactly as before.
 *
 * Login: after /login or /users the page keeps the returned token with
 * setAuthToken(). apiFetch then attaches it to every call, and the main
 * process checks it. If the main process says the token is no longer valid
 * (expired, account removed), the handler set with setUnauthorizedHandler()
 * runs so the app can send the user back to the login screen.
 */
let authToken = null;
let onUnauthorized = null;

export function setAuthToken(token) {
  authToken = token || null;
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function apiFetch(path, options = {}) {
  if (!window.armup) {
    throw new Error('ArmUp backend not available. Run the app with: npm run electron:dev');
  }
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : undefined;
  const sentToken = authToken;
  const { status, body: data } = await window.armup.request(method, path, body, sentToken);

  // A 401 on a call that carried a token means that token stopped working.
  // (A 401 on /login with no token is just a wrong password -- left alone.)
  if (status === 401 && sentToken && sentToken === authToken && onUnauthorized) {
    onUnauthorized();
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
