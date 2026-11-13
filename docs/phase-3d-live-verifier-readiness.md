# Phase 3D Live Verifier Readiness

Date: 2026-11-13

## Scope and safety

This was a read-only readiness investigation. No NEAR transaction was signed, submitted, or broadcast. No receipt, artifact, execution, project, milestone, or historical record was modified. The credential file was read only in memory to derive its public key; its private contents were not printed or copied.

## Signer configuration

The local Fastify environment now contains only non-secret signer configuration:

- Account: `verifier.attestra-owner.testnet`
- Contract: `escrow.attestra-owner.testnet`
- Network: `testnet`
- Credential path: `<operator-controlled NEAR credential path>`

The credential file exists with filesystem mode `0600` and is owned by the local operator account. `.env.local` is ignored by Git (`.gitignore` rule `.env.*`), and the credential itself remains outside the repository. No key material was copied into `.env.local` or source code.

The derived public key is registered on-chain for `verifier.attestra-owner.testnet` with `FullAccess` permission. This is compatible with the required function call, but it is broader than the preferred public-deployment posture. A dedicated restricted FunctionCall key should be used before public deployment.

## On-chain verifier identity

The configured signer account is exactly `verifier.attestra-owner.testnet`, matching the deployed authorized verifier identity confirmed for `escrow.attestra-owner.testnet`. The derived public key lookup against finalized Testnet RPC succeeded, and the key belongs to that account.

The local signer account check therefore passes. The account currently uses FullAccess, so the controlled local demonstration is possible from a permissions perspective; the same credential must not be exposed in a public service.

## API readiness check

The built Fastify API was started without the TypeScript watcher because the sandbox denied the watcher’s IPC pipe with `EPERM`. The built Node server started successfully when run with the permitted local binding.

Read-only endpoint results:

```json
{
  "configured": true,
  "signerAccountId": "verifier.attestra-owner.testnet",
  "configurationError": null,
  "submissionLedger": "persistent-local-single-writer"
}
```

Health returned `status: ok`. The NEAR configuration endpoint confirmed the Testnet network, escrow contract, and authorized verifier account.

The signer itself is configured. However, `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO` is not configured. The backend submission service intentionally fails closed without a reviewed positive verification storage deposit. Therefore the API is signer-ready but not yet live-submission-ready.

## Receipt and execution validation

The recovered execution record was inspected at `apps/api/.data/executions.json`:

| Field | Result |
|---|---|
| Execution | `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac` |
| Artifact revision | `2` |
| Artifact digest | `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6` |
| Receipt | `attest-1794510501481-h8yi6rpx` |
| Receipt result | `Passed` |
| Verifier | `attestra-independent-verifier-v4` |
| Receipt project/milestone | `0 / 0` |
| Linkage project/milestone | `0 / 0` |
| Owner / recipient | `lateram9099.testnet` / `lateram9099.testnet` |
| Budget | `10000000000000000000000` yoctoNEAR (`0.01 NEAR`) |
| Verification transaction | None |

The receipt passes the persisted PROOFLOCK eligibility and linkage requirements previously implemented by the backend: it is a verified passing receipt, matches the final artifact digest, uses the active v4 verifier, and is bound to the confirmed Testnet project and milestone. No receipt was submitted during this check.

## Current finalized chain state

Finalized read-only Testnet RPC views returned:

- Project 0 owner: `lateram9099.testnet`
- Total funded: `20000000000000000000000` yoctoNEAR (`0.02 NEAR`)
- Available: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Reserved: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Milestone 0 recipient: `lateram9099.testnet`
- Milestone 0 budget: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Milestone 0 status: `InProgress`
- On-chain verification: `null`

The milestone is eligible for a verification submission. It has not already received verification and remains reusable.

## Persistent submission ledger

The API’s configured ledger location for this local run is `apps/api/.data/verification-submissions.json`. It is currently absent, which means there are zero persisted submissions. There is no finalized submission, pending reservation, unknown outcome, failed submission, or conflicting idempotency record.

The absence is clean rather than an error: the ledger is created on the first backend submission reservation. No submission attempt was made here.

## Findings and remaining blocker

1. **Signer configured:** Yes, using a server-only filesystem path. The key file is `0600` and outside the repository.
2. **Signer matches authorized verifier:** Yes. The configured account matches the deployed authorized verifier, and the derived public key is registered on that account.
3. **Receipt passes final validation:** Yes, based on the persisted v4 receipt, immutable artifact digest, exact project/milestone binding, and live chain state.
4. **Milestone eligible:** Yes. Milestone 0 is `InProgress` and has no verification.
5. **Submission ledger clear:** Yes. No ledger file exists and no prior submission is recorded.
6. **API ready for live submission:** Not yet. The signer is ready, but `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO` is missing. The service must fail closed until the operator reviews and sets the exact positive deposit required by the deployed contract/storage measurement.

## Exact operator action

1. Determine and review the required verification storage deposit for this deployed contract and receipt shape. Do not infer it from the milestone budget.
2. Add only that reviewed yoctoNEAR amount to the ignored local environment as `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO`.
3. Restart the built API and confirm `/api/v1/near/verifier-status` still reports the expected verifier account and no configuration error.
4. Confirm the read-only chain state is still `InProgress` with no verification.
5. Human-authorize exactly one backend `submit-verification` request for the existing execution. The browser must supply no receipt or contract arguments.
6. Treat the returned hash as pending only. Reconcile it against finalized NEAR transaction evidence and milestone state before proceeding to owner approval and settlement.

Until step 2 is completed and reviewed, do not submit the transaction.
