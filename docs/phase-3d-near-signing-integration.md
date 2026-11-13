# Phase 3D NEAR Signing Integration

Date: 2026-11-12

## Executive result

The server-side signing transport is implemented and connected to the existing fail-closed PROOFLOCK submission service. No blockchain transaction was signed or broadcast during this work.

The existing v4 receipt is eligible for a pre-submission validation attempt: its execution, digest, project 0, milestone 0, owner, recipient, budget, network, contract, and current `InProgress` chain state match the recovered records. It remains unsubmitted. A production secret-manager resolver, server bootstrap wiring, and durable idempotency storage are still required before live use.

## Existing implementation reviewed

- `apps/api/src/restricted-verifier-signer.ts` is the narrow signing boundary. It permits only `submit_verification`, the configured escrow receiver, a `Passed` result, validated non-negative project/milestone IDs, a 64-character SHA-256 digest, and non-empty receipt/idempotency values. It rejects raw private-key configuration.
- `apps/api/src/verifier-submission.ts` performs the PROOFLOCK and authoritative chain checks before constructing the intent. It verifies the execution record, exact artifact digest, receipt status/version, network and contract, project/milestone linkage, owner, recipient, budget, and live milestone state. It also performs idempotency and finalized-state reconciliation.
- `apps/api/src/near-signing-transport.ts` is the new maintained `near-api-js` 5.1.1 transport. It resolves a server-only Ed25519 key through an injected callback, stores it in an in-memory key store, connects only to configured Testnet RPC, obtains the configured account, and calls only the fixed escrow method with the service-generated arguments.
- `apps/api/src/app.ts` exposes owner-authenticated backend submission and reconciliation routes. The request body cannot supply a receipt, contract, method, project, milestone, or transaction arguments. The service is created only when both the read-only chain adapter and injected backend signer are present. Owner approval and settlement remain separate owner-controlled flows.
- `apps/api/package.json` and `pnpm-lock.yaml` now pin the API dependency to `near-api-js` `^5.1.1`. The first registry attempt encountered DNS failure; the authorized retry succeeded. No unsafe registry workaround was used.

## Signing and security controls

The transport has these controls:

1. The private key is accepted only from an injected server-side resolver. It is not read from a request, returned in a response, printed, or logged.
2. The receiver must equal the configured escrow contract and the method must equal `submit_verification`.
3. Only a passing PROOFLOCK result can reach the transport.
4. Gas and deposit are validated and converted to `bigint` before the SDK call.
5. `near-api-js` selects the account access-key nonce and returns the transaction outcome. The application still requires explicit reconciliation of the transaction against finalized contract state; a hash alone is not treated as proof of verification.
6. Retries are bounded to at most three attempts and are opt-in. The caller must explicitly identify a pre-broadcast failure as retryable. Unknown or post-broadcast failures are not retried, preventing duplicate verification calls.
7. The service's existing idempotency and in-flight protections remain in force. For a multi-instance public deployment, this state must be moved to a durable shared store before production use; process-local state is insufficient across restart or multiple replicas.
8. The browser never receives signing credentials and cannot invoke arbitrary contract methods. The authenticated project owner may request the fixed backend operation, but cannot alter its authorization payload.

A restricted NEAR FunctionCall access key should be used for the backend signer where supported, scoped to `escrow.attestra-owner.testnet` and `submit_verification`, with no FullAccess key in the public service. The existing FullAccess credentials must not be placed in application environment variables or logs.

## Read-only receipt and chain eligibility check

The recovered execution and chain state were inspected without submitting a transaction:

| Field | Verified value |
|---|---|
| Execution | `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac` |
| Receipt | `attest-1794510501481-h8yi6rpx` |
| Verifier | `attestra-independent-verifier-v4` |
| Result | `Passed` |
| Artifact digest | `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6` |
| Network | NEAR Testnet |
| Contract | `escrow.attestra-owner.testnet` |
| Project / milestone | `0 / 0` |
| Owner / recipient | `lateram9099.testnet` / `lateram9099.testnet` |
| Budget | `0.01 NEAR` |
| Chain status | `InProgress` |

The chain view showed no verification stored for milestone 0 at the time of inspection. Therefore the receipt is eligible for the service's validation boundary, but has not yet been submitted and is not payment evidence until a finalized transaction is reconciled.

## Tests and validation

Passed:

- Focused signing, restricted signer, and submission tests: **22/22**.
- Isolated API test suite: **51/51** across six files.
- Frontend tests: **25/25**.
- Workspace typecheck: passed.
- Workspace lint: passed.
- Production build: passed.
- Rust escrow tests: **46 passed, 0 failed**.

The first aggregate test invocation reported an API-suite failure while running the workspace concurrently. The API suite was then rerun in isolation and passed all 51 tests; no application defect was reproduced. The signing tests cover fixed call shape, receiver/method rejection, bounded pre-broadcast retry, and no retry after an unknown submission failure. Existing verifier tests cover rejected receipts, digest/linkage mismatches, idempotency, and finalized reconciliation.

## Remaining configuration and operational blockers

The implementation deliberately does not auto-discover or load a credential. Before a live submission, the operator must:

1. Provision or identify a dedicated verifier signing identity authorized by the deployed contract. Prefer a restricted FunctionCall key limited to the escrow contract and `submit_verification`; do not use a public-facing FullAccess credential.
2. Store the key in an approved secret manager or signer service. Configure only a secret reference such as `ATTESTRA_NEAR_SIGNER_SECRET_REF`, along with the verifier account, escrow account, Testnet RPC URL, gas, and verification storage deposit. Never commit the key.
3. Implement the server bootstrap's injected `resolvePrivateKey`/KMS adapter and pass `createNearApiVerifierSigner(...)` to `buildApp({ verifierSigner, nearAdapter })`. `apps/api/src/server.ts` currently builds the app without a signer, so the default process remains safely unconfigured rather than silently using a credential.
4. Replace process-local idempotency/in-flight state with durable shared storage for a public multi-instance deployment, or enforce a single durable service instance with equivalent recovery guarantees.
5. Verify the signer account/access-key permission and contract authorization through read-only checks before any write.

## Operator-reviewed live procedure

No step below was executed in this task.

1. Start the API with the server-only signer configuration and confirm health without exposing secret values.
2. Authenticate as `lateram9099.testnet` in the browser and open execution `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac`.
3. Confirm the UI shows the exact v4 receipt, digest, project 0, milestone 0, and `Passed` eligibility.
4. Human-authorize the owner-authenticated “submit verification” action. The backend must regenerate and validate the intent from the persisted receipt; the browser must not provide transaction arguments.
5. Capture the returned pending transaction hash. Do not treat it as success.
6. Call or allow the reconciliation worker to query finality and the exact contract state. Continue only when the finalized state contains the expected receipt for project 0/milestone 0 and the expected verifier.
7. Switch to the owner wallet `lateram9099.testnet`, approve the exact new receipt, and wait for finality.
8. Settle the milestone through the existing owner-controlled UI and wait for the asynchronous payment callback.
9. Confirm the contract reports `Paid` and the UI displays finalized verification, approval, settlement, callback, and payment evidence.

If any linkage, authorization, finality, or receipt check fails, stop. Do not retry by creating a new execution, and do not approve or settle.

## Final assessment

1. **Signing transport implemented:** Yes, with `near-api-js` 5.1.1 and a fixed restricted call surface.
2. **Connected to PROOFLOCK:** Yes, through the existing backend submission service and new owner-authenticated submission/reconciliation routes.
3. **Tests pass:** Relevant API, verifier, frontend, typecheck, lint, build, and Rust tests pass. The initial concurrent aggregate test run was transient; isolated API rerun passed 51/51.
4. **Receipt ready:** Yes for a human-authorized, pre-submission backend validation; it has not been submitted and cannot yet be called on-chain payment evidence.
5. **Remaining configuration:** A secret-manager-backed signer resolver, dedicated restricted verifier access key, server bootstrap injection, and durable idempotency/recovery are required.
6. **Exact next action:** Complete operator-reviewed signer provisioning and wiring, perform read-only configuration checks, then explicitly authorize one live backend `submit_verification` transaction. Only after finalized reconciliation should the owner perform approval and settlement.
