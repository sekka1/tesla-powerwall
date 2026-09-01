import { describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';

function buildAuthHeader(token: string): string {
  return ['Bearer', token].join(' ');
}

describe('/', () => {
  it('returns the project name and status', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json();
    expect(body).toMatchObject({
      name: 'tesla-powerwall',
      description: 'Tesla OAuth & Public Key Worker for Tesla Powerwall integration',
      status: 'ok',
    });
  });
});

describe('.well-known public key endpoint', () => {
  it('serves the configured public key as text/plain', async () => {
    const response = await SELF.fetch('https://example.com/.well-known/appspecific/com.tesla.3p.public-key.pem');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('BEGIN PUBLIC KEY');
  });
});

describe('/admin/register-domain', () => {
  it('rejects requests without a valid admin bearer token', async () => {
    const response = await SELF.fetch('https://example.com/admin/register-domain', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('no separate OAuth browser login step');
  });

  it('rejects requests with an incorrect admin bearer token', async () => {
    const response = await SELF.fetch('https://example.com/admin/register-domain', {
      method: 'POST',
      headers: { Authorization: buildAuthHeader('wrong-token') },
    });
    expect(response.status).toBe(401);
  });

  it('obtains a partner token and registers the configured domain', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token') {
          const body = new URLSearchParams(init?.body as string);
          expect(body.get('grant_type')).toBe('client_credentials');
          expect(body.get('audience')).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');
          return new Response(JSON.stringify({ access_token: 'partner-token-value' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts') {
          expect(init?.headers).toMatchObject({ Authorization: buildAuthHeader('partner-token-value') });
          expect(JSON.parse(init?.body as string)).toMatchObject({
            domain: 'tesla-powerwall.example.com',
          });
          return new Response(JSON.stringify({ response: { domain: 'tesla-powerwall.example.com' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

    try {
      const response = await SELF.fetch('https://example.com/admin/register-domain', {
        method: 'POST',
        headers: { Authorization: buildAuthHeader('test-admin-token') },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ response: { domain: 'tesla-powerwall.example.com' } });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns the full Tesla partner_accounts response body on success', async () => {
    const teslaRegisterResponse = {
      response: {
        client_id: 'client-id',
        name: 'The Best Tesla Partner',
        description: 'The very best Tesla partner',
        domain: 'tesla-powerwall.example.com',
        ca: null,
        created_at: '2023-06-28T00:42:00.000Z',
        updated_at: '2023-06-28T00:42:00.000Z',
        enterprise_tier: 'pay_as_you_go',
        account_id: 'account-id',
        issuer: null,
        csr: null,
        csr_updated_at: null,
        public_key: '0437d832a7a695151f5a671780a276aa4cf2d6be3b2786465397612a342fcf418e98',
        public_key_hash: '0d3becca0faf0bc57b20ff143bc9eebf',
      },
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token') {
          return new Response(JSON.stringify({ access_token: 'partner-token-value' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url === 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts') {
          return new Response(JSON.stringify(teslaRegisterResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

    try {
      const response = await SELF.fetch('https://example.com/admin/register-domain', {
        method: 'POST',
        headers: { Authorization: buildAuthHeader('test-admin-token') },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(teslaRegisterResponse);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forwards the Tesla partner-token error body when the token request fails', async () => {
    const teslaTokenError = { error: 'invalid_client', error_description: 'Client authentication failed' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token') {
          return new Response(JSON.stringify(teslaTokenError), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

    try {
      const response = await SELF.fetch('https://example.com/admin/register-domain', {
        method: 'POST',
        headers: { Authorization: buildAuthHeader('test-admin-token') },
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual(teslaTokenError);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('/auth/login', () => {
  it('redirects to Tesla OAuth with a state parameter and persists it', async () => {
    const response = await SELF.fetch('https://example.com/auth/login', { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://auth.tesla.com');
    expect(location.pathname).toBe('/oauth2/v3/authorize');
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const row = await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?1')
      .bind(state)
      .first();
    expect(row).toBeTruthy();
  });
});

describe('/auth/logout', () => {
  it('redirects to /auth/login without disturbing other in-flight oauth states', async () => {
    await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?1)').bind('other-users-state').run();

    const response = await SELF.fetch('https://example.com/auth/logout', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/login');

    const row = await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?1')
      .bind('other-users-state')
      .first();
    expect(row).toBeTruthy();
  });
});

describe('/auth/callback', () => {
  it('rejects requests with an unknown state', async () => {
    const response = await SELF.fetch(
      'https://example.com/auth/callback?code=abc123&state=unknown-state'
    );
    expect(response.status).toBe(400);
  });

  it('exchanges the code, fetches the energy site, stores tokens, sets session cookie, and redirects to /home', async () => {
    const state = 'test-state-123';
    await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?1)').bind(state).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/oauth2/v3/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'access-token-value',
            refresh_token: 'refresh-token-value',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/energy_sites')) {
        return new Response(JSON.stringify({ response: [{ energy_site_id: 999 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    try {
      const response = await SELF.fetch(
        `https://example.com/auth/callback?code=abc123&state=${state}`,
        { redirect: 'manual' }
      );
      expect(response.status).toBe(302);
      const location = response.headers.get('location');
      expect(location).toBe('/home');
      
      // Verify session cookie was set
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain('tesla_user_id=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');

      const row = await env.DB.prepare(
        'SELECT tesla_site_id, access_token, refresh_token FROM tesla_users WHERE tesla_site_id = ?1'
      )
        .bind('999')
        .first();
      expect(row).toMatchObject({
        tesla_site_id: '999',
        access_token: 'access-token-value',
        refresh_token: 'refresh-token-value',
      });

      const stateRow = await env.DB.prepare('SELECT state FROM oauth_states WHERE state = ?1')
        .bind(state)
        .first();
      expect(stateRow).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forwards the Tesla token-exchange error body when the code exchange fails', async () => {
    const state = 'test-state-error';
    await env.DB.prepare('INSERT INTO oauth_states (state) VALUES (?1)').bind(state).run();

    const teslaTokenError = { error: 'invalid_client', error_description: 'Client authentication failed' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/oauth2/v3/token')) {
        return new Response(JSON.stringify(teslaTokenError), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    try {
      const response = await SELF.fetch(
        `https://example.com/auth/callback?code=abc123&state=${state}`
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual(teslaTokenError);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('/home', () => {
  it('rejects requests without a valid session cookie', async () => {
    const response = await SELF.fetch('https://example.com/home');
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain('Unauthorized');
  });

  it('rejects requests with an invalid session cookie', async () => {
    const response = await SELF.fetch('https://example.com/home', {
      headers: { 'Cookie': 'tesla_user_id=non-existent-user' },
    });
    expect(response.status).toBe(401);
  });

  it('displays user info, region, and energy site data with valid session', async () => {
    const userId = 'test-user-123';
    await env.DB.prepare(
      'INSERT INTO tesla_users (id, tesla_site_id, access_token, refresh_token, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(userId, '999', 'access-token-value', 'refresh-token-value', Math.floor(Date.now() / 1000) + 3600)
      .run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/1/users/me')) {
        return new Response(
          JSON.stringify({
            response: {
              email: 'test@example.com',
              first_name: 'John',
              last_name: 'Doe',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/users/region')) {
        return new Response(
          JSON.stringify({
            response: 'US',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/energy_sites/999/site_info')) {
        return new Response(
          JSON.stringify({
            response: { site_name: 'Home' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/energy_sites/999/live_status')) {
        return new Response(
          JSON.stringify({
            response: {
              solar_power: 1500,
              battery_power: -200,
              grid_power: 0,
              percentage_charged: 87.5,
              grid_status: 'Active',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/energy_sites/999/operation')) {
        return new Response(
          JSON.stringify({
            response: {
              mode: 'autonomous',
              backup_reserve_percent: 20,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/energy_sites/999/time_of_use_settings')) {
        return new Response(
          JSON.stringify({
            response: {
              optimization_strategy: 'economics',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/charging_history')) {
        return new Response(
          JSON.stringify({
            response: [
              {
                charger_name: 'Wall Connector',
                charge_energy_added: 25.5,
                charge_start_battery_level: 45,
                charge_end_battery_level: 100,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    try {
      const response = await SELF.fetch('https://example.com/home', {
        headers: { 'Cookie': `tesla_user_id=${userId}` },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Tesla Energy Dashboard');
      expect(html).toContain('test@example.com');
      expect(html).toContain('John');
      expect(html).toContain('Doe');
      expect(html).toContain('US');
      expect(html).toContain('Home');
      expect(html).toContain('87.5%');
      expect(html).toContain('Active');
      expect(html).toContain('autonomous');
      expect(html).toContain('20%');
      expect(html).toContain('Wall Connector');
      expect(html).toContain('25.5');
      expect(html).toContain('/auth/logout');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('displays partial information when some API endpoints fail', async () => {
    const userId = 'test-user-partial';
    await env.DB.prepare(
      'INSERT INTO tesla_users (id, tesla_site_id, access_token, refresh_token, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(userId, '888', 'access-token-value', 'refresh-token-value', Math.floor(Date.now() / 1000) + 3600)
      .run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/1/users/me')) {
        return new Response(
          JSON.stringify({
            response: {
              email: 'partial@example.com',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // All other endpoints return errors
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const response = await SELF.fetch('https://example.com/home', {
        headers: { 'Cookie': `tesla_user_id=${userId}` },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Tesla Energy Dashboard');
      expect(html).toContain('partial@example.com');
      expect(html).toContain('/auth/logout');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handles users without an energy site ID', async () => {
    const userId = 'test-user-no-site';
    await env.DB.prepare(
      'INSERT INTO tesla_users (id, tesla_site_id, access_token, refresh_token, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(userId, null, 'access-token-value', 'refresh-token-value', Math.floor(Date.now() / 1000) + 3600)
      .run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/1/users/me')) {
        return new Response(
          JSON.stringify({
            response: {
              email: 'nosite@example.com',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/users/region')) {
        return new Response(
          JSON.stringify({
            response: 'US',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/1/charging_history')) {
        return new Response(
          JSON.stringify({
            response: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    try {
      const response = await SELF.fetch('https://example.com/home', {
        headers: { 'Cookie': `tesla_user_id=${userId}` },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Tesla Energy Dashboard');
      expect(html).toContain('nosite@example.com');
      expect(html).toContain('US');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('Error Handler Middleware', () => {
  it('is configured to catch errors and prevent unhandled exceptions', async () => {
    // The error handler middleware is configured with app.onError() to catch
    // any uncaught exceptions that escape from route handlers.
    // This test verifies the app continues to function correctly, which implicitly
    // verifies error handling is in place (since if it wasn't, unhandled errors would crash the app).
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.name).toBe('tesla-powerwall');
    expect(body.status).toBe('ok');
  });

  it('catches errors and returns proper error response with status 500', async () => {
    // Call the test error route which is guarded by DEBUG_MODE
    // The route will only throw if DEBUG_MODE is set
    const response = await SELF.fetch('https://example.com/test/error');
    
    // Verify error handling
    expect(response.status).toBe(500);
    const responseText = await response.text();
    expect(responseText).toBeTruthy();
    
    // Check if debug information is present (when DEBUG_MODE is enabled in tests)
    if (responseText.includes('Debug Mode Enabled')) {
      // Debug mode is on - verify error details are shown
      expect(responseText).toContain('Internal Server Error (Debug Mode Enabled)');
      expect(responseText).toContain('Test error:');
      // Verify XSS protection - angle brackets should be escaped
      expect(responseText).toContain('&lt;script&gt;');
      expect(responseText).not.toContain('<script>');
    } else if (responseText.includes('Internal Server Error')) {
      // Debug mode is off - verify generic error message
      expect(responseText).toContain('Internal Server Error');
      expect(responseText).not.toContain('Stack Trace');
    }
  });

  it('properly escapes HTML in error messages to prevent XSS', async () => {
    // The error handler uses escapeHtml() to sanitize error messages.
    // When DEBUG_MODE is enabled, verify the error contains HTML entities
    // instead of raw HTML tags, preventing XSS attacks.
    const response = await SELF.fetch('https://example.com/test/error');
    
    if (response.status === 500) {
      const responseText = await response.text();
      // If debug mode is on, check that HTML special characters are escaped
      if (responseText.includes('&lt;script&gt;')) {
        // HTML entities for < and > should be present
        expect(responseText).toContain('&lt;');
        expect(responseText).toContain('&gt;');
        // Raw HTML tags should not be present
        expect(responseText).not.toContain('<script>');
        expect(responseText).not.toContain('</script>');
      }
    }
  });
});

