# tesla-powerwall

Tesla OAuth &amp; Public Key Worker — a Cloudflare Workers service, written in TypeScript using [Hono](https://hono.dev/), that fulfills Tesla's third-party developer registration requirements and manages the OAuth 2.0 flow for connecting Tesla Powerwall/Energy accounts.

It is deployed at `https://power.managedkube.com`.

## What this service does

1. **Hosts Tesla's domain verification file** at
   `GET /.well-known/appspecific/com.tesla.3p.public-key.pem`, serving the public key required for Tesla partner registration.
2. **Starts the OAuth 2.0 flow** at `GET /auth/login`, which generates a random CSRF `state` value, persists it in Cloudflare D1, and redirects the user to Tesla's authorization endpoint (`https://auth.tesla.com/oauth2/v3/authorize`).
3. **Handles the OAuth callback** at `GET /auth/callback`, which:
   - Validates the returned `state` against the `oauth_states` table (and deletes it once consumed, so it can only be used once).
   - Exchanges the authorization `code` for an `access_token`/`refresh_token` via `POST https://auth.tesla.com/oauth2/v3/token`.
   - Looks up the user's `energy_site_id` via `GET /api/1/energy_sites` on Tesla's Fleet API.
   - Persists the tokens and site id in the `tesla_users` table in Cloudflare D1.
   - Returns a simple HTML success page.

## Project layout

```
src/index.ts          Hono application: routes for the public key, OAuth login, and OAuth callback
migrations/           Numbered SQL migrations applied to the Cloudflare D1 database via wrangler
scripts/              Helper scripts (e.g. wrangler.jsonc placeholder-value check)
tests/oauth.test.ts   Vitest + @cloudflare/vitest-pool-workers tests (Tesla API calls are mocked)
wrangler.jsonc        Cloudflare Workers configuration (routes, D1 binding, non-secret vars)
.github/workflows/    CI (lint/typecheck/test), CD (deploy to Cloudflare on main), and a manual
                       one-time D1 database setup workflow
AGENTS.md             Guidelines for AI coding agents working in this repository
.github/agents/       Specialized agent personas (security, database, devops experts)
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values for local testing; .dev.vars is gitignored
npm run dev                      # runs `wrangler dev`
```

## Configuration

Non-secret configuration lives in `wrangler.jsonc` under `vars`:

- `TESLA_CLIENT_ID` — Tesla developer app client id.
- `TESLA_REDIRECT_URI` — must exactly match the redirect URI registered in the Tesla Developer Portal (`https://power.managedkube.com/auth/callback`).
- `TESLA_PUBLIC_KEY` — the PEM-encoded public key served at the `.well-known` endpoint.

Secrets must **never** be committed to source control or placed in `vars`. Set them with Wrangler or GitHub Actions secrets instead:

```bash
wrangler secret put TESLA_CLIENT_SECRET
```

CI/CD deployment requires the following GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Database

Cloudflare D1 stores two tables (see `migrations/0001_create_tesla_tokens.sql`):

- `oauth_states` — single-use CSRF state values created by `/auth/login` and consumed by `/auth/callback`.
- `tesla_users` — persisted `access_token`, `refresh_token`, `expires_at`, and `tesla_site_id` per connected account.

Apply migrations with:

```bash
npm run db:migrate:local   # local dev database
npm run db:migrate:remote  # production database
```

### Cloudflare D1 setup (one-time)

`wrangler.jsonc` ships with a placeholder `database_id` (`REPLACE_WITH_D1_DATABASE_ID`) since the
real D1 database doesn't exist until it's created in your Cloudflare account. Deploying with the
placeholder in place fails (see [issue #3](https://github.com/sekka1/tesla-powerwall/issues/3)), so
this must be done once before the first deploy:

1. Ensure the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository/environment secrets are
   set (the `production` environment used by the deploy workflow).
2. Run the **"Setup Cloudflare D1 Database"** workflow from the Actions tab
   (`workflow_dispatch`, no inputs required). It creates the `tesla-powerwall-db` D1 database if it
   doesn't already exist and applies migrations to it.
3. Copy the `database_id` printed in the workflow's "Show D1 databases" step logs into
   `wrangler.jsonc` under `d1_databases[0].database_id`, replacing the placeholder.
4. Commit and push the change to `main` — this triggers the **Deploy** workflow, which now also
   verifies `wrangler.jsonc` has no leftover placeholder values (`npm run check:config`) and applies
   any pending migrations before deploying the Worker.

You only need to repeat this if the database is ever deleted/recreated or you move to a different
Cloudflare account.

## Testing, linting, and type-checking

```bash
npm run lint
npm run typecheck
npm test
```

Tests use `@cloudflare/vitest-pool-workers`, which runs the actual Worker code (and a local D1 instance with migrations applied) inside `workerd`. Outbound calls to Tesla's OAuth and Fleet API endpoints are mocked in tests — no real network calls to Tesla are made.

## Tesla Developer Portal configuration

Once this Worker is deployed, configure the Tesla Developer Portal application with:

- **Allowed Origin URL:** `https://power.managedkube.com`
- **Allowed Redirect URI:** `https://power.managedkube.com/auth/callback`

## Notes for future AI agents

- Read `AGENTS.md` before making changes — it documents security, testing, and architectural rules specific to this repository.
- See `.github/agents/` for specialized personas (`security-expert`, `database-expert`, `devops-expert`) to consult when touching related areas of the code.
- This is a Cloudflare Workers project (edge runtime) — do not introduce Node.js-only built-ins (`fs`, `path`, `child_process`, etc.) into `src/`.

