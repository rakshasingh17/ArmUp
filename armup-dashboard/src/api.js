/*
 * api.js
 * ------
 * apiFetch() looks like fetch(), but instead of calling a web server it
 * asks the Electron main process (window.armup, set up in electron/preload.cjs).
 * It returns a real Response object, so the pages keep using
 * res.ok / res.json() exactly as before.
 */
export async function apiFetch(path, options = {}) {
  if (!window.armup) {
    throw new Error('ArmUp backend not available. Run the app with: npm run electron:dev');
  }
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : undefined;
  const { status, body: data } = await window.armup.request(method, path, body);
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
