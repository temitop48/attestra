# Phase 3D Verifier Bootstrap Readiness

Date: 2026-11-12

## Summary

The Fastify bootstrap now attempts to create the backend verifier signer from server-only configuration and injects it into the existing PROOFLOCK submission service. Missing signer configuration leaves ordinary API functionality available while the payment submission boundary returns a safe configuration error. Invalid signer configuration is retained as a non-secret readiness error and never causes an unsigned or arbitrary call.

Durable submission state is now stored separately from execution history in `verification-submissions.json`, next to the configured execution database. A pending reservation is written before the signer is called. This prevents a restart from issuing a second call for the same execution/receipt/digest. A transaction hash is not treated as success; only finalized reconciliation against NEAR state produces `finalized`.

No blockchain transaction was signed or broadcast, and no credential contents were printed, copied, exported, or committed.

## Implemented changes

### Server-only signer loading

`apps/api/src/verifier-bootstrap.ts` provides `createVerifierSignerFromEnvironment()`:

- Reads the account, escrow contract, RPC URL, and a server-only credential-file reference from process configuration.
- Reads the local credential file only inside the backend process and checks that it is not group- or world-readable.
- Accepts only an Ed25519 NEAR key and never logs or returns it outside the signer construction path.
- Rejects raw `NEAR_VERIFIER_PRIVATE_KEY` configuration.
- Returns no signer when signing is not configured, so non-payment API operations continue to work.

The local credential-file mode is intended only for a controlled operator Testnet demonstration. Public deployment should replace that resolver with KMS/HSM/secret-manager retrieval while keeping the same `resolvePrivateKey` boundary. A restricted FunctionCall access key should be used instead of exposing a FullAccess credential to the service.

### Fastify bootstrap

`apps/api/src/server.ts` now creates the signer before calling `buildApp()`. A configuration failure is converted to a safe readiness error and the app starts without a payment signer. `apps/api/src/app.ts` now:

- Injects the signer into `BackendVerifierSubmissionService`.
- Creates a persistent submission ledger beside the execution database.
- Exposes `GET /api/v1/near/verifier-status`, which reports only configured/account/readiness metadata and never secret material.
- Keeps the submission endpoint owner-authenticated and accepts no receipt, contract, method, project, milestone, gas, or deposit fields from the browser.

The existing service still validates the backend-generated passing receipt and live linkage before constructing the call. It requires the signer account to equal the configured authorized verifier and the reader contract/network to equal the execution's authoritative linkage.

### Durable idempotency and reconciliation

`apps/api/src/verifier-submission-store.ts` implements an atomic temporary-file-plus-rename JSON ledger with mode `0600`. It persists:

- `pending` reservations, including reservations with no hash after a process interruption;
- `finalized` results and transaction hashes;
- `failed` results for explicitly classified failed submissions;
- `unknown` outcomes for ambiguous signing/RPC failures.

The service uses the deterministic key `executionId:receiptId:artifactDigest`. Concurrent calls in one API process share the in-flight operation, while a restarted process loads the persisted result and does not call the signer again. An ambiguous result is never automatically retried. Reconciliation queries finalized NEAR transaction evidence and milestone state before returning `finalized`.

The JSON ledger is safe for a persistent-volume, single-writer deployment. It is not sufficient as a shared multi-replica database because two independent processes can race before seeing each other's file update. Public deployment therefore requires one of:

1. a single durable API instance with an exclusive persistent volume and restart recovery; or
2. replacement of this adapter with a transactional shared database using a unique idempotency key and row lock/conditional insert.

This is an intentional remaining infrastructure dependency, not a reason to weaken the payment gate.

## Security behavior

- The authorized verifier account is checked by the service before signing.
- The signer permits only `submit_verification` to the configured escrow contract and only a `Passed` result.
- Receipt ID, artifact digest, project ID, milestone ID, gas, deposit, and idempotency key are generated or validated by trusted backend code.
- A browser cannot submit arbitrary contract arguments or call the signer directly.
- Missing credentials, malformed credentials, wrong signer account, wrong contract, rejected receipt, digest mismatch, stale receipt, wrong chain linkage, and duplicate linkage fail closed.
- Unknown transaction outcomes remain `unknown`; a transaction hash alone is never shown as finalized payment evidence.
- Owner approval and settlement remain separate owner-controlled operations.
- Historical executions and receipts were not modified.

## Validation

Passed:

- Backend API tests: **52/52**.
- Frontend tests: **25/25**.
- Workspace typecheck: passed.
- Workspace lint: passed.
- API production build: passed.
- Web production build: passed.
- Rust escrow tests: **46 passed, 0 failed**.
- Focused signing/submission tests cover invalid credentials, fixed call shape, wrong receiver, wrong signer account, concurrent requests, persisted restart behavior, and unknown outcomes.

The recursive workspace build was also attempted. Its 120-second watchdog expired during concurrent package work, without a compiler error. The API and web production builds were then run independently and both completed successfully. No source change was made to work around the timeout.

## Current live receipt readiness

The existing receipt `attest-1794510501481-h8yi6rpx` remains eligible for the backend validation boundary based on the previously confirmed v4 result and project 0/milestone 0 linkage. It has not been submitted. The current milestone remains subject to the existing on-chain state and no state was changed in this task.

The local repository environment does not currently configure an active backend verifier signer. The implementation is therefore operationally fail-closed until the operator supplies the server-only account, contract, credential-file/secret reference, and storage-deposit configuration. The actual local credential was not opened or used during this task.

## Operator configuration

For a controlled local Testnet demonstration, set these values in the API process environment without committing them:

```text
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE=<server-only path>
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=<reviewed positive amount>
```

The credential path must be readable only by the API service account. For public deployment, use a dedicated restricted FunctionCall access key scoped to the escrow contract and `submit_verification`, loaded through a secret manager or HSM. Do not place a private key in `.env`, the browser bundle, logs, or source control.

Before a live submission, the operator must perform read-only checks that the signer account is the deployed authorized verifier and that the key permission is appropriate. If the signer is not authorized, stop; do not rotate the verifier automatically.

## Final assessment

1. **Secure signer loading works:** The server-only local credential loader and fail-closed validation are implemented and covered by tests. No live credential was loaded in this task, so operational signing remains unverified.
2. **Fastify initialization works:** Yes. `server.ts` injects the signer when valid server configuration is present and keeps the app running without payment capability when it is absent or invalid.
3. **Idempotency survives restarts:** Yes for the persistent single-writer ledger. A pending reservation with an ambiguous outcome blocks duplicate submission after restart. A shared transactional store remains required for multi-instance deployment.
4. **Existing receipt ready:** Yes for human-authorized backend submission after configuration and read-only signer authorization checks. It remains unsubmitted.
5. **Manual configuration remains:** Yes—server-only signer secret resolution, authorized verifier account, escrow/RPC/deposit configuration, and persistent storage deployment.
6. **Public deployment ready:** Not yet for a multi-replica public service. It is ready for a controlled single-instance Testnet demonstration after signer provisioning; public deployment additionally needs a KMS/HSM resolver and shared transactional idempotency storage.
7. **Exact next step:** Configure and read-only-verify a dedicated restricted verifier signer, start the API, inspect `/api/v1/near/verifier-status`, authenticate the project owner, and explicitly authorize one `submit-verification` request. Capture the pending hash, reconcile it to finalized NEAR state, and only then proceed with owner approval and settlement.
