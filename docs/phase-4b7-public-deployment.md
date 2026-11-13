# Phase 4B.7 Public Deployment Preparation

Date: 2026-11-13

## Readiness summary

The Vercel + Render topology is prepared but has not been publicly deployed. The chain upgrade and restricted verifier key are finalized. Local production-mode API startup succeeds with the restricted credential.

One configuration inconsistency remains: `.env.local` contains `NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=640000000000000000000`, while an older runtime note records `510000000000000000000`. This report does not guess. The operator must confirm the reviewed settlement amount before production configuration.

## Architecture and runtime findings

- Frontend: Next.js 15.5.29 App Router in `apps/web`.
- Backend: Fastify 5 TypeScript service in `apps/api`.
- Workspace: pnpm 10.12.4 monorepo.
- AI: server-only Gemini through the OpenAI-compatible endpoint.
- Chain: NEAR Testnet; owner-wallet lifecycle calls and backend restricted verifier submission.
- Storage: atomic JSON execution store plus `verification-submissions.json` in the same directory.
- Concurrency: one API instance and a filesystem single-writer lock.
- Health endpoint: `GET /health`.
- Authentication: NEP-413 plus HttpOnly session cookie and credentialed exact-origin CORS.

The API uses `HOST` (default `0.0.0.0`) and `API_PORT ?? PORT` (default `4000`), so Render's injected `PORT` is supported. Production validation requires an explicit HTTPS `FRONTEND_ORIGIN`, real Gemini credentials, Testnet NEAR settings, and durable storage. The frontend uses `NEXT_PUBLIC_API_BASE_URL`, sends credentials, and rejects a missing or localhost URL in production.

## Runtime correction made

The initial production smoke test failed closed because NEAR's single-key RPC returns:

```json
{ "permission": { "FunctionCall": { "receiver_id": "...", "method_names": [...] } } }
```

The adapter only handled the inner object shape. The smallest fix was applied in `packages/near-readonly/src/index.ts` to unwrap `FunctionCall`, with a regression test in `packages/near-readonly/test/index.test.ts`. After rebuilding the package and API, production smoke reported:

```text
signerConfigured: true
configurationError: null
GET /health: status ok
verifier-status: configured true, verifier.attestra-owner.testnet
near/config: testnet, escrow.attestra-owner.testnet, verification deposit 0
```

No blockchain transaction was made during this task.

## Sanitized backend environment template

Configure these in Render. Never commit populated values.

```text
NODE_ENV=production
HOST=0.0.0.0
# Render supplies PORT; do not set API_PORT unless intentionally overriding it.
PORT=<Render-injected-port>
FRONTEND_ORIGIN=https://<public-vercel-origin>
DATABASE_URL=/var/data/attestra/executions.json

ATTESTRA_DEMO_MODE=false
ATTESTRA_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
ATTESTRA_LLM_MODEL=gemini-3.1-flash-lite
ATTESTRA_LLM_TIMEOUT_MS=120000
ATTESTRA_LLM_MAX_RETRIES=1
ATTESTRA_LLM_API_KEY=<Render-secret>

NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
NEAR_AUTH_RECIPIENT=<stable-auth-recipient>
NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO=3000000000000000000000
NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO=5000000000000000000000
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=0
NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO=330000000000000000000
NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=<operator-confirmed-reviewed-value>

ATTESTRA_REQUIRE_RESTRICTED_VERIFIER_KEY=true
ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE=/etc/secrets/verifier.attestra-owner.testnet.restricted.json
```

Secrets intentionally omitted: `ATTESTRA_LLM_API_KEY`, restricted verifier credential contents, and any optional `ATTESTRA_VERIFICATION_TOKEN`. The current secret-reference variable is documented but not resolved by a secret-manager adapter; use a host-provided secret file or implement a reviewed adapter. Never use `NEAR_VERIFIER_PRIVATE_KEY` or expose the key to the frontend.

## Persistent storage

Attach a Render disk mounted at `/var/data` and set:

```text
DATABASE_URL=/var/data/attestra/executions.json
```

Required durable files:

```text
/var/data/attestra/executions.json
/var/data/attestra/verification-submissions.json
/var/data/attestra/executions.json.lock
```

Temporary atomic-write files are also created in that directory. Execution history, artifacts, verification receipts/attempts, submission idempotency states, hashes, and reconciliation outcomes persist there. The API uses mode `0700` for the directory, mode `0600` for files, and rejects a second writer.

Wallet sessions and rate-limit buckets are intentionally in memory. A restart expires sessions; judges must reconnect. They are not advertised as durable state.

Render documents that default service filesystems are ephemeral and persistent disks are available for paid web services; only data under the configured mount survives. Verify current plan eligibility and pricing in the operator account. [Render persistent disks](https://render.com/docs/disks)

## Render backend setup

These steps require Render account access:

1. Create one Web Service from the repository, using the repository root.
2. Select a paid plan that permits a persistent disk and attach one at `/var/data`.
3. Add a Render Secret File for the restricted credential at `/etc/secrets/verifier.attestra-owner.testnet.restricted.json`; do not place it in the repository or data disk.
4. Configure the backend variables above and resolve the settlement deposit discrepancy.
5. Build with:

```text
pnpm install --frozen-lockfile && pnpm build
```

The recursive build is important because it rebuilds workspace packages before the API. The minimal backend build is:

```text
pnpm install --frozen-lockfile && pnpm --filter @attestra/near-readonly build && pnpm --filter @attestra/api build
```

6. Start with `pnpm --filter @attestra/api start`.
7. Set health check path `/health`.
8. Keep exactly one instance while using JSON persistence.
9. Verify `GET /health`, `/api/v1/near/config`, and `/api/v1/near/verifier-status`. Readiness must show Testnet, the deployed contract, the authorized verifier, verification deposit `"0"`, and `configured: true`, without secret material.

Render documents secret files and persistent disks; current plan/pricing remains an operator-account check. [Render environment variables and secret files](https://render.com/docs/configure-environment-variables)

## Vercel frontend setup

These steps require Vercel account access:

1. Import the repository as a Vercel project.
2. Keep the repository root as the project root so pnpm workspace dependencies and the lockfile are available.
3. Use Next.js, install with `pnpm install --frozen-lockfile`, and build with `pnpm --filter @attestra/web build`.
4. If workspace package output is stale in an isolated build, use root `pnpm build` so dependencies rebuild before the web app.
5. Set only this browser-visible variable:

```text
NEXT_PUBLIC_API_BASE_URL=https://<render-api-host>
```

6. Do not add Gemini keys, verifier credentials, NEAR private keys, or other server secrets to Vercel.
7. Deploy and verify `https://<vercel-origin>/workspace`.

Vercel supports pnpm monorepos and configurable project root/build settings. [Vercel monorepo guidance](https://vercel.com/docs/monorepos), [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build)

## Security validation

Confirmed in source and tests:

- FullAccess verifier keys are rejected in production restricted-key mode.
- FunctionCall receiver and method list are checked exactly.
- Restricted transport rejects nonzero verification deposits.
- Receipt, digest, execution, chain, owner, recipient, budget, network, and contract linkage remain validated.
- Persistent idempotency and single-writer protection remain active.
- Browser requests cannot provide signer credentials, receipt payloads, or arbitrary contract calls.
- CORS allows only the exact configured frontend origin.
- Production cookies are HttpOnly, Secure, and `SameSite=None`.
- Health/config/readiness responses do not expose private keys.

## Validation

- API tests: **62 passed**.
- Frontend tests: **26 passed**.
- Agent tests: **42 passed**.
- Verification tests: **49 passed**.
- Orchestrator tests: **22 passed**.
- near-readonly tests: **5 passed**, including the permission-wrapper regression.
- Shared tests: **2 passed**.
- API build: **passed**.
- Workspace typecheck: **passed**.
- Workspace lint: **passed**.
- Next production build: **passed**; `/workspace` generated.
- Local production API smoke: **passed** after rebuilding near-readonly; restricted signer configured and health/readiness/config endpoints succeeded.

## Operator deployment and smoke-test sequence

1. Resolve the settlement deposit value and record the decision.
2. Create the Render service, paid persistent disk, and restricted secret file.
3. Configure backend variables with demo mode disabled.
4. Deploy the API and verify health, CORS, near config, verifier readiness, and persistence after one restart.
5. Create the Vercel project at repository root with `NEXT_PUBLIC_API_BASE_URL`.
6. Deploy the frontend and open `/workspace`.
7. Connect a fresh NEAR Testnet wallet and verify NEP-413 authentication.
8. Run one real Gemini-backed execution; do not reuse the paid historical milestone as a new fixture.
9. Inspect the artifact and independent verification.
10. Request backend verification and reconcile finalized evidence.
11. Use the owner wallet for explicit approval and settlement; verify final chain state.

## Final assessment

- Backend deployment readiness: **prepared and locally production-smoke-tested; not publicly deployed**.
- Frontend deployment readiness: **build-ready; not publicly deployed**.
- Render: one paid persistent web service, `/var/data` disk, restricted secret file, `/health`, one instance.
- Vercel: repository-root pnpm project, web build, `NEXT_PUBLIC_API_BASE_URL` only.
- Remaining manual actions: resolve settlement deposit, provision hosting/disk/secrets/domains, deploy, restart-test persistence, and run the fresh-wallet smoke test.
- Public deployment status: **not ready to claim publicly deployed until the operator completes the actual hosting deployment and end-to-end smoke test**.
