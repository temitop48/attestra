# Phase 3D Live Browser Approval Debug

Date: 2026-11-13

## Exact root cause

The browser error was caused by a stale API process, not by the deposit values or the approval handler.

Port 4000 was occupied by an older ATTESTRA `tsx src/dev-server.ts` process started at 09:07. Its live response contained only the project and milestone storage deposits and omitted both `approvalStorageDeposit` and `settlementStorageDeposit`. The newer API could not bind to port 4000, so the browser continued calling the stale process.

The frontend does not read these deposits from `NEXT_PUBLIC_*` variables. It calls `GET /api/v1/near/config` at runtime and stores the returned object in the payment panel's `config` state. The browser bundle's default API base is `http://localhost:4000`.

## Process evidence

Initial investigation found:

- No usable current listener was visible from the initial shell probe.
- A stale ATTESTRA API process group was subsequently identified on port 4000:
  - `pnpm --filter @attestra/api exec tsx src/dev-server.ts`
  - working directory: `<repository-root>/apps/api`
  - process group started at 09:07
- The then-current `pnpm dev` had a frontend process on port 3000, but its API child could not become the port-4000 listener.
- The stale API group was stopped and the relevant API service was restarted.
- The stale Next.js process on port 3000 was listening but did not answer requests; it was stopped and the web service was restarted.

Current runtime services:

- API: `0.0.0.0:4000`, current restarted ATTESTRA API
- Frontend: `*:3000`, current restarted Next.js development server

Only the identified ATTESTRA API and frontend processes were restarted. No unrelated processes or blockchain services were changed.

## Actual HTTP responses

Before replacing the stale API, `GET http://127.0.0.1:4000/api/v1/near/config` returned HTTP 200 but omitted:

```json
{
  "network": "testnet",
  "contractAccountId": "escrow.attestra-owner.testnet",
  "projectStorageDeposit": "3000000000000000000000",
  "milestoneStorageDeposit": "5000000000000000000000"
}
```

After the restart, the same live endpoint returned HTTP 200 with:

```json
{
  "network": "testnet",
  "contractAccountId": "escrow.attestra-owner.testnet",
  "approvalStorageDeposit": "330000000000000000000",
  "settlementStorageDeposit": "510000000000000000000"
}
```

The response also contains the existing verifier and verification/project/milestone deposit fields. No values are hardcoded into the approval button.

The restarted frontend returned HTTP 200 for `/workspace`. Its live workspace bundle contains the API base `http://localhost:4000` and the `/api/v1/near/config` request path. Therefore the browser-facing configuration path is the corrected API on port 4000, not a Next.js proxy or a different port.

The API response includes the expected CORS origin `http://localhost:3000` and credentials support.

## Code path

1. `PaymentLifecyclePanel` calls `getNearConfig()` during initialization.
2. `getNearConfig()` requests `/api/v1/near/config` using the API base.
3. Fastify `chainConfig()` reads `NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO` and `NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO`.
4. `requestChainIntent(executionId, "approve")` constructs the approval intent from the server configuration.
5. `requiredDeposit()` rejects missing or non-positive values and returns the exact string unchanged.
6. The wallet receives the server-issued `approve_milestone` intent; no transaction was broadcast during this investigation.

## Changes

- Preserved the reviewed values in the repository runtime environment:
  - approval: `330000000000000000000`
  - settlement: `510000000000000000000`
- Preserved the API startup environment loader in `apps/api/src/server.ts`.
- Added `apps/api/test/near-config.test.ts` to assert that both fields reach the browser-facing API response.
- Restarted the stale ATTESTRA API and Next.js processes so the live ports use current code/configuration.
- No contract, receipt, execution, or blockchain state was modified.

## Validation

- Live API `/api/v1/near/config`: HTTP 200; exact approval and settlement values present.
- Live frontend `/workspace`: HTTP 200.
- Live frontend bundle: uses `http://localhost:4000` and `/api/v1/near/config`.
- API tests: 54 passed.
- Frontend tests: 25 passed.
- Typecheck: passed.
- Lint: passed.
- Production build: passed.

## Readiness

The runtime configuration path is now genuinely ready: the live approval handler's source API supplies the exact positive approval deposit, and the live frontend points to that API. No blockchain transaction has been signed or broadcast.

A browser GUI session and wallet confirmation were not automated here. The live HTTP and bundle path is verified, but the final visual/button confirmation remains a human browser check.

## Exact browser steps

1. Keep the current API on `http://localhost:4000` and Next.js frontend on `http://localhost:3000` running.
2. Open `http://localhost:3000/workspace`.
3. Hard-refresh the page to discard any stale browser bundle/cache.
4. Connect and authenticate `lateram9099.testnet`.
5. Select the execution linked to project `0`, milestone `0`.
6. Confirm the page shows milestone `VerificationPassed` and receipt `attest-1794510501481-h8yi6rpx`.
7. Click **Approve milestone**.
8. Before confirming in the wallet, verify method `approve_milestone`, project `0`, milestone `0`, the exact receipt ID, and attached deposit `0.00033 NEAR`.
9. Reject the prompt if any receiver, method, ID, receipt, or deposit differs.
10. After finality, confirm `OwnerApproved` appears. Only then use **Settle milestone** and verify the `0.00051 NEAR` settlement storage deposit.
