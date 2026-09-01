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

interface TeslaUserResponse {
  response?: {
    email?: string;
    first_name?: string;
    last_name?: string;
    profile_picture_url?: string;
  };
}

interface TeslaRegionResponse {
  response?: string;
}

interface TeslaOperationResponse {
  response?: {
    mode?: string;
    backup_reserve_percent?: number;
  };
}

interface TeslaTimeOfUseResponse {
  response?: {
    optimization_strategy?: string;
    weekday_minutes?: string;
    weekend_minutes?: string;
  };
}

interface TeslaChargingHistory {
  timestamp?: number;
  charge_energy_added?: number;
  charger_name?: string;
  charging_process_id?: string;
  charge_start_battery_level?: number;
  charge_end_battery_level?: number;
}

interface TeslaChargingHistoryResponse {
  response?: TeslaChargingHistory[];
}

interface TeslaPartnerTokenResponse {
  access_token: string;
}

function getCookieValue(cookieHeader: string | undefined | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [cookieName, ...cookieValue] = cookie.split('=');
    if (cookieName === name) {
      return decodeURIComponent(cookieValue.join('='));
    }
  }
  return undefined;
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
    const partnerTokenErrorBody = await partnerTokenResponse.text();
    return new Response(partnerTokenErrorBody, {
      status: 502,
      headers: {
        'Content-Type': partnerTokenResponse.headers.get('Content-Type') || 'application/json',
      },
    });
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

app.get('/auth/logout', async (c) => {
  return c.redirect('/auth/login', 302);
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
    const tokenErrorBody = await tokenResponse.text();
    return new Response(tokenErrorBody, {
      status: 502,
      headers: {
        'Content-Type': tokenResponse.headers.get('Content-Type') || 'application/json',
      },
    });
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

  // Create redirect response with session cookie
  // The session cookie contains the user's database ID (a cryptographically random UUID),
  // which serves as an opaque session token. Since UUIDs are cryptographically random,
  // they cannot be guessed or enumerated by attackers.
  const response = c.redirect('/home', 302);
  // Set HTTP-only session cookie
  response.headers.set(
    'Set-Cookie',
    `tesla_user_id=${encodeURIComponent(userId)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 60 * 60}`
  );
  return response;
});

app.get('/home', async (c) => {
  // Get user ID from session cookie
  const cookieHeader = c.req.header('Cookie');
  const userId = getCookieValue(cookieHeader, 'tesla_user_id');

  if (!userId) {
    return c.text('Unauthorized', 401);
  }

  const userRow = await c.env.DB.prepare(
    'SELECT id, tesla_site_id, access_token, expires_at FROM tesla_users WHERE id = ?1'
  )
    .bind(userId)
    .first() as { id?: string; tesla_site_id?: string; access_token?: string; expires_at?: number } | undefined;

  if (!userRow || !userRow.access_token) {
    return c.text('Unauthorized', 401);
  }

  // Check if access token has expired
  if (userRow.expires_at && userRow.expires_at < Math.floor(Date.now() / 1000)) {
    return c.text('Unauthorized', 401);
  }

  const apiBaseUrl = c.env.TESLA_API_BASE_URL || DEFAULT_API_BASE_URL;
  const authorizationHeader = ['Bearer', userRow.access_token].join(' ');

  // Fetch all 6 API calls in parallel for optimal performance
  const fetchPromises: Promise<Response>[] = [
    fetch(new URL('/api/1/users/me', apiBaseUrl).toString(), {
      headers: { Authorization: authorizationHeader },
    }),
    fetch(new URL('/api/1/users/region', apiBaseUrl).toString(), {
      headers: { Authorization: authorizationHeader },
    }),
    fetch(new URL('/api/1/charging_history', apiBaseUrl).toString(), {
      headers: { Authorization: authorizationHeader },
    }),
  ];

  // Add energy site API calls if site ID exists
  if (userRow.tesla_site_id) {
    const energySiteId = userRow.tesla_site_id;
    fetchPromises.push(
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/site_info`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      }),
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/live_status`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      }),
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/operation`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      }),
      fetch(new URL(`/api/1/energy_sites/${energySiteId}/time_of_use_settings`, apiBaseUrl).toString(), {
        headers: { Authorization: authorizationHeader },
      })
    );
  }

  const responses = await Promise.all(fetchPromises);

  // Extract responses (always 3, optionally +4 more for energy site)
  const userResponse = responses[0] as Response;
  const regionResponse = responses[1] as Response;
  const chargingHistoryResponse = responses[2] as Response;
  const siteInfoResponse = responses[3] as Response | undefined;
  const liveStatusResponse = responses[4] as Response | undefined;
  const operationResponse = responses[5] as Response | undefined;
  const timeOfUseResponse = responses[6] as Response | undefined;

  // Consume all response bodies to prevent resource leaks on Cloudflare Workers
  const userInfo = userResponse.ok ? ((await userResponse.json()) as TeslaUserResponse).response : (await userResponse.text(), undefined);
  const region = regionResponse.ok ? ((await regionResponse.json()) as TeslaRegionResponse).response : (await regionResponse.text(), undefined);
  const chargingHistoryData = chargingHistoryResponse.ok ? ((await chargingHistoryResponse.json()) as TeslaChargingHistoryResponse).response : (await chargingHistoryResponse.text(), undefined);

  // Build HTML sections
  const sections: string[] = [];
  sections.push('<h1>Tesla Energy Dashboard</h1>');
  sections.push('<p><a href="/auth/logout">Log out</a></p>');

  // User Info Section
  if (userInfo) {
    sections.push('<h2>User Information</h2>');
    sections.push('<table border="1" cellpadding="5" cellspacing="0">');
    sections.push('<tr><th>Field</th><th>Value</th></tr>');
    if (userInfo.email) {
      sections.push(`<tr><td>Email</td><td>${escapeHtml(userInfo.email)}</td></tr>`);
    }
    if (userInfo.first_name) {
      sections.push(`<tr><td>First Name</td><td>${escapeHtml(userInfo.first_name)}</td></tr>`);
    }
    if (userInfo.last_name) {
      sections.push(`<tr><td>Last Name</td><td>${escapeHtml(userInfo.last_name)}</td></tr>`);
    }
    sections.push('</table>');
  }

  // Region Section
  if (region) {
    sections.push('<h2>Region</h2>');
    sections.push(`<p>${escapeHtml(region)}</p>`);
  }

  // Energy Site Information
  if (userRow.tesla_site_id) {
    const energySiteId = userRow.tesla_site_id;
    sections.push('<h2>Energy Site Information</h2>');

    // Responses for energy site are at indices 3, 4, 5, 6 if they exist
    const siteInfo = siteInfoResponse && siteInfoResponse.ok
      ? ((await siteInfoResponse.json()) as TeslaSiteInfoResponse).response
      : undefined;
    const liveStatus = liveStatusResponse && liveStatusResponse.ok
      ? ((await liveStatusResponse.json()) as TeslaLiveStatusResponse).response
      : undefined;
    const operation = operationResponse && operationResponse.ok
      ? ((await operationResponse.json()) as TeslaOperationResponse).response
      : undefined;
    const timeOfUse = timeOfUseResponse && timeOfUseResponse.ok
      ? ((await timeOfUseResponse.json()) as TeslaTimeOfUseResponse).response
      : undefined;

    // Site Info
    if (siteInfo) {
      sections.push('<h3>Site Info</h3>');
      sections.push('<table border="1" cellpadding="5" cellspacing="0">');
      sections.push('<tr><th>Field</th><th>Value</th></tr>');
      if (siteInfo.site_name) {
        sections.push(`<tr><td>Site Name</td><td>${escapeHtml(siteInfo.site_name)}</td></tr>`);
      }
      sections.push(`<tr><td>Energy Site ID</td><td>${escapeHtml(energySiteId)}</td></tr>`);
      sections.push('</table>');
    }

    // Live Status
    if (liveStatus) {
      sections.push('<h3>Live Status</h3>');
      sections.push('<table border="1" cellpadding="5" cellspacing="0">');
      sections.push('<tr><th>Field</th><th>Value</th></tr>');
      if (liveStatus.percentage_charged !== undefined) {
        sections.push(`<tr><td>Battery Charge</td><td>${liveStatus.percentage_charged}%</td></tr>`);
      }
      if (liveStatus.battery_power !== undefined) {
        sections.push(`<tr><td>Battery Power</td><td>${liveStatus.battery_power} W</td></tr>`);
      }
      if (liveStatus.solar_power !== undefined) {
        sections.push(`<tr><td>Solar Power</td><td>${liveStatus.solar_power} W</td></tr>`);
      }
      if (liveStatus.grid_power !== undefined) {
        sections.push(`<tr><td>Grid Power</td><td>${liveStatus.grid_power} W</td></tr>`);
      }
      if (liveStatus.grid_status) {
        sections.push(`<tr><td>Grid Status</td><td>${escapeHtml(liveStatus.grid_status)}</td></tr>`);
      }
      sections.push('</table>');
    }

    // Operation
    if (operation) {
      sections.push('<h3>Operation</h3>');
      sections.push('<table border="1" cellpadding="5" cellspacing="0">');
      sections.push('<tr><th>Field</th><th>Value</th></tr>');
      if (operation.mode) {
        sections.push(`<tr><td>Mode</td><td>${escapeHtml(operation.mode)}</td></tr>`);
      }
      if (operation.backup_reserve_percent !== undefined) {
        sections.push(
          `<tr><td>Backup Reserve</td><td>${operation.backup_reserve_percent}%</td></tr>`
        );
      }
      sections.push('</table>');
    }

    // Time of Use Settings
    if (timeOfUse) {
      sections.push('<h3>Time of Use Settings</h3>');
      sections.push('<table border="1" cellpadding="5" cellspacing="0">');
      sections.push('<tr><th>Field</th><th>Value</th></tr>');
      if (timeOfUse.optimization_strategy) {
        sections.push(
          `<tr><td>Optimization Strategy</td><td>${escapeHtml(timeOfUse.optimization_strategy)}</td></tr>`
        );
      }
      if (timeOfUse.weekday_minutes) {
        sections.push(
          `<tr><td>Weekday Minutes</td><td><pre>${escapeHtml(timeOfUse.weekday_minutes)}</pre></td></tr>`
        );
      }
      if (timeOfUse.weekend_minutes) {
        sections.push(
          `<tr><td>Weekend Minutes</td><td><pre>${escapeHtml(timeOfUse.weekend_minutes)}</pre></td></tr>`
        );
      }
      sections.push('</table>');
    }
  }

  // Charging History Section
  if (chargingHistoryData && Array.isArray(chargingHistoryData) && chargingHistoryData.length > 0) {
    sections.push('<h2>Charging History</h2>');
    sections.push('<table border="1" cellpadding="5" cellspacing="0">');
    sections.push('<tr><th>Charger Name</th><th>Energy Added (kWh)</th><th>Start Battery %</th><th>End Battery %</th></tr>');
    for (const entry of chargingHistoryData) {
      const chargerName = entry.charger_name ? escapeHtml(entry.charger_name) : 'N/A';
      const energyAdded = entry.charge_energy_added !== undefined ? entry.charge_energy_added : 'N/A';
      const startLevel = entry.charge_start_battery_level !== undefined ? `${entry.charge_start_battery_level}%` : 'N/A';
      const endLevel = entry.charge_end_battery_level !== undefined ? `${entry.charge_end_battery_level}%` : 'N/A';
      sections.push(`<tr><td>${chargerName}</td><td>${energyAdded}</td><td>${startLevel}</td><td>${endLevel}</td></tr>`);
    }
    sections.push('</table>');
  }

  const html = `<!doctype html>
<html>
<head>
  <title>Tesla Energy Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    table { border-collapse: collapse; margin-bottom: 20px; }
    th { background-color: #f0f0f0; text-align: left; }
    td { padding: 8px; }
    pre { background-color: #f5f5f5; padding: 10px; overflow-x: auto; }
  </style>
</head>
<body>
${sections.join('')}
</body>
</html>`;

  return c.html(html);
});

export default app;
