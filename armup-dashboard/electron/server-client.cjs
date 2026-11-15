/*
 * server-client.cjs -- how the desktop app talks to the ArmUp server
 * ------------------------------------------------------------------
 * The React page still calls window.armup.request(method, path, body, token)
 * exactly as before. main.cjs hands that call to forward(), which sends it
 * over HTTPS to the server (Render) and returns { status, body }. Doing it
 * here in the main process (not in the page) means no browser cross-site
 * rules are involved and the page never needs to know the address.
 *
 * The server address is chosen in this order:
 *   1. ARMUP_SERVER_URL environment variable (development)
 *   2. the address saved from inside the app (server.json in the data folder)
 *   3. the default shipped in electron/server-config.json
 *
 * Only https:// addresses are accepted (plain http:// only for this same
 * computer, so a local test server still works). Passwords and login tokens
 * never travel over an unencrypted connection to another machine.
 */
const fs = require('node:fs');
const path = require('node:path');

// Render's free service can take about a minute to wake up from sleep.
const DEFAULT_TIMEOUT_MS = 75_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// A path the page may ask for: starts with one "/", plain URL characters only.
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

// Turns what someone typed into a clean server address, or { error }.
function normalizeUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) return { url: '' }; // empty = "use the default"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: 'That does not look like a web address.' };
  }
  if (parsed.username || parsed.password) return { error: 'The address must not contain a user name or password.' };
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    return { error: 'The address must start with https:// so your login stays private.' };
  }
  return { url: parsed.origin };
}

function createServerClient({
  userDataDir,
  defaultConfigPath,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const savedPath = userDataDir ? path.join(userDataDir, 'server.json') : null;

  const readJson = (file) => {
    try {
      return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch {
      return null;
    }
  };

  // The address that will be used right now ('' when none is set).
  function getUrl() {
    for (const candidate of [env.ARMUP_SERVER_URL, readJson(savedPath)?.serverUrl, readJson(defaultConfigPath)?.serverUrl]) {
      const n = normalizeUrl(candidate);
      if (!n.error && n.url) return n.url;
    }
    return '';
  }

  // Saves an address typed in the app. '' goes back to the default.
  function setUrl(input) {
    const n = normalizeUrl(input);
    if (n.error) return n;
    if (!savedPath) return { error: 'Cannot save the address here.' };
    fs.mkdirSync(path.dirname(savedPath), { recursive: true });
    fs.writeFileSync(savedPath, JSON.stringify({ serverUrl: n.url }), 'utf8');
    return { url: getUrl() };
  }

  const unavailable = (detail) => ({ status: 503, body: { detail } });

  async function forward(method, apiPath, body, token) {
    const base = getUrl();
    if (!base) {
      return unavailable('No server address is set yet. Open the connection box in the corner and enter it.');
    }
    const verb = String(method).toUpperCase();
    const target = String(apiPath);
    if (!METHODS.has(verb) || !SAFE_PATH.test(target)) {
      return { status: 400, body: { detail: 'Bad request.' } };
    }
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetchImpl(base + target, {
        method: verb,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // an API call should never be bounced somewhere else
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // Not our JSON -- usually the hosting service's own "starting up" page.
          return unavailable('The server is waking up. Please wait a minute and try again.');
        }
      }
      return { status: res.status, body: data };
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        return unavailable('The server took too long to answer. It may be waking up, so wait a minute and try again.');
      }
      return unavailable("Can't reach the ArmUp server. Check your internet connection and the server address.");
    }
  }

  // Asks the server "are you there?" (this also wakes a sleeping one).
  async function ping() {
    const url = getUrl();
    if (!url) return { ok: false, url, reason: 'no-address' };
    const started = Date.now();
    const r = await forward('GET', '/');
    return r.status === 200 && r.body?.service === 'armup'
      ? { ok: true, url, ms: Date.now() - started }
      : { ok: false, url, reason: 'unreachable', detail: r.body?.detail || `Unexpected answer (${r.status}).` };
  }

  return { getUrl, setUrl, forward, ping };
}

module.exports = { createServerClient, normalizeUrl, DEFAULT_TIMEOUT_MS };
