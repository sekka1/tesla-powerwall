# tesla-powerwall

Tesla OAuth &amp; Public Key Worker — a Cloudflare Workers service, written in TypeScript using [Hono](https://hono.dev/), that fulfills Tesla's third-party developer registration requirements and manages the OAuth 2.0 flow for connecting Tesla Powerwall/Energy accounts.

> **Reference:** [Tesla Fleet API — What is Fleet API?](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api) — the authoritative guide for the registration steps (public key domain verification, partner token, OAuth) implemented by this service.

It is deployed at `https://tesla-powerwall.garlandk.workers.dev`. This is Cloudflare's stable
`workers_dev` preview URL for the Worker (`https://<worker-name>.<subdomain>.workers.dev`,
`workers_dev: true` in `wrangler.jsonc`) — it comes with a TLS cert managed by Cloudflare out of
the box, so it's used directly instead of a custom domain. (We originally planned to use a
subdomain of `managedkube.com`, but Cloudflare requires delegating the entire root domain to add
it as a zone for free, which wasn't an option — see
[issue #11](https://github.com/sekka1/tesla-powerwall/issues/11).) This `workers.dev` URL is what's
registered with Tesla as the OAuth redirect/origin.

## What this service does

1. **Hosts Tesla's domain verification file** at
   `GET /.well-known/appspecific/com.tesla.3p.public-key.pem`, serving the public key required for Tesla partner registration.
2. **Starts the OAuth 2.0 flow** at `GET /auth/login`, which generates a random CSRF `state` value, persists it in Cloudflare D1, and redirects the user to Tesla's authorization endpoint (`https://auth.tesla.com/oauth2/v3/authorize`).
3. **Handles the OAuth callback** at `GET /auth/callback`, which:
   - Validates the returned `state` against the `oauth_states` table (and deletes it once consumed, so it can only be used once).
   - Exchanges the authorization `code` for an `access_token`/`refresh_token` via `POST https://auth.tesla.com/oauth2/v3/token`.
     If Tesla rejects the exchange (e.g. `invalid_client` because `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`
     don't match what's registered in the Tesla Developer Portal), Tesla's raw error response body is
     forwarded back as-is (with a `502` status, mirroring `/admin/register-domain` below) so the real
     cause is visible instead of a generic message.
   - Looks up the user's `energy_site_id` via `GET /api/1/energy_sites` on Tesla's Fleet API.
   - Persists the tokens and site id in the `tesla_users` table in Cloudflare D1.
   - Fetches `site_info` and `live_status` for that energy site and renders the site name, battery
     charge, and solar/battery/grid power on the success page, so the OAuth flow and Fleet API
     access can be visually verified end-to-end. The success page includes a "Log out and connect a
     different account" link to `GET /auth/logout`, which simply redirects to `/auth/login` to start a
     fresh authorization request (there's no server-side session to tear down — `/auth/login` always
     issues a brand-new CSRF `state`, so retrying/re-logging-in doesn't require clearing anything).
4. **Completes step 4 of Tesla's registration ("Generate a Partner Authentication Token and Call the Register Endpoint")** at
   `POST /admin/register-domain`, which:
   - Requires the request to send an `Authorization` header equal to the configured
     `ADMIN_API_TOKEN` value (prefixed with the standard auth scheme word), so only an
     operator who knows the admin token can trigger registration.
   - **Generates a partner authentication token** via a `client_credentials` OAuth 2.0 grant to Tesla's partner auth
     endpoint (`https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`), using `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`
     with `grant_type: client_credentials`, `scope: openid`, and `audience: https://fleet-api.prd.na.vn.cloud.tesla.com`.
   - **Calls the register endpoint** with the partner token, sending
     `POST https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts` with the
     configured `TESLA_DOMAIN`, and returns Tesla's response.

## Project layout

```
src/index.ts          Hono application: routes for the public key, OAuth login, and OAuth callback
migrations/           Numbered SQL migrations applied to the Cloudflare D1 database via wrangler
scripts/              Helper scripts (e.g. wrangler.jsonc placeholder-value check)
tests/oauth.test.ts   Vitest + @cloudflare/vitest-pool-workers tests (Tesla API calls are mocked)
wrangler.jsonc        Cloudflare Workers configuration (routes, D1 binding, non-secret vars)
.github/workflows/    CI (lint/typecheck/test), CD (deploy to Cloudflare on main), and manual
                       one-time D1 database and Worker/custom-domain setup workflows
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
- `TESLA_REDIRECT_URI` — must exactly match the redirect URI registered in the Tesla Developer Portal (`https://tesla-powerwall.garlandk.workers.dev/auth/callback`).
- `TESLA_PUBLIC_KEY` — the PEM-encoded EC public key served at the `.well-known` endpoint for Tesla partner domain verification.
- `TESLA_DOMAIN` — the root domain to register with Tesla via `POST /admin/register-domain` (must match the domain hosting the `.well-known` public key file, e.g. `tesla-powerwall.garlandk.workers.dev`).

Secrets must **never** be committed to source control or placed in `vars`. Set them with Wrangler or GitHub Actions secrets instead:

```bash
wrangler secret put TESLA_CLIENT_SECRET
wrangler secret put PRIVATE_KEY
wrangler secret put ADMIN_API_TOKEN
```

`ADMIN_API_TOKEN` is **not** issued by Tesla or Cloudflare — it's a password you make up
yourself, used only to protect `POST /admin/register-domain` from being called by anyone
who finds the Worker's URL. There's nothing to "look up":

1. Generate a random value yourself, e.g. `openssl rand -hex 32` (or any long random string).
2. Store it either with `wrangler secret put ADMIN_API_TOKEN` (shown above) locally, or as the
   `ADMIN_API_TOKEN` GitHub Actions repository/environment secret — the **Deploy** workflow pushes
   it to the Worker via `wrangler secret put` on every deploy, so setting the GitHub Actions secret
   is sufficient going forward. Either way, Cloudflare stores it encrypted and never displays it
   again.
3. Yes, write it down (e.g. in a password manager) — Cloudflare has no "show secret" command,
   so if you lose it, you can't retrieve it; you'd just set a new value (via `wrangler secret put`
   or by updating the GitHub Actions secret). You need the value on hand to call
   `/admin/register-domain` (see "Completing Tesla partner registration" below), and it's safe to
   rotate at any time since the endpoint is only used for that one manual step, not for ongoing
   OAuth traffic.

CI/CD deployment requires the following GitHub Actions secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TESLA_CLIENT_SECRET`, `PRIVATE_KEY`, `ADMIN_API_TOKEN`. The **Deploy** workflow pushes `PRIVATE_KEY` and `ADMIN_API_TOKEN` to the Worker via `wrangler secret put` on every deploy, so setting the GitHub Actions secret is enough — no manual `wrangler secret put ADMIN_API_TOKEN` is required once this is configured.

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
4. Replace any remaining `REPLACE_WITH_*` placeholders in `wrangler.jsonc` (including
   `d1_databases[0].database_id`, `vars.TESLA_CLIENT_ID`, and `vars.TESLA_PUBLIC_KEY`), then
   commit and push the change to `main` — this triggers the **Deploy** workflow, which now also verifies `wrangler.jsonc` has no leftover placeholder values (`npm run check:config`) and applies any pending migrations before deploying the Worker.

You only need to repeat this if the database is ever deleted/recreated or you move to a different
Cloudflare account.

### Cloudflare Worker setup (one-time)

The Worker itself is normally created on the first push-triggered **Deploy** run, but you can also
create it explicitly with a manual workflow, mirroring the D1 setup above:

1. Complete the **Cloudflare D1 setup** above and replace all remaining `REPLACE_WITH_*`
   placeholders in `wrangler.jsonc` (`d1_databases[0].database_id`, `vars.TESLA_CLIENT_ID`, and
   `vars.TESLA_PUBLIC_KEY`).
2. Run the **"Setup Cloudflare Worker"** workflow from the Actions tab (`workflow_dispatch`, no
   inputs required). It runs `wrangler deploy`, which creates the Worker if it doesn't already
   exist and makes it reachable at its stable `workers_dev` URL
   (`https://tesla-powerwall.garlandk.workers.dev`, since `workers_dev: true` is set in
   `wrangler.jsonc`) so Tesla's OAuth callback can reach it — no custom domain/DNS zone setup is
   required.
3. After this, ordinary `git push` to `main` keeps deploying/updating the same Worker via the
   **Deploy** workflow.

## Testing, linting, and type-checking

```bash
npm run lint
npm run typecheck
npm test
```

Tests use `@cloudflare/vitest-pool-workers`, which runs the actual Worker code (and a local D1 instance with migrations applied) inside `workerd`. Outbound calls to Tesla's OAuth and Fleet API endpoints are mocked in tests — no real network calls to Tesla are made.

## Tesla Developer Portal configuration

Once this Worker is deployed, configure the Tesla Developer Portal application with:

- **Allowed Origin URL:** `https://tesla-powerwall.garlandk.workers.dev`
- **Allowed Redirect URI:** `https://tesla-powerwall.garlandk.workers.dev/auth/callback`

## Registration and OAuth workflow

This service implements two separate workflows from Tesla's registration guide:

1. **Partner registration workflow (Step 4 of Tesla's guide — one-time, manual, admin-driven):**
   The app operator calls `/admin/register-domain` once to generate a partner authentication token and register the domain with Tesla. This happens on the operator's machine (or in CI) before any end users can log in. After this completes, Tesla recognizes the application's domain as a valid Fleet API partner account.

2. **OAuth workflow (end-user login, happens after Step 4):**
   After partner registration is complete, end users can visit `GET /auth/login` in a browser to authorize their Tesla account. This initiates an OAuth 2.0 authorization code flow with Tesla, redirects the user to Tesla's login page, and stores their credentials locally upon successful return.

**Important:** Partner registration (Step 4) and the OAuth flow are entirely separate. Partner registration is a one-time prerequisite that must complete first; the OAuth flow does not automatically trigger it.

### Completing Tesla partner registration (one-time, manual)

`POST /admin/register-domain` does **not** run automatically — it is not triggered on deploy,
startup, or any schedule. It is a manual, one-time step that an operator (you) must explicitly
call once, after the Worker is deployed and the Tesla Developer Portal app is configured. Nothing
in this repository calls it for you. Here's who does what, and in what order:

1. **You (prerequisites — done before Step 2 below)** ensure:
   - The Worker is deployed and reachable at its stable URL (`https://tesla-powerwall.garlandk.workers.dev`).
   - The Tesla Developer Portal application is configured with the Worker's URL as the Allowed Origin and Allowed Redirect URI.
   - The `.well-known` public key file is being served (it is, by default — `GET /.well-known/appspecific/com.tesla.3p.public-key.pem`).
   - The `TESLA_DOMAIN` var in `wrangler.jsonc` is set to the domain you registered (e.g. `tesla-powerwall.garlandk.workers.dev`).
   - An `ADMIN_API_TOKEN` secret is set locally or via GitHub Actions secrets.

2. **You (one-time, manual partner registration)** call the endpoint once, from your own machine or CI, supplying that admin token to generate a partner authentication token and register the domain with Tesla:
   ```bash
   AUTH_SCHEME="Bearer"
   curl -X POST https://tesla-powerwall.garlandk.workers.dev/admin/register-domain \
    -H "Authorization: ${AUTH_SCHEME} ${ADMIN_API_TOKEN}"
   ```
   This triggers Step 4 of Tesla's registration guide on your behalf.

3. **The Worker** (on receiving that request from you) does the rest automatically, in-process:
   - Verifies the `Authorization` header matches `ADMIN_API_TOKEN`.
   - **Generates a partner authentication token** via a `client_credentials` OAuth 2.0 grant to Tesla's partner auth endpoint, using `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET`.
   - **Calls Tesla's partner registration endpoint** (`POST /api/1/partner_accounts`) with `TESLA_DOMAIN`, completing Step 4 of Tesla's registration guide.
   - Returns Tesla's response (success or error) directly to you, so you can confirm registration succeeded.

4. **End users (after Step 2-3 above)** can now visit `GET /auth/login` in a browser to authorize their Tesla account via OAuth.

You only need to repeat steps 1-3 if Tesla ever requires re-registering the domain (e.g. the domain
changes, or Tesla's partner_accounts records are reset) — it is idempotent to call again.

## Notes for future AI agents

- Read `AGENTS.md` before making changes — it documents security, testing, and architectural rules specific to this repository.
- See `.github/agents/` for specialized personas (`security-expert`, `database-expert`, `devops-expert`) to consult when touching related areas of the code.
- This is a Cloudflare Workers project (edge runtime) — do not introduce Node.js-only built-ins (`fs`, `path`, `child_process`, etc.) into `src/`.


