# Strava one-tap connect (Cloudflare Worker)

Lets anyone connect with **Connect Strava → Authorize** instead of creating their own Strava API app.
The Worker holds the shared app's client secret and does the OAuth code/refresh exchange; tokens are
returned to the browser and stored only on the user's device. Free tier is plenty (100k requests/day).

## Deploy (≈3 minutes, one time)

Option A — terminal:

```bash
cd worker
npx wrangler login                          # opens browser, free Cloudflare account is fine
npx wrangler secret put STRAVA_CLIENT_ID    # from strava.com/settings/api
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler deploy                         # prints https://sf-streets-strava.<you>.workers.dev
```

Option B — Cloudflare dashboard, no installs: **Workers & Pages → Create → Hello World → Edit code**,
paste `worker.js`, **Deploy**. Then **Settings → Variables**: add `ALLOWED_ORIGINS` (plain text, value from
`wrangler.toml`) and `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` (encrypted).

Finally paste the Worker URL into `STRAVA_PROXY_URL` at the top of `app.js`.

## Strava app settings

- Authorization Callback Domain: `strange-habits.com` (localhost is always allowed for dev).
- New Strava apps may only be authorized by **one athlete** (you). To let friends connect, request an
  athlete-limit increase from the Strava API settings page; it's free and usually approved within days.
- Rate limits are per app (200 requests / 15 min, 2,000 / day) and shared by everyone connected.
