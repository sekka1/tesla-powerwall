import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  TESLA_CLIENT_ID: string;
  TESLA_CLIENT_SECRET: string;
  TESLA_REDIRECT_URI: string;
  TESLA_SCOPE?: string;
  TESLA_PUBLIC_KEY?: string;
  TESLA_AUTH_BASE_URL?: string;
  TESLA_API_BASE_URL?: string;
}

const DEFAULT_SCOPE = 'openid email offline_access energy_device_data energy_cmds';
const DEFAULT_AUTH_BASE_URL = 'https://auth.tesla.com';
const DEFAULT_API_BASE_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com';

interface TeslaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface TeslaEnergySite {
  energy_site_id?: number | string;
  id?: number | string;
}

interface TeslaEnergySitesResponse {
  response?: TeslaEnergySite[];
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => {
  return c.json({
    name: 'tesla-powerwall',
    description: 'Tesla OAuth & Public Key Worker for Tesla Powerwall integration',
    status: 'ok',
  });
});

app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (c) => {
  const publicKey = c.env.TESLA_PUBLIC_KEY;
  if (!publicKey) {
    return c.text('Public key not configured', 404);
  }
  return c.text(publicKey, 200, { 'Content-Type': 'text/plain' });
});

app.get('/auth/login', async (c) => {
  const clientId = c.env.TESLA_CLIENT_ID;
  const redirectUri = c.env.TESLA_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return c.text('OAuth is not configured', 500);
  }

  const state = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?1)').bind(state).run();

  const authBaseUrl = c.env.TESLA_AUTH_BASE_URL || DEFAULT_AUTH_BASE_URL;
  const authorizeUrl = new URL('/oauth2/v3/authorize', authBaseUrl);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', c.env.TESLA_SCOPE || DEFAULT_SCOPE);
  authorizeUrl.searchParams.set('state', state);

  return c.redirect(authorizeUrl.toString(), 302);
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    return c.text('Missing code or state parameter', 400);
  }

  const stateRow = await c.env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?1')
    .bind(state)
    .first();

  if (!stateRow) {
    return c.text('Invalid or expired state parameter', 400);
  }

  await c.env.DB.prepare('DELETE FROM oauth_states WHERE state = ?1').bind(state).run();

  const authBaseUrl = c.env.TESLA_AUTH_BASE_URL || DEFAULT_AUTH_BASE_URL;
  const tokenResponse = await fetch(new URL('/oauth2/v3/token', authBaseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: c.env.TESLA_CLIENT_ID,
      client_secret: c.env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: c.env.TESLA_REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    return c.text('Failed to exchange authorization code for tokens', 502);
  }

  const tokens = (await tokenResponse.json()) as TeslaTokenResponse;

  const apiBaseUrl = c.env.TESLA_API_BASE_URL || DEFAULT_API_BASE_URL;
  const authorizationHeader = ['Bearer', tokens.access_token].join(' ');
  const sitesResponse = await fetch(new URL('/api/1/energy_sites', apiBaseUrl).toString(), {
    headers: { Authorization: authorizationHeader },
  });

  let energySiteId: string | null = null;
  if (sitesResponse.ok) {
    const sitesData = (await sitesResponse.json()) as TeslaEnergySitesResponse;
    const firstSite = sitesData.response?.[0];
    const rawId = firstSite?.energy_site_id ?? firstSite?.id;
    energySiteId = rawId !== undefined && rawId !== null ? String(rawId) : null;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
  const userId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO tesla_users (id, tesla_site_id, access_token, refresh_token, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(userId, energySiteId, tokens.access_token, tokens.refresh_token, expiresAt)
    .run();

  return c.html(
    '<!doctype html><html><head><title>Tesla Powerwall Connected</title></head>' +
      '<body><h1>Success</h1><p>Your Tesla Powerwall account has been connected.</p></body></html>'
  );
});

export default app;
