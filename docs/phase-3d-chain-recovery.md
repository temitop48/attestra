# ATTESTRA Phase 3D Chain Recovery and QA Report

Generated: 2026-11-12  
Network: NEAR Testnet  
Contract: `escrow.attestra-owner.testnet`

## Executive conclusion

The earlier recovery report was incorrect about persistence. Historical execution data exists at `apps/api/.data/executions.json`, not at the root `.data` directory inspected by that report. The file contains the browser-run execution and all five finalized lifecycle hashes through `start_milestone`.

Read-only Testnet RPC confirms that project `0` and milestone `0` exist and are currently in `InProgress`. The browser results are therefore genuine and recoverable through both local linkage and chain receipts.

The browser run did not complete Phase 3D payment authorization. The recovered execution has a failed off-chain verification attempt and no on-chain verification, approval, or settlement hash. No wallet signing or blockchain transaction was performed during this audit.

## 1. Recovered on-chain state

### Project discovery

The requested query was issued with:

```json
{"owner":"lateram9099.testnet","from_index":0,"limit":50}
```

`get_project_ids` returned `[]` at finalized block heights `277361228` and `277361457`.

This result is inconsistent with direct state and transaction receipts: `get_project(0)` returns a project owned by `lateram9099.testnet`, and the finalized `create_project` receipt emits the same owner and project ID. This is a deployed-contract project-discovery defect or incompatible view behavior. The application must not rely on `get_project_ids` to recover this project; the known project ID and finalized transaction evidence remain valid.

### Direct project view

`get_project(0)` at finalized block height `277361334`:

| Field | Value |
|---|---|
| Project ID | `0` |
| Owner | `lateram9099.testnet` |
| Total funded | `20000000000000000000000` yoctoNEAR = `0.02 NEAR` |
| Available balance | `10000000000000000000000` yoctoNEAR = `0.01 NEAR` |
| Reserved balance | `10000000000000000000000` yoctoNEAR = `0.01 NEAR` |
| Paid balance | `0` |
| Refunded balance | `0` |
| Pending refund | `0` |
| Pending payment | `null` |
| Next milestone ID | `1` |

### Direct milestone view

`get_milestone(0, 0)` at finalized block height `277361333`:

| Field | Value |
|---|---|
| Project ID | `0` |
| Milestone ID | `0` |
| Recipient | `lateram9099.testnet` |
| Budget | `10000000000000000000000` yoctoNEAR = `0.01 NEAR` |
| Dependencies | `[]` |
| Status | **`InProgress`** |
| Verification | `null` |
| Approval receipt | `null` |

The milestone is still `InProgress` and has not reached verification, owner approval, `PaymentPending`, or `Paid`.

## 2. Finalized transaction evidence

All five hashes below were recovered from `apps/api/.data/executions.json` and independently queried through the read-only `tx` RPC method. Each transaction was `FINAL`, signed by `lateram9099.testnet`, targeted `escrow.attestra-owner.testnet`, and emitted the expected contract event.

| Operation | Transaction hash | Result |
|---|---|---|
| `create_project` | `DHK7Fd6e1STSM4CbNAMPK2d4GAnYWijVkJVERsLCjC4r` | Final; `project_created`, project `0` |
| `register_milestone` | `FK3KSdz1NFYsdPAo854xHgcwMGwJcjb4EYAv1S618ag9` | Final; milestone `0`, recipient and budget match |
| `fund_project` | `4YV5eQSMs4gnEZNqjqDwhk85upAWsdVZKk6Dv4BuAHHc` | Final; funded `0.02 NEAR` |
| `activate_milestone` | `BL5duj7bPn7BbmwMrtRDdk2AWspriywZQxnJYvqoawVR` | Final; reserved `0.01 NEAR` |
| `start_milestone` | `JCLFBTdLthyWZqdFmxkiH5rixCF6zti9VBFZ7AeVYxTi` | Final; status `InProgress` |

The local linkage belongs to execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`, with confirmed project `0`, milestone `0`, recipient `lateram9099.testnet`, and budget `10000000000000000000000`.

## 3. Persistence investigation

### What was found

- Root `.data` contains deployment reports only.
- `apps/api/.data/executions.json` exists, is 195,739 bytes, and contains 8 executions.
- The recovered browser execution is the eighth record and was updated on 2026-11-12.
- Its linkage is `confirmed` and contains the five hashes above.
- It has a final deliverable at revision `3` and an off-chain verification attempt with result `Failed`.
- It has no `verificationTransactionHash`, `approvalTransactionHash`, or `settlementTransactionHash`.

### Why the earlier report missed it

The API resolves its store as:

```text
options.databasePath ?? process.env.DATABASE_URL ?? .data/executions.json
```

The normal API environment uses `DATABASE_URL=./.data/executions.json` relative to the API process working directory. The recovered records were therefore written to `apps/api/.data/executions.json` when the API ran from `apps/api`, while the audit searched only root `.data`.

`apps/api/src/dev-server.ts` also loads `../../.env.local` relative to the API process working directory, which reinforces that the working directory controls environment and relative persistence resolution. The store itself uses atomic temporary-file write plus rename and mode `0600`; no evidence indicates that records were deleted or overwritten.

### Reconstruction safety

The five lifecycle linkage fields can be safely reconciled from the stored hashes and finalized RPC evidence because the API’s confirmation logic checks signer, receiver, method, arguments, finality, and resulting project/milestone state. The existing record already contains this linkage and must not be rewritten.

Verification, approval, and settlement cannot be reconstructed as completed: there are no corresponding hashes, receipts, or on-chain state transitions. The failed off-chain verification receipt is evidence of rejection, not evidence of submission to the contract.

## 4. Phase 3D implementation assessment

| Component | Classification | Assessment |
|---|---|---|
| Authorized verifier wallet signing | Implemented, not live-validated | NEP-413 challenge/session authentication checks the signed account and finalized FullAccess key. The UI requires the configured authorized verifier account before enabling submission. |
| On-chain `submit_verification` | Implemented, not executed for this project | API intent requires authorized verifier identity, `InProgress`, and a persisted passing receipt. Reconciliation validates finalized method, signer, receipt, digest, result, and resulting `VerificationPassed` state. |
| Owner approval | Implemented, not executed | API and contract require project owner, `VerificationPassed`, matching receipt, and latest verifier/digest binding before `OwnerApproved`. |
| Payment settlement | Implemented, not executed | API requires `OwnerApproved`, no pending payment, and matching approval. Contract creates a pending transfer and moves to `Paid` only after callback success. |
| Settlement callback verification | Implemented and unit-tested | `on_payment_complete` is private, checks predecessor, exactly one promise result, operation ID, project, milestone, amount, recipient, and `PaymentPending` status before accounting changes. Failure preserves reservation and returns to approval-required state. |
| Transaction reconciliation | Implemented and browser-validated through `start` | Finalized RPC evidence is required; hash presence alone is not accepted. Duplicate hashes and mismatched signer/receiver/method/arguments/state are rejected. |
| UI payment lifecycle | Implemented, not live-completed | UI supports verifier submission, owner approval, settlement, reconciliation, transaction evidence, `PaymentPending` polling, and `Paid` display. It correctly avoids treating a transaction hash as payment success. |

## 5. Test reliability

The earlier full parallel `pnpm test` run timed out in the re-verification test at Vitest’s default 5-second per-test limit. The test is not an application defect:

- Correctly filtered isolated run: passed in `326ms`.
- Five repeated isolated runs: all passed.
- The previously used command form placed an extra `--` before Vitest arguments, so it ran the entire API test file rather than only the named test; this explains misleading long timings.

The failure is best classified as test invocation/resource contention, not a confirmed product defect. No code or test configuration was changed because no application defect was reproduced.

## 6. Remaining security blockers

1. **Deployed `get_project_ids` is inconsistent.** It returns `[]` for the owner while direct `get_project(0)` and receipts prove project 0 exists. Before relying on owner-based project discovery, reproduce this against the deployed WASM and either repair/redeploy under an explicitly authorized change process or use a safe indexed recovery path.
2. **No Phase 3D transaction evidence exists after `start_milestone`.** The current chain state correctly blocks payment operations until a passing verification is submitted.
3. **The recovered browser execution has a failed off-chain verification attempt.** A fresh passing verification must be produced under the current authoritative criteria; the failed receipt must remain historical.
4. **Runtime configuration is incomplete in `.env.local`.** The authorized verifier and verification/approval/settlement storage deposits are not visibly configured there. The API should fail closed until these are explicitly supplied and reviewed.
5. **End-to-end verifier/owner separation remains untested on Testnet.** The verifier and owner must be separate wallet sessions, with no reuse of owner credentials for verifier submission.

## 7. Exact next steps for browser testing

1. Start the API from the repository’s intended `apps/api` working directory and confirm it loads the same `.env.local` and `apps/api/.data/executions.json` path.
2. Confirm the API reports Testnet, contract `escrow.attestra-owner.testnet`, authorized verifier account, and all required positive storage deposits.
3. Load execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061` and confirm read-only chain state shows project `0`, milestone `0`, and `InProgress`.
4. In a verifier wallet session, connect only the authorized verifier account and request independent verification. Confirm the receipt is `Passed` and the browser displays the exact receipt ID and artifact digest.
5. Sign `submit_verification` with the verifier wallet. Confirm the API reconciles a finalized transaction and chain state becomes `VerificationPassed`.
6. Disconnect the verifier and connect `lateram9099.testnet` as owner. Confirm the approval action is disabled for any other account.
7. Sign `approve_milestone`; confirm finalized state becomes `OwnerApproved` and the receipt ID matches exactly.
8. Sign `settle_milestone`; confirm the UI first shows `PaymentPending`, then polls until the callback changes state to `Paid`.
9. Verify final balances: `reserved_balance` decreases by `0.01 NEAR`, `paid_balance` increases by `0.01 NEAR`, `pending_payment` becomes `null`, and the milestone is `Paid`.
10. Preserve all finalized hashes and before/after chain views as a new evidence artifact. Do not overwrite the existing execution history or failed verification receipt.

This audit performed no signing and no blockchain writes.
