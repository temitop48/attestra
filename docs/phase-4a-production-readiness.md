# Phase 4A Production Readiness

Date: 2026-11-13

## Executive finding

ATTESTRA is locally feature-complete for the hackathon MVP, but it is not yet
safe to expose publicly. The fastest safe deployment is a two-service,
single-backend-instance arrangement:

1. Next.js on Vercel (or equivalent Next.js host), using a custom frontend
   domain such as `app.example.com`.
2. One persistent Fastify service on Render or Railway, using a sibling API
   domain such as `api.example.com`, a persistent disk/volume, HTTPS, and
   platform-injected secrets.

The sibling subdomains remain same-site for cookie purposes while allowing the
API to set an HttpOnly Secure session cookie and the frontend to call the API
with credentials. `FRONTEND_ORIGIN` must be the exact frontend origin.

The project is not ready to begin Phase 4B until the backend verifier path,
production verification authorization, signer provisioning, and durable
storage configuration are completed.

## Current architecture

- Frontend: Next.js 15.5.29, App Router, React, built with `next build` and
  served with the Next production server.
- Backend: Fastify 5, TypeScript, built with `tsc -p apps/api/tsconfig.json`,
  started with `node apps/api/dist/server.js`.
- Workspace: pnpm monorepo; root commands are `pnpm dev`, `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
- AI: `@attestra/agents` uses an OpenAI-compatible HTTP adapter. The deployed
  provider remains Gemini through configuration; the API key is server-only.
- Chain: read-only NEAR Testnet RPC for state and reconciliation; browser
  wallets sign owner lifecycle calls; backend verifier signing is restricted
  in code to the escrow contract and `submit_verification`.
- Persistence: JSON execution history and a JSON verifier-submission ledger,
  selected by `DATABASE_URL` and colocated ledger path.
- Authentication: NEP-413 wallet challenge/signature verification, an
  HttpOnly session cookie, an in-memory session map, and an eight-hour TTL.
- Build/runtime protection: web development uses a lock file and production
  Next output is isolated from `.next`.

## Confirmed validation

The following completed locally:

- API tests: 54 passed.
- Frontend tests: 25 passed.
- Agent tests: 42 passed.
- Verification tests: 49 passed.
- Orchestrator tests: 22 passed.
- NEAR-readonly tests: 4 passed.
- Shared tests: 2 passed.
- Monorepo typecheck: passed.
- Monorepo lint: passed.
- Monorepo production build: passed.
- Rust escrow tests: 46 passed in the prior settlement investigation.

These are local results only. No public deployment was performed or claimed.

## Blockers

### BLOCKER 1 — Public verifier workflow is not wired to the browser

In production, `/api/v1/executions/:executionId/verify` requires the
server-only `ATTESTRA_VERIFICATION_TOKEN`. The browser API client does not and
must not send that secret. The backend-operated route
`chain/submit-verification` exists, but the frontend client does not expose a
corresponding operation in its normal payment workflow; the current UI still
offers the wallet-based verifier path.

Minimum fix: expose a normal authenticated-owner request to the backend
verifier submission route, keep the token server-only, and add a read-only
reconciliation/status path to the UI. The backend must continue deriving the
receipt and transaction arguments from persisted state.

### BLOCKER 2 — Production signer bootstrap is incomplete

`createVerifierSignerFromEnvironment` accepts a local credential file, but the
secret-reference branch is only documented and is not resolved by a real
secret-manager adapter. A public deployment cannot depend on a developer
filesystem path. The current near-api-js transport also loads a key into an
in-memory key store and does not prove that the configured on-chain key is a
restricted FunctionCall key.

Minimum fix: provision a dedicated verifier account/access key restricted to
the escrow contract and `submit_verification`, resolve it from the hosting
platform’s secret mechanism or a mounted mode-0600 secret file, and verify the
on-chain permission at startup. Do not use a FullAccess key for public
deployment.

### BLOCKER 3 — Local JSON persistence is not suitable for ephemeral or scaled hosting

Execution history and the submission ledger are local files. The code explicitly
describes the ledger as single-writer and local. A restart on an ephemeral
filesystem loses records; two API instances can race and diverge. In-memory
sessions and rate-limit buckets also disappear on restart.

Minimum hackathon fix: use exactly one persistent API instance and mount a
persistent disk/volume at a known path, set `DATABASE_URL` there, and disable
horizontal scaling. A shared transactional database is the post-hackathon
solution. A restart still expires wallet sessions, which is acceptable only if
the judge flow documents reconnecting.

### BLOCKER 4 — Cross-origin production configuration must be explicit

The frontend defaults to `http://localhost:4000`. The API permits one exact
`FRONTEND_ORIGIN` and uses credentialed CORS. Production must inject
`NEXT_PUBLIC_API_BASE_URL` at Next build time and set the API’s exact
`FRONTEND_ORIGIN`; otherwise the browser either calls localhost or receives a
CORS denial. The production cookie is `SameSite=None; Secure`, so HTTPS is
mandatory.

## Important findings

- The API local environment loader is development-oriented. Production should
  use platform environment injection; it must not depend on `.env.local` or a
  repository-relative credential path.
- NEP-413 authentication checks the signed key as finalized FullAccess. This is
  appropriate for user wallet authentication but should not be confused with
  the backend verifier signer. The verifier signer needs a restricted
  FunctionCall key, while owner wallets remain user-controlled.
- `chain/intent` derives contract, method, IDs, receipt, recipient, budget, and
  deposits from backend state. Browser-supplied arbitrary contract calls are
  rejected.
- Backend verifier submission validates the passing receipt, immutable digest,
  exact Testnet contract linkage, project/milestone, owner, recipient, budget,
  replay key, and finalized chain state.
- Transaction hashes are not treated as success. Reconciliation is required.
- The in-memory rate limiter is adequate for a single MVP instance but is not a
  distributed abuse-control system.
- CORS currently allows one origin and does not support a list of judge/demo
  origins. Use one stable public frontend origin for the hackathon.
- The health route is `/health`; it must be used as the platform health check.
- No privileged private key is sent to the browser by the inspected code.
- No API route was found that accepts arbitrary verifier receipt payloads or
  arbitrary contract method calls, but the public verifier route must be
  exposed through the intended owner-authenticated UI before deployment.

## Environment inventory

### Frontend build-time variables

- `NEXT_PUBLIC_API_BASE_URL` — public Fastify base URL; not a secret.

### Backend runtime variables

- `NODE_ENV`, `HOST`, `PORT` or `API_PORT`.
- `FRONTEND_ORIGIN`.
- `DATABASE_URL` — persistent execution JSON path for the MVP, or database URL
  after a persistence upgrade.
- `ATTESTRA_LLM_API_KEY` — secret Gemini-compatible provider key.
- `ATTESTRA_LLM_BASE_URL`, `ATTESTRA_LLM_MODEL`,
  `ATTESTRA_LLM_TIMEOUT_MS`, `ATTESTRA_LLM_MAX_RETRIES`.
- `NEAR_NETWORK=testnet`, `NEAR_RPC_URL`,
  `NEAR_ESCROW_CONTRACT_ACCOUNT`, `NEAR_AUTH_RECIPIENT`.
- `NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID`.
- `ATTESTRA_NEAR_SIGNER_SECRET_REF` or an approved mounted credential-file
  reference after the production signer adapter is completed.
- `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO`,
  `NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO`,
  `NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO`.
- `NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO` and
  `NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO`.
- `ATTESTRA_VERIFICATION_TOKEN` only if the protected verification endpoint is
  retained for an operator/service call; never expose it to Next.js.

Do not configure secrets with `NEXT_PUBLIC_` prefixes.

## Recommended hosting arrangement

Vercel is a practical fit for the existing Next.js app and documents native
Next.js deployment and environment injection. See [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)
and [Vercel environment variables](https://vercel.com/docs/environment-variables).

Run the API as one persistent web service on Render or Railway. Render’s
documentation states that persistent disks can be attached to web services,
and that disk-backed services are a paid capability; verify current plan and
pricing before choosing it. See [Render persistent disks](https://render.com/docs/disks).
Railway is an equivalent operational option if the operator already has an
account and a volume available; its current pricing and volume behavior must be
verified in the operator account before selection.

This arrangement avoids putting the Fastify process in serverless functions,
keeps the JSON ledger on durable storage, and preserves a simple single-writer
model for the deadline.

## Deployment sequence

### 4B.1 — Fix critical production blockers

Tasks:

1. Add the frontend call for backend verifier submission and reconciliation;
   do not expose a token or receipt payload.
2. Implement production signer secret resolution and startup validation of the
   signer account/key permission.
3. Mount durable storage and set `DATABASE_URL` to the mounted path.
4. Add a production configuration check that rejects localhost API origins,
   missing HTTPS origin, missing signer, missing Gemini key, and invalid NEAR
   deposits before accepting judge traffic.
5. Add tests for the backend-verifier browser path, restart persistence, and
   restricted signer permission.

Expected files: `apps/api/src/verifier-bootstrap.ts`,
`apps/api/src/near-signing-transport.ts`, `apps/api/src/app.ts`,
`apps/web/src/lib/api.ts`, `apps/web/src/components/payment-lifecycle-panel.tsx`,
and corresponding API/web tests.

Validation:

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm build
cargo test --manifest-path contracts/escrow/Cargo.toml
```

Completion: a fresh authenticated owner can request backend verification,
observe pending/finalized reconciliation, and no browser bundle or request can
provide a signer credential or arbitrary call.

### 4B.2 — Configure hosting and environment

Tasks:

1. Create the frontend and API hosting projects.
2. Assign one HTTPS frontend origin and one sibling HTTPS API origin.
3. Attach a persistent API disk/volume and set its absolute data path.
4. Inject all backend variables through the host secret manager.
5. Inject `NEXT_PUBLIC_API_BASE_URL` before the frontend build.
6. Configure API health check `/health`.
7. Configure `FRONTEND_ORIGIN` to the exact frontend origin.
8. Confirm backups or at least a downloadable copy of the JSON MVP data before
   any redeploy.

Expected operator actions: hosting account access, domain/DNS access, Gemini
key, verifier secret provisioning, and NEAR restricted-key provisioning.

### 4B.3 — Deploy and smoke-test

Suggested commands/configuration:

Frontend build:

```text
pnpm install --frozen-lockfile
pnpm --filter @attestra/web build
```

API build/start:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @attestra/api start
```

Run only one API instance for the JSON ledger. Verify `/health`, CORS,
`/api/v1/near/config`, authenticated `/api/v1/auth/me`, execution listing,
artifact retrieval, and verifier readiness without submitting a transaction.

Completion: public `/workspace` loads, the API is reachable over HTTPS, the
wallet can authenticate, and all persisted records survive an intentional API
restart.

### 4C — Fresh-wallet judge test

1. Use a fresh judge NEAR Testnet wallet and authenticate through NEP-413.
2. Confirm the header and workspace show the same authenticated account.
3. Run one real Gemini-backed execution; do not use demo mode.
4. Inspect Research, Builder, QA, artifact digest, and QA evidence.
5. Request independent verification through the production backend path.
6. Reconcile and display the finalized verification receipt.
7. Use the owner wallet for explicit approval.
8. Reconcile approval finality.
9. Use the owner wallet for explicit settlement with the contract-verified
   storage deposit for the actual recipient.
10. Wait for callback-confirmed `Paid`; never use a hash alone as evidence.

The judge test must use a fresh project/milestone if the judge is expected to
perform writes. The completed local project 0/milestone 0 is evidence of the
development payment, not a reusable public test fixture.

## Security posture

The most important security risk is privileged verifier signing in a public
backend. A compromised or over-privileged signer could submit verification
receipts and authorize downstream payment. Use a dedicated account/key with a
FunctionCall restriction to the exact escrow contract and
`submit_verification`; keep owner approval and settlement wallet-controlled.

The second major risk is local-file persistence on an ephemeral or multi-instance
host. Until a transactional shared store exists, use one persistent API
instance and treat restart/reconciliation as an operational event.

## Effort estimate

- Critical off-chain wiring and production checks: approximately half to one
  engineering day, depending on secret-manager access.
- Hosting and HTTPS configuration: approximately one to three hours once
  accounts/domains are available.
- Fresh-wallet judge test and submission capture: approximately one hour,
  assuming Gemini quota and NEAR Testnet balances are available.

These are implementation estimates, not guarantees; hosting account access and
credential provisioning are the main external dependencies.

## Submission gate

Before submission, complete the backend verifier browser path, provision and
validate a restricted signer, place the API on durable storage, configure exact
production origins, and pass one fresh-wallet public end-to-end test. Do not
represent the local successful payment as public deployment evidence until that
test is finalized and captured.
