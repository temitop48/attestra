# Phase 4B.8 — Free Hosting Persistence and Deployment

Date: 2026-11-13

## Executive result

PostgreSQL persistence is implemented as a production adapter. Local development
still uses the existing JSON adapter. Production startup now requires a
`postgres://` or `postgresql://` `DATABASE_URL`; it will not silently fall back
to an ephemeral JSON file.

The backend and frontend builds pass locally, and the full workspace test suite
passes. No public service was deployed and no blockchain transaction was made.
The application is not yet publicly deployed: the operator must provision
Supabase, Render, and Vercel and complete a real HTTPS smoke test.

## Persistence inventory

Runtime durable state was previously split across:

- `apps/api/.data/executions.json`: execution metadata, agent lifecycle, research,
  builder revisions, QA assessments, final artifacts, verification attempts and
  receipts, payment eligibility, and authoritative on-chain linkage.
- `apps/api/.data/verification-submissions.json`: the verifier submission
  idempotency ledger, including pending, finalized, failed, and unknown outcomes.
- `apps/api/.data/*.lock`: the local single-writer lock; it is a process guard,
  not application data.
- `.data/near-testnet-deployment-report*.json` and `.data/rollback/*.wasm` are
  deployment/release evidence, not runtime API state and must be archived
  separately from the production database.

Authentication challenges, sessions, rate-limit buckets, and in-flight maps are
currently in memory. They are intentionally not persisted as durable business
records. A Render restart invalidates sessions and rate-limit state; the user
must authenticate again. The verifier submission ledger and execution records
are the records required for safe restart/reconciliation and are now stored in
PostgreSQL in production.

## Implementation

Changed or added:

- `apps/api/src/postgres-persistence.ts`: transactional PostgreSQL-backed
  execution and verifier-submission stores. Records retain their existing JSON
  shapes and identifiers in `jsonb` columns. Submission reservation uses a
  database primary key and `ON CONFLICT DO NOTHING`, preventing duplicate
  reservations across requests and restarts.
- `apps/api/src/store.ts` and `apps/api/src/verifier-submission-store.ts`:
  exported store interfaces so the API can use either backend without changing
  route behavior.
- `apps/api/src/server.ts`: production requires PostgreSQL and selects the PG
  adapter; local development retains JSON plus the existing filesystem lock.
- `apps/api/migrations/001_persistence.sql`: minimum schema and indexes.
- `apps/api/test/postgres-persistence.test.ts`: fail-closed configuration,
  database failure, and migration/idempotency schema regression coverage.
- `.env.example`: separates local JSON (`ATTESTRA_DATA_DIR`) from production
  PostgreSQL configuration.

The database is server-only. No `DATABASE_URL` or database credential is read
by Next.js or included in a browser bundle. A database connection failure at
startup terminates the API rather than switching to temporary storage.

## Supabase setup

1. Create a Supabase project in the operator's account.
2. Copy the **direct or session-pooler PostgreSQL connection string** from the
   Supabase database connection panel. Store it only as a Render secret named
   `DATABASE_URL`. Do not put it in `.env.example`, Vercel, or the browser.
3. Apply the migration from the repository using a trusted `psql` client:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/001_persistence.sql
   ```

   The command must be run with `DATABASE_URL` supplied only in the operator's
   protected shell/secret manager. Do not paste the URL into source control.
4. Confirm both tables exist before starting Render. The API expects the
   migration to have been applied; it does not silently create a partial schema
   at runtime.
5. For a Supabase certificate/connection setup that requires it, set
   `DATABASE_SSL=true`. Prefer certificate verification. Only use
   `DATABASE_SSL_REJECT_UNAUTHORIZED=false` if the selected Supabase connection
   method requires it and the operator has accepted that platform-specific TLS
   limitation.

The JSON files are not automatically imported. If the historical local records
are needed in the public instance, perform a separately reviewed, one-time
operator migration from a protected backup. Do not overwrite or reinterpret
historical records. The current free-hosting implementation deliberately does
not fabricate or auto-import them.

## Render Free backend configuration

Create one Render Web Service from the repository. Use exactly one instance;
do not enable horizontal scaling for this file-independent MVP. Render's free
filesystem is ephemeral, so all runtime durable state must be Supabase data.

Build command:

```bash
corepack pnpm install --frozen-lockfile && corepack pnpm --filter @attestra/api build
```

Start command:

```bash
node apps/api/dist/server.js
```

The server binds `0.0.0.0` and uses Render's `PORT` automatically when
`API_PORT` is absent. Health check path: `/health`.

Required non-secret Render variables:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=<provided by Render; do not hardcode>
FRONTEND_ORIGIN=https://<vercel-production-domain>
DATABASE_URL=<Render secret: Supabase PostgreSQL URL>
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true

NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO=<reviewed value>
NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO=<reviewed value>
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=0
NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO=<reviewed value>
NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=<reviewed value>

ATTESTRA_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
ATTESTRA_LLM_MODEL=<operator-verified Gemini model>
ATTESTRA_LLM_TIMEOUT_MS=120000
ATTESTRA_LLM_MAX_RETRIES=1
ATTESTRA_DEMO_MODE=false
NEAR_AUTH_RECIPIENT=attestra.app
```

Secrets injected only into Render:

```text
ATTESTRA_LLM_API_KEY=<Gemini secret>
ATTESTRA_NEAR_SIGNER_CREDENTIAL_PATH=<restricted verifier credential path or mounted secret reference>
ATTESTRA_VERIFICATION_TOKEN=<optional operator-only token, if used>
```

The verifier credential must be the restricted FunctionCall key for
`verifier.attestra-owner.testnet`, receiver `escrow.attestra-owner.testnet`,
method list exactly `submit_verification`, and zero attached deposit. Production
startup/reconciliation must reject FullAccess verifier credentials. Do not put
the credential in Vercel. If Render cannot mount a mode-0600 secret file,
configure the existing server-side secret-reference mechanism supported by the
repository; never paste a private key into a public or frontend variable.

## Vercel Hobby frontend configuration

Create a Vercel project with the repository root set to the repository root
(`.`), so pnpm can resolve the workspace packages. The workspace package
manager is pnpm; the Next app remains `apps/web`.

Install command:

```bash
corepack pnpm install --frozen-lockfile
```

Build command:

```bash
corepack pnpm --filter @attestra/web build
```

Required Vercel variable:

```text
NEXT_PUBLIC_API_BASE_URL=https://<render-service-domain>
```

Only `NEXT_PUBLIC_API_BASE_URL` is public. Do not configure Gemini, database,
NEAR signer, verifier private key, or operator tokens in Vercel. After obtaining
the final Vercel origin, set the exact same origin as Render's
`FRONTEND_ORIGIN`; avoid a trailing slash and do not use wildcard CORS.

## Security and free-tier limitations

- HTTPS origins are required in production. The API uses exact-origin
  credentialed CORS and HttpOnly Secure/SameSite cookies.
- A Render Free instance may sleep or restart. The first request may be slow,
  and in-memory sessions expire on restart. Judges must reconnect/authenticate
  after a restart.
- AI execution is asynchronous. A sleep/restart can interrupt an in-progress
  execution; startup recovery marks queued/running execution as interrupted,
  preserving the record rather than silently restarting it. A new execution
  requires an explicit user action.
- NEAR submission idempotency survives restarts in PostgreSQL. A pending or
  unknown submission must be reconciled from finalized NEAR RPC before any
  further attempt; the service must not rebroadcast merely because a process
  restarted.
- The MVP remains single-instance. PostgreSQL protects the submission key and
  database writes, but the API's in-memory execution cache and session maps
  make horizontal scaling out of scope.
- Supabase Free quotas, connection limits, pausing, and Render/Vercel plan
  limits are external platform conditions and must be checked in the operator
  accounts before the public test. No free-tier availability or quota is
  guaranteed by this repository.

## Validation performed

Passed locally:

- `pnpm test`: all workspace suites passed — 210 tests total (web 26, agents
  42, near-readonly 5, shared 1, orchestrator 22, verification 49, API 65).
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed; Next.js `/workspace` was included in the production
  build.
- `cargo test --manifest-path contracts/escrow/Cargo.toml`: 48 Rust tests
  passed.

The PostgreSQL integration tests run without a live database by validating
fail-closed connection selection, unreachable-database behavior, and the
migration constraints. A real Supabase restart/recovery test remains an
operator deployment check because no Supabase credentials or database were
provided for this task.

## Manual deployment sequence

1. Operator creates Supabase project, applies the migration, and verifies
   tables.
2. Operator creates one Render Web Service, injects the backend variables and
   restricted verifier secret, and deploys.
3. Operator checks `https://<render-domain>/health`, then verifies
   `/api/v1/near/status` and `/api/v1/near/verifier-status` contain no secret
   material. Confirm the API is using PostgreSQL and that a restart does not
   lose records.
4. Operator creates Vercel project, sets `NEXT_PUBLIC_API_BASE_URL`, deploys,
   and records the final HTTPS origin.
5. Operator updates Render `FRONTEND_ORIGIN` to that exact Vercel origin and
   redeploys/restarts the API.
6. From a fresh browser session, connect a NEAR Testnet wallet, authenticate,
   create a real execution, inspect the artifact, run independent verification,
   and confirm the backend verifier endpoint produces only a validated receipt.
7. Have the owner explicitly approve and settle through the wallet. Verify
   finalized NEAR state and payment evidence from the application.
8. Keep an operator backup of the Supabase database and deployment evidence;
   never commit secrets or export verifier keys to the frontend.

## Remaining blockers

The code change is complete, but public deployment is not yet claimed ready.
Remaining operator-controlled checks are:

1. Supabase project and migration provisioning.
2. Secure restricted-verifier credential injection into Render and a successful
   startup permission check.
3. Verified Gemini API key/model configuration and quota.
4. Render/Vercel account setup, exact origin configuration, and HTTPS smoke
   test.
5. A real restart/reconciliation check against the provisioned Supabase
   database.

The smallest safe path remains one Render backend instance plus Supabase
PostgreSQL and one Vercel frontend. No contract change or blockchain write is
required for this persistence migration.
