# Agent Execution Rules & Security Protocols

You are an automated coding agent developing and maintaining the **tesla-powerwall** OAuth &amp; Public Key Worker. This service runs on Cloudflare Workers and is responsible for Tesla's developer domain verification, the OAuth 2.0 authorization flow, and persisting Tesla Powerwall/Energy API credentials in Cloudflare D1. You must strictly adhere to the following operational, architectural, and security guidelines on every modification.

> **Reference:** [Tesla Fleet API — What is Fleet API?](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api) — the authoritative guide for the registration steps (public key domain verification at step 3, partner token signing at step 4, and OAuth) that this service implements. Consult this link for authoritative context on why each route and secret exists.

## 1. Security First
- **No Hardcoded Secrets:** Never hardcode `TESLA_CLIENT_SECRET`, access tokens, refresh tokens, or the real Tesla public key PEM in the repository. Access them via Cloudflare Worker bindings (`c.env`) configured through `wrangler secret put` (secrets) or `vars` (non-secret config).
- **CSRF Protection:** The `state` parameter generated in `/auth/login` and validated in `/auth/callback` is the primary CSRF defense for the OAuth flow. Never remove or weaken this check, and always delete/invalidate a `state` row after it has been consumed.
- **Input Validation:** Validate all query parameters (`code`, `state`) before using them. Never interpolate untrusted input directly into SQL — always use D1's parameterized `prepare().bind()` API.
- **Token Handling:** Treat `access_token` and `refresh_token` values as secrets in logs and error messages. Never log full token values.

## 2. Test Execution Mandate
- **Run Tests Before Commit:** Before proposing changes, finalizing tasks, or committing code, you MUST run `npm run lint`, `npm run typecheck`, and `npm test`.
- **Zero Regression Policy:** Never mark a task as complete if any existing test fails. If a feature modification breaks existing tests, update or add tests to reflect the intended behavior.
- **Add Tests for New Features:** Every new route or business logic addition must be accompanied by unit tests in `/tests` using `@cloudflare/vitest-pool-workers`, mocking outbound Tesla API calls (never call real Tesla endpoints from tests).

## 3. Edge Runtime Constraints (Cloudflare Workers)
- **Runtime Compatibility:** This application runs on the Cloudflare Workers V8 runtime. Do NOT use Node.js native built-ins (such as `fs`, `path`, or `child_process`) in `src/`.
- **Database Access:** Access Cloudflare D1 exclusively through the `DB` binding (`c.env.DB`). Never attempt direct filesystem SQLite access. Schema changes must be added as new numbered files under `migrations/`, never edited in place once merged.

## 4. Code Quality & Architecture
- **Type Safety:** Maintain strict TypeScript types across `src/`. Avoid `any`. Keep the `Env` interface in `src/index.ts` in sync with `wrangler.jsonc` bindings.
- **Framework:** Routing is implemented with [Hono](https://hono.dev/). Keep new routes small and focused; extract shared logic into helper functions rather than duplicating it across handlers.

## 5. Environment-Specific Configuration
- **No Hardcoded Environment Values:** Never hardcode environment-specific, non-secret values (URLs, hostnames, feature flags, etc.) directly in application code. Source them from `c.env` (`vars` in `wrangler.jsonc`, or GitHub Actions `vars`/`secrets` for CI/CD).
- **Secrets:** Store credentials (`TESLA_CLIENT_SECRET`, Cloudflare API tokens) exclusively in `wrangler secret` or GitHub Actions secrets. Never place secrets in `vars`, `wrangler.jsonc`, or source code.

## Specialized Agent Directory

- **`@security-expert`** (`.github/agents/security-expert.agent.md`): Audits code for OWASP Top 10 vulnerabilities, scans for hardcoded secrets, and proposes secure patches.
- **`@database-expert`** (`.github/agents/database-expert.agent.md`): Reviews D1 schema and migrations, enforcing zero-data-loss and additive-only migration rules.
- **`@devops-expert`** (`.github/agents/devops-expert.agent.md`): Manages Cloudflare Workers infrastructure, Wrangler bindings, GitHub Actions CI/CD pipelines, and secrets.

### Routing Guidelines
* When editing `wrangler.jsonc`, `.github/workflows/`, or environment secrets, invoke `@devops-expert`.
* When editing `migrations/` or SQL queries, invoke `@database-expert`.
* When editing OAuth, token handling, or the public key endpoint, invoke `@security-expert`.
