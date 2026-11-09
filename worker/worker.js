/**
 * sf streets — Strava OAuth proxy (Cloudflare Worker).
 *
 * Holds the shared Strava app's client secret so users never create their own API app.
 * Stateless: exchanges/refreshes tokens and hands them straight back to the browser,
 * which stores them locally. Nothing is persisted here.
 *
 * Endpoints (all JSON, CORS-restricted to ALLOWED_ORIGINS):
 *   GET  /config    -> { client_id }
 *   POST /exchange  { code }          -> { access_token, refresh_token, expires_at, athlete }
 *   POST /refresh   { refresh_token } -> { access_token, refresh_token, expires_at }
 *
 * Secrets:  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET   (wrangler secret put ... / dashboard)
 * Vars:     ALLOWED_ORIGINS  comma-separated, e.g. "https://strange-habits.com,http://localhost:8415"
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (!cors) return json({ error: 'origin not allowed' }, 403);

    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/config' && request.method === 'GET') {
        return json({ client_id: env.STRAVA_CLIENT_ID }, 200, cors);
      }
      if (pathname === '/exchange' && request.method === 'POST') {
        const { code } = await request.json();
        if (!code) return json({ error: 'code required' }, 400, cors);
        return stravaToken({ code, grant_type: 'authorization_code' }, env, cors);
      }
      if (pathname === '/refresh' && request.method === 'POST') {
        const { refresh_token } = await request.json();
        if (!refresh_token) return json({ error: 'refresh_token required' }, 400, cors);
        return stravaToken({ refresh_token, grant_type: 'refresh_token' }, env, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500, cors);
    }
  }
};

async function stravaToken(params, env, cors) {
  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    ...params
  });
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) {
    return json({ error: data.message || 'strava rejected the request', details: data.errors }, res.status, cors);
  }
  const athlete = data.athlete
    ? { id: data.athlete.id, firstname: data.athlete.firstname, lastname: data.athlete.lastname, profile: data.athlete.profile_medium }
    : undefined;
  return json(
    { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at, athlete },
    200,
    cors
  );
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
