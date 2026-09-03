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
  DEBUG_MODE?: string;
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


function escapeHtml(value: unknown): string {
  let stringValue: string;
  if (typeof value === 'string') {
    stringValue = value;
  } else if (value === null) {
    stringValue = 'null';
  } else if (value === undefined) {
    stringValue = 'undefined';
  } else {
    stringValue = JSON.stringify(value);
  }
  return stringValue
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isDebugMode(env: Env): boolean {
  const debugMode = env.DEBUG_MODE;
  return debugMode === 'true' || debugMode === '1' || debugMode === 'yes';
}

// Helper to safely parse JSON response and drain body on error
async function parseJsonResponse<T>(response: Response | undefined, parser: (body: unknown) => T | undefined): Promise<T | undefined> {
  if (!response) return undefined;
  if (response.ok) {
    return parser(await response.json());
  }
  // Consume error response body to prevent resource leaks on Cloudflare Workers
  await response.text();
  return undefined;
}

const app = new Hono<{ Bindings: Env }>();

// Error handling middleware - catches uncaught exceptions and returns them in debug mode
app.onError((err, c) => {
  if (isDebugMode(c.env)) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = (err instanceof Error && err.stack) ? err.stack : 'No stack trace available';
    
    const html = `<!doctype html>
<html>
<head>
  <title>Internal Server Error - Debug</title>
  <style>
    body { font-family: monospace; margin: 20px; background-color: #f5f5f5; }
    .error-container { background-color: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 4px; }
    .error-title { color: #d9534f; font-size: 20px; font-weight: bold; margin-bottom: 10px; }
    .error-message { color: #333; margin-bottom: 20px; }
    .error-stack { background-color: #f9f9f9; border: 1px solid #ddd; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; font-size: 12px; color: #666; }
    .debug-warning { color: #ff6600; margin-top: 20px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-title">Internal Server Error (Debug Mode Enabled)</div>
    <div class="error-message"><strong>Message:</strong> ${escapeHtml(errorMessage)}</div>
    <div class="error-stack"><strong>Stack Trace:</strong>\n${escapeHtml(errorStack)}</div>
    <div class="debug-warning">⚠️ This debug information is only visible because DEBUG_MODE is enabled. Disable it in production!</div>
  </div>
</body>
</html>`;
    
    return c.html(html, 500);
  }
  
  return c.text('Internal Server Error', 500);
});

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
  // Set HTTP-only session cookie with Path=/ to apply to entire domain
  response.headers.set(
    'Set-Cookie',
    `tesla_user_id=${encodeURIComponent(userId)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${24 * 60 * 60}`
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

  // Check if access token has expired or expiration timestamp is missing
  // Use explicit null/undefined check to avoid treating 0 as missing (valid Unix timestamp for 1970-01-01)
  if (userRow.expires_at == null || userRow.expires_at < Math.floor(Date.now() / 1000)) {
    // Clear stale session cookie so client is properly logged out
    const response = c.text('Unauthorized', 401);
    response.headers.set('Set-Cookie', 'tesla_user_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return response;
  }

  const apiBaseUrl = c.env.TESLA_API_BASE_URL || DEFAULT_API_BASE_URL;
  const authorizationHeader = ['Bearer', userRow.access_token].join(' ');

  const coreApiPromises: Promise<Response>[] = [
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
  const energySitePromises: Promise<Response>[] = [];
  if (userRow.tesla_site_id) {
    const energySiteId = userRow.tesla_site_id;
    energySitePromises.push(
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

  // Execute all API calls in parallel with graceful error handling
  // Use allSettled to ensure individual API failures don't prevent other calls from completing
  const coreSettled = await Promise.allSettled(coreApiPromises);
  const energySiteSettled = await Promise.allSettled(energySitePromises);

  // Extract responses (handle fulfilled responses, treat rejected as undefined)
  const coreResponses = coreSettled.map(result =>
    result.status === 'fulfilled' ? result.value : (undefined as unknown as Response)
  );
  const siteResponses = energySiteSettled.map(result =>
    result.status === 'fulfilled' ? result.value : undefined
  );

  // Extract responses from core APIs (always present, but may be undefined if rejected)
  const userResponse = coreResponses[0] as Response;
  const regionResponse = coreResponses[1] as Response;
  const chargingHistoryResponse = coreResponses[2] as Response;

  // Extract responses from energy site APIs (only present if tesla_site_id exists)
  const siteInfoResponse = siteResponses[0] as Response | undefined;
  const liveStatusResponse = siteResponses[1] as Response | undefined;
  const operationResponse = siteResponses[2] as Response | undefined;
  const timeOfUseResponse = siteResponses[3] as Response | undefined;

  // Consume all response bodies to prevent resource leaks on Cloudflare Workers
  const userInfo = await parseJsonResponse(userResponse, (body) => (body as TeslaUserResponse).response);
  const region = await parseJsonResponse(regionResponse, (body) => (body as TeslaRegionResponse).response);
  const chargingHistoryData = await parseJsonResponse(chargingHistoryResponse, (body) => (body as TeslaChargingHistoryResponse).response);

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
    // Consume all response bodies even on error to prevent resource leaks on Cloudflare Workers
    const siteInfo = await parseJsonResponse(siteInfoResponse, (body) => (body as TeslaSiteInfoResponse).response);
    const liveStatus = await parseJsonResponse(liveStatusResponse, (body) => (body as TeslaLiveStatusResponse).response);
    const operation = await parseJsonResponse(operationResponse, (body) => (body as TeslaOperationResponse).response);
    const timeOfUse = await parseJsonResponse(timeOfUseResponse, (body) => (body as TeslaTimeOfUseResponse).response);

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
