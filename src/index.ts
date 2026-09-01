import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  TESLA_CLIENT_ID: string;
  TESLA_CLIENT_SECRET: string;
  PRIVATE_KEY: string;
  TESLA_REDIRECT_URI: string;
  TESLA_SCOPE?: string;
  TESLA_PUBLIC_KEY?: string;
  TESLA_AUTH_BASE_URL?: string;
  TESLA_API_BASE_URL?: string;
  TESLA_PARTNER_AUTH_BASE_URL?: string;
  TESLA_DOMAIN?: string;
  ADMIN_API_TOKEN?: string;
}

const DEFAULT_SCOPE = 'openid email offline_access energy_device_data energy_cmds';
const DEFAULT_AUTH_BASE_URL = 'https://auth.tesla.com';
const DEFAULT_API_BASE_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const DEFAULT_PARTNER_AUTH_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com';

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

interface TeslaSiteInfo {
  site_name?: string;
}

interface TeslaSiteInfoResponse {
  response?: TeslaSiteInfo;
}

interface TeslaLiveStatus {
  solar_power?: number;
  battery_power?: number;
  grid_power?: number;
  percentage_charged?: number;
  grid_status?: string;
}

interface TeslaLiveStatusResponse {
  response?: TeslaLiveStatus;
}

interface TeslaPartnerTokenResponse {
  access_token: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

app.post('/admin/register-domain', async (c) => {
  const adminToken = c.env.ADMIN_API_TOKEN;
  if (!adminToken) {
    return c.text('Domain registration endpoint is not configured', 500);
  }

  const authHeader = c.req.header('Authorization');
  const expectedAuthHeader = ['Bearer', adminToken].join(' ');
  if (authHeader !== expectedAuthHeader) {
    return c.text(
      'Unauthorized: this endpoint requires a valid admin bearer credential in the ' +
        'Authorization header — there is no separate OAuth browser login step to complete first.',
      401,
    );
  }

  const clientId = c.env.TESLA_CLIENT_ID;
  const clientSecret = c.env.TESLA_CLIENT_SECRET;
  const domain = c.env.TESLA_DOMAIN;
  if (!clientId || !clientSecret || !domain) {
    return c.text('Domain registration is not configured', 500);
  }

  const apiBaseUrl = c.env.TESLA_API_BASE_URL || DEFAULT_API_BASE_URL;
  const partnerAuthBaseUrl = c.env.TESLA_PARTNER_AUTH_BASE_URL || DEFAULT_PARTNER_AUTH_BASE_URL;

  const partnerTokenResponse = await fetch(new URL('/oauth2/v3/token', partnerAuthBaseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'openid',
      audience: apiBaseUrl,
    }).toString(),
  });

  if (!partnerTokenResponse.ok) {
    return c.json({ error: 'Failed to obtain partner authentication token' }, 502);
  }

  const partnerToken = (await partnerTokenResponse.json()) as TeslaPartnerTokenResponse;

  const registerResponse = await fetch(new URL('/api/1/partner_accounts', apiBaseUrl).toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', partnerToken.access_token].join(' '),
    },
    body: JSON.stringify({ domain }),
  });

  const registerBody = await registerResponse.text();
  return new Response(registerBody, {
    status: registerResponse.status,
    headers: { 'Content-Type': registerResponse.headers.get('Content-Type') || 'application/json' },
  });
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

  let siteInfoHtml = '<p>No energy site was found on this Tesla account.</p>';
  if (energySiteId) {
    const [siteInfoResponse, liveStatusResponse] = await Promise.all([
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/site_info`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      }),
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/live_status`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      }),
    ]);

    const siteInfo = siteInfoResponse.ok
      ? ((await siteInfoResponse.json()) as TeslaSiteInfoResponse).response
      : undefined;
    const liveStatus = liveStatusResponse.ok
      ? ((await liveStatusResponse.json()) as TeslaLiveStatusResponse).response
      : undefined;

    if (siteInfo || liveStatus) {
      const rows: string[] = [];
      if (siteInfo?.site_name) {
        rows.push(`<li>Site name: ${escapeHtml(siteInfo.site_name)}</li>`);
      }
      rows.push(`<li>Energy site id: ${escapeHtml(energySiteId)}</li>`);
      if (liveStatus?.percentage_charged !== undefined) {
        rows.push(`<li>Battery charge: ${liveStatus.percentage_charged}%</li>`);
      }
      if (liveStatus?.battery_power !== undefined) {
        rows.push(`<li>Battery power: ${liveStatus.battery_power} W</li>`);
      }
      if (liveStatus?.solar_power !== undefined) {
        rows.push(`<li>Solar power: ${liveStatus.solar_power} W</li>`);
      }
      if (liveStatus?.grid_power !== undefined) {
        rows.push(`<li>Grid power: ${liveStatus.grid_power} W</li>`);
      }
      if (liveStatus?.grid_status) {
        rows.push(`<li>Grid status: ${escapeHtml(liveStatus.grid_status)}</li>`);
      }
      siteInfoHtml = `<ul>${rows.join('')}</ul>`;
    } else {
      siteInfoHtml = '<p>Connected, but Tesla did not return any site details yet.</p>';
    }
  }

  return c.html(
    '<!doctype html><html><head><title>Tesla Powerwall Connected</title></head>' +
      '<body><h1>Success</h1><p>Your Tesla Powerwall account has been connected.</p>' +
      siteInfoHtml +
      '</body></html>'
  );
});

export default app;
