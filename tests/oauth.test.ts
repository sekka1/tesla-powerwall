import { describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
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

describe('/auth/callback', () => {
  it('rejects requests with an unknown state', async () => {
    const response = await SELF.fetch(
      'https://example.com/auth/callback?code=abc123&state=unknown-state'
    );
    expect(response.status).toBe(400);
  });

  it('exchanges the code, fetches the energy site, and stores tokens', async () => {
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
        `https://example.com/auth/callback?code=abc123&state=${state}`
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Success');

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
});
