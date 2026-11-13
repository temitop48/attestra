# Phase 3D Automated Verifier Audit and Readiness

Date: 2026-11-12

## Executive result

The deployed contract can support a backend-operated verifier, but the complete automated verifier service is **not operationally implemented and is not safe to deploy yet**. The contract requires transactions from its configured authorized verifier. The repository has no NEAR signing SDK/adapter and no server-side verifier credential. The existing browser path therefore still requires `verifier.attestra-owner.testnet`.

This work adds and tests a server-side validation, idempotency, intent, and finalized-evidence boundary. It deliberately refuses to submit when a signer is absent or mismatched. No transaction, wallet signature, verifier rotation, or historical-record mutation was performed.

The existing v4 receipt is eligible for submission after a correctly authorized backend signer is provisioned and integrated:

`attest-1794510501481-h8yi6rpx`

Its current chain state is still `InProgress`, so it has not been consumed on-chain. The local record is linked to Testnet contract `escrow.attestra-owner.testnet`, project `0`, milestone `0`, owner and recipient `lateram9099.testnet`, and budget `10000000000000000000000` yoctoNEAR (0.01 NEAR).

## Current architecture

- `apps/web` connects a wallet and signs browser transactions.
- `apps/api` authenticates the wallet, creates server-issued chain intents, and reconciles finalized transaction evidence using the read-only NEAR adapter.
- `packages/near-readonly` performs RPC views and finalized transaction reads only; it intentionally has no signer.
- `packages/verification` produces and validates PROOFLOCK receipts. The active implementation is `attestra-independent-verifier-v4`.
- `apps/api/.data/executions.json` persists execution, artifact, receipt, and chain-linkage records.
- `contracts/escrow` enforces verifier, owner, receipt, lifecycle, and callback rules on-chain.

The current browser payment component explicitly requires the configured authorized verifier wallet for `submit_verification`. Owner approval and settlement remain owner-controlled and are not delegated by this change.

## Phase A: contract and access audit

### Contract interface and authorization

The deployed contract source defines:

```text
set_authorized_verifier(verifier: AccountId)
submit_verification(project_id, milestone_id, deliverable_digest, receipt_id, result)
```

`set_authorized_verifier` is payable and calls the administrator assertion before changing state and charging any required storage growth. Only the administrator can rotate the verifier. The deployment evidence identifies the administrator as `attestra-owner.testnet` and the current verifier as `verifier.attestra-owner.testnet`.

`submit_verification` requires the transaction predecessor to equal the contract's authorized verifier. It rejects empty or oversized digest/receipt fields, globally reused receipt IDs, missing projects, missing milestones, and submissions for milestones that are not `InProgress`. The contract stores the project ID, milestone ID, digest, receipt ID, result, and verifier. A passing result changes the milestone to `VerificationPassed`; it does not itself approve or settle payment.

The contract has no public getter for the administrator or authorized verifier. Those values must therefore be controlled by deployment configuration and operator evidence, while authorization is enforced by the contract at execution time.

### Read-only chain check

A finalized read-only RPC view of project `0` / milestone `0` returned:

- recipient: `lateram9099.testnet`
- budget: `10000000000000000000000` yoctoNEAR
- status: `InProgress`
- verification: absent
- approval receipt: absent

This is consistent with the v4 receipt being off-chain passing but not yet submitted. No transaction hash is being treated as proof of success.

### Existing receipt eligibility

The local v4 receipt and execution satisfy the safe pre-submission checks:

- receipt result is `Passed`;
- every recorded check is required and `passed`;
- receipt project/milestone are `0`/`0`;
- receipt digest is `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`;
- that digest matches the immutable final revision 2 artifact after recomputation;
- execution linkage is confirmed for Testnet and the exact deployed contract;
- owner, recipient, and budget match finalized chain views;
- receipt version is v4 and the historical v3 rejected receipt remains separate.

It is eligible for a fresh submission request, but it has not been submitted and is not yet on-chain evidence.

## Implemented safe boundary

Added [verifier-submission.ts](../apps/api/src/verifier-submission.ts), with the following controls:

1. Requires confirmed Testnet linkage to the exact configured contract.
2. Reads project and milestone state before creating an intent.
3. Requires exact on-chain project, milestone, owner, recipient, budget, and `InProgress` status.
4. Selects only the latest backend-persisted passing attempt for the same execution.
5. Requires the active v4 implementation and no failed or skipped mandatory check.
6. Recomputes the artifact digest from the stored immutable files.
7. Requires receipt, final revision, execution, project, and milestone bindings to agree.
8. Generates only the fixed `submit_verification` method, with exact receipt arguments and a fixed storage deposit.
9. Refuses to operate with no signer and rejects a signer account different from the configured authorized verifier.
10. Deduplicates concurrent submissions by execution/receipt/digest idempotency key.
11. Reconciliation requires a successful finalized transaction from the authorized verifier to the configured contract, with exactly one `submit_verification` action and the configured deposit.
12. Decodes and compares finalized transaction arguments to the server-generated intent.
13. Requires finalized chain state to show `VerificationPassed` with the exact receipt, digest, IDs, and verifier before returning `finalized`.
14. Returns `unknown` for inconsistent transaction evidence instead of claiming success.

The component intentionally does not expose an arbitrary contract-call API and does not accept arbitrary receipt JSON from a client.

### Important limitation

The component currently keeps in-flight/idempotency state in memory and has no signer implementation or API route wired to a server-side signer. It is therefore a tested security boundary, not a deployable production service. Durable idempotency state and a narrowly scoped signer/KMS adapter are required before public deployment.

## Tests

Added [verifier-submission.test.ts](../apps/api/test/verifier-submission.test.ts), 11 tests covering:

- missing signer refusal;
- v3 receipt rejection;
- project and milestone mismatch;
- owner, recipient, and budget mismatch;
- concurrent submission deduplication;
- signer-account mismatch;
- exact finalized argument and chain-state confirmation;
- tampered transaction arguments returning `unknown`.

Validation results:

- `pnpm typecheck`: passed;
- `pnpm lint`: passed;
- `pnpm test`: passed across all workspaces;
- API tests: 40/40 passed;
- focused verifier boundary tests: 11/11 passed;
- web tests: 25/25 passed;
- `pnpm build`: passed;
- escrow Rust tests: 46/46 passed.

No historical execution, artifact, receipt, or transaction record was changed by this work.

## Security findings and remaining blockers

### Blocker 1: no server signing identity

There is no server-side verifier private key, KMS integration, NEAR signing dependency, or signer environment variable in the current API. The existing `NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID` is configuration only; it is not a credential. The API cannot safely submit the v4 receipt until a signer is provisioned.

### Blocker 2: current on-chain verifier is not operator-controlled

The current authorized account is `verifier.attestra-owner.testnet`, which the operator does not control. The admin can rotate it, but rotation is itself a privileged blockchain transaction and was not performed.

### Blocker 3: durable operational state

An in-memory idempotency map is insufficient for a multi-instance or restarting public service. Pending, finalized, failed, and unknown outcomes need a durable store and a reconciliation worker that never creates a second submission for the same execution/receipt/digest key.

### Blocker 4: existing project owner remains required

Removing the verifier-wallet requirement does not remove owner authorization. Project `0` belongs to `lateram9099.testnet`. That owner account must still approve the exact v4 receipt and settle the milestone. Judges using unrelated wallets cannot approve or settle this existing project unless the operator provides the owner-controlled demonstration session or creates a judge-owned project through the normal workflow.

## Exact operator actions

These actions are instructions only; none were executed:

1. Provision a dedicated NEAR Testnet account or subaccount for the verifier service, preferably with a narrowly scoped signing key held in a secret manager/KMS. Do not place the key in the repository, browser bundle, `.env.example`, logs, or client requests.
2. Fund the service account with sufficient Testnet NEAR for gas and the contract's measured verification storage deposit.
3. Using the administrator account `attestra-owner.testnet`, call `set_authorized_verifier(newVerifierAccount)` with the required attached storage deposit. Confirm the finalized transaction and record the new account outside historical execution evidence. Do not rotate automatically.
4. Add server-only configuration for the exact Testnet RPC, contract, new authorized verifier, storage deposit, signer/KMS reference, bounded timeout, and durable idempotency store. Keep frontend configuration limited to public account/network values.
5. Integrate the signer adapter so it can submit only the prepared verifier intent. It must not accept arbitrary method names or client-provided arguments. Use bounded retries only for transport uncertainty, preserving the same idempotency key; reconcile every hash to final chain state.
6. Restart the API with the new secret configuration and verify health/config output does not reveal secrets.
7. Run the backend validation against execution `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac` and receipt `attest-1794510501481-h8yi6rpx`. Confirm a pending result first, then reconcile the finalized transaction. A successful result must show chain milestone `VerificationPassed` and exact receipt/digest/verifier bindings.
8. Connect the owner wallet `lateram9099.testnet`, approve the exact v4 receipt, reconcile final `OwnerApproved`, then settle and reconcile the callback to final `Paid`. Keep approval and settlement manual and owner-authorized.

## Public deployment considerations

Before exposing the service to judges, use HTTPS, server-only secrets, strict authentication/CSRF controls for any submission endpoint, request authorization tied to the selected execution, rate limits, durable idempotency/locking, redacted structured logs, RPC timeouts, finality polling, unknown-outcome recovery, and operational alerts. The frontend should display `pending`, `finalized`, `failed`, and `unknown` separately and must never equate a transaction hash with successful verification.

## Final answers

1. **Automated verifier service implemented?** The safe validation/idempotency/reconciliation boundary is implemented and tested. The actual server-operated signing service is not implemented because no signer SDK or credential is available.
2. **Safe to deploy?** No. Provision and authorize a dedicated signer, add a durable store, wire the restricted signer route, and complete integration testing first.
3. **Can the existing v4 receipt be submitted?** Yes, it is locally eligible and project 0/milestone 0 remains `InProgress`; actual submission is blocked until the authorized server signer exists and matches the contract.
4. **Is verifier rotation possible?** Yes. The contract permits it only for `attestra-owner.testnet`, with the required attached storage deposit. It was not executed.
5. **Required operator-controlled accounts/credentials:** the administrator for rotation, the new verifier signer or KMS key, server-only RPC/signing configuration, and `lateram9099.testnet` for approval and settlement of the existing project.
6. **What happens next?** Provision and authorize the dedicated verifier, deploy the restricted backend signer with durable reconciliation, submit and reconcile the existing v4 receipt, then manually perform owner approval and settlement. Until those actions occur, the current browser verifier-wallet flow remains the only live submission path.
