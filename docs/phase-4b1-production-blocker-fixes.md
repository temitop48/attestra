# Phase 4B.1 production blocker fixes

Date: 2026-11-13

## Executive result

Three off-chain blockers were addressed without changing the NEAR contract or any historical execution, receipt, or payment record. The application is not yet deployment-ready because the deployed `submit_verification` method requires a positive attached storage deposit, while a NEAR FunctionCall access key cannot attach a positive deposit. A public backend therefore cannot safely use a restricted FunctionCall key for this contract. Publishing the existing FullAccess verifier credential would be an unacceptable security decision and was not done.

## Files changed

- `apps/web/src/lib/api.ts`: added typed backend verifier submission and reconciliation calls; production API URL validation rejects an omitted or localhost URL.
- `apps/web/src/components/payment-lifecycle-panel.tsx`: the owner-facing verification action now calls the authenticated backend submission boundary, displays pending/reconciliation/failure states, and no longer instructs users to connect the verifier wallet. Approval and settlement remain explicit wallet actions.
- `apps/api/src/app.ts`: execution records now retain the authenticated creator account; production verification writes may be requested only by that creator or the linked on-chain owner, while the existing operator-token path remains supported.
- `apps/api/src/store.ts`: added the optional `createdByAccountId` field without changing the persisted version or historical records.
- `apps/api/src/persistence.ts`: added configurable storage-path resolution, private directory preparation, and a single-writer lock for the API process.
- `apps/api/src/server.ts`: added sanitized production configuration validation and acquires/releases the persistent-storage lock around the server lifecycle.
- `apps/api/test/persistence.test.ts`: verifies configurable storage and duplicate-writer rejection.
- `apps/web/test/api.test.ts`: verifies the browser calls the authenticated backend verifier endpoint, not a wallet-supplied contract call.

## Blocker 1 — browser-operated verification

The existing API route `POST /api/v1/executions/:executionId/chain/submit-verification` already validates the backend-generated passing receipt, exact execution/artifact linkage, Testnet contract linkage, durable idempotency record, and finalized reconciliation. It authorizes the request using the authenticated linked project owner. The frontend previously bypassed this route and constructed a direct `submit_verification` wallet transaction requiring the authorized verifier account.

The payment panel now uses the backend route and its reconciliation route. The browser cannot provide receipt arguments or an arbitrary contract call. The UI shows backend submission, reconciliation, finalized, and failure states. Owner approval and settlement still require an explicit owner wallet confirmation.

Independent verification requests are also no longer disabled solely because the bundle is production. The API requires the authenticated execution creator or linked owner for browser verification writes; operator token authorization remains available for controlled operations. Historical records without creator metadata are not retroactively assigned an owner.

## Blocker 2 — signer security decision

The deployed Rust contract marks `submit_verification` payable and measures the storage delta caused by the receipt, then requires an attached deposit at least equal to that delta. It also requires the predecessor to equal the configured authorized verifier. This is not a one-yocto call.

NEAR FunctionCall access keys cannot attach a positive deposit. Consequently, a restricted FunctionCall key cannot submit the current deployed method. The backend signer remains restricted at the application layer to the exact escrow receiver, `submit_verification`, passing receipts, validated IDs/digest, gas, deposit, and idempotency key, but that application restriction does not make a FullAccess key safe for an internet-facing service.

No key rotation, contract upgrade, or live transaction was performed. The remaining security decision is operator-controlled: either keep the verifier submission as a trusted, tightly isolated operator service using an appropriately protected credential, or change/deploy a future contract design that permits a restricted-key workflow. Do not publish the existing FullAccess credential on a general public server.

The existing positive-deposit receipt is therefore not declared publicly deployable until this signer decision is resolved.

## Blocker 3 — persistence

`DATABASE_URL` remains the preferred file path. If it is absent, `ATTESTRA_DATA_DIR` selects the directory and the API uses `executions.json` there; the verifier ledger remains colocated as `verification-submissions.json`. Existing atomic temporary-file-plus-rename writes are preserved. The API now creates/checks the directory, applies directory mode `0700` and file mode `0600` where applicable, and fails startup if it cannot read/write the directory.

The API now holds a lock beside the execution file and refuses a second writer. This intentionally preserves the current file-based architecture and makes the single persistent instance requirement explicit. A deployment must use one persistent backend instance and a durable volume; ephemeral filesystem storage is not acceptable for executions, verification attempts, or transaction reconciliation.

## Blocker 4 — origins and authentication

The API already used exact-origin credentialed CORS rather than wildcard CORS. Production startup now requires one explicit HTTPS `FRONTEND_ORIGIN`, real Gemini credentials, Testnet NEAR configuration, and durable storage configuration. The frontend now rejects an omitted or localhost `NEXT_PUBLIC_API_BASE_URL` in production. Browser requests continue to use `credentials: include`; production sessions remain HttpOnly, Secure, and `SameSite=None` for the separate Vercel/Render origins.

Required non-secret environment variables include:

```text
NODE_ENV=production
FRONTEND_ORIGIN=https://<frontend-domain>
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>
ATTESTRA_DATA_DIR=/var/lib/attestra        # or DATABASE_URL=/var/lib/attestra/executions.json
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=<deployed-contract>
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=<authorized-verifier>
NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO=<reviewed-value>
NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO=<reviewed-value>
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=<reviewed-value>
NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO=<reviewed-value>
NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=<reviewed-value>
ATTESTRA_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
ATTESTRA_LLM_MODEL=<verified-Gemini-model>
ATTESTRA_LLM_TIMEOUT_MS=<bounded-timeout>
ATTESTRA_LLM_MAX_RETRIES=<bounded-retry-count>
```

Secrets are intentionally omitted: `ATTESTRA_LLM_API_KEY`, the server-only verifier credential/secret reference, and any operator verification token must be injected by the hosting secret manager. No secret is accepted by the frontend, and raw `NEAR_VERIFIER_PRIVATE_KEY` configuration remains rejected.

## Tests and validation

Passed after the changes:

- API tests: 55 passed across 8 files, including storage bootstrap/lock coverage.
- Frontend tests: 26 passed across 3 files, including backend verifier API coverage.
- API TypeScript build: passed (`pnpm --filter @attestra/api build`).
- API lint/typecheck: passed.
- Frontend lint: passed.
- Focused API and frontend typechecks: passed.

The full Next.js production build was invoked against the isolated `.next-production` directory but did not emit progress or complete in the available validation window. It must be rerun successfully before deployment. The focused test suites were not allowed to alter blockchain state. No Rust source changed in this phase; the previously recorded contract baseline was 46 Rust tests passing, but a fresh Rust command in this environment did not return usable completion output and is not claimed as a new pass.

## Remaining blockers

1. Critical: choose and operationally secure the verifier signing model. A restricted FunctionCall key cannot satisfy the current positive-deposit method. Do not deploy FullAccess signing material publicly without explicit risk acceptance and isolation.
2. Critical: complete a successful isolated Next production build and a real deployment smoke test.
3. Important: configure a durable Render volume/path and confirm restart recovery with the lock and both JSON ledgers.
4. Important: configure the verified Gemini model/key and production HTTPS origins in the hosting platforms.

## Production sequence after blocker resolution

1. Provision one persistent backend instance and durable volume; inject secrets through the host, not source or browser variables.
2. Set exact Vercel `NEXT_PUBLIC_API_BASE_URL` and backend `FRONTEND_ORIGIN`; verify CORS and wallet session cookies over HTTPS.
3. Start the backend and confirm `/health`, `/api/v1/near/status`, and `/api/v1/near/verifier-status` contain no secret material.
4. Confirm the backend process is the only writer and restart it once, checking execution and verifier-ledger recovery.
5. Use a fresh judge wallet for authentication and create a real execution; do not reuse historical payment evidence as a new result.
6. Run independent verification through the authenticated backend endpoint, inspect the passing receipt, and use the backend verifier submission boundary only after the signer decision is approved.
7. Have the project owner explicitly approve and settle through the wallet; reconcile both transactions from finalized NEAR state.

## Readiness decision

The off-chain browser, origin, and persistence corrections are implemented and tested. The project is **not deployment-ready** while the positive-deposit verifier signer remains unresolved and the production build/deployment smoke test is incomplete.

Exact next operator action: decide and authorize the isolated verifier signing deployment (or approve a contract revision for restricted-key compatibility), then rerun the Next production build and deploy one persistent API instance for a fresh-wallet smoke test. No blockchain write should be made as part of this blocker-fix phase.
