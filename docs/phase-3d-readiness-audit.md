# ATTESTRA Phase 3D Readiness Audit

Generated: 2026-11-12  
Auditor scope: NEAR Testnet read-only recovery, smart-contract review, API/UI security review, and execution-record consistency.

## Executive conclusion

Phase 3D is structurally implemented and ready for a controlled browser demonstration after configuration and one deployed-contract discovery issue is acknowledged. The recovered execution is correctly linked to the original Testnet project and milestone through five finalized transactions. The milestone is still `InProgress`; no verification submission, owner approval, or settlement has occurred.

The empty `get_project_ids` result is not caused by query arguments, pagination, owner spelling, RPC serialization, or the TypeScript adapter. The deployed contract exposes the expected method and the deployed WASM hash matches the local release artifact, but the method’s `IterableMap::iter()` owner-filtered enumeration returns no IDs while keyed lookup returns project `0`. This is a deployed contract/indexing/view defect. It cannot be repaired without an authorized contract upgrade; the browser demo can use the already confirmed project linkage and project ID `0`.

No contract, execution record, receipt, or blockchain state was modified during this audit. No wallet signing or blockchain transaction was performed.

## 1. `get_project_ids` investigation

### Exact deployed and source signature

The source contract defines:

```rust
pub fn get_project_ids(
    &self,
    owner: AccountId,
    from_index: u64,
    limit: u64,
) -> Vec<u64>
```

The implementation bounds the limit and enumerates the top-level collection:

```rust
self.projects
    .iter()
    .filter(|(_, project)| project.owner == owner)
    .map(|(project_id, _)| *project_id)
    .skip(from_index as usize)
    .take(limit as usize)
    .collect()
```

The deployed WASM SHA-256 is `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`, matching both the deployment report and the current local release artifact.

### RPC call validation

The read-only call used:

```json
{
  "owner": "lateram9099.testnet",
  "from_index": 0,
  "limit": 50
}
```

The base64 payload decodes exactly to that JSON. The owner account is lowercase and matches the owner returned by `get_project(0)` and the `project_created` receipt. `from_index: 0` and `limit: 50` are valid; the contract’s maximum page size is not the cause.

The call returned `[]` at finalized block heights `277361228` and `277361457`.

### Comparison with keyed views and receipts

At finalized state:

- `get_project(0)` returns project `0` with owner `lateram9099.testnet`.
- The `create_project` receipt logs `project_id: 0` and owner `lateram9099.testnet`.
- `get_milestone(0, 0)` returns the expected milestone.
- The five lifecycle receipts all target the same deployed contract.

Therefore:

| Hypothesis | Result |
|---|---|
| Incorrect query usage | Rejected: signature, field names, owner, pagination, and base64 JSON are correct. |
| API adapter issue | Rejected for this symptom: the raw RPC call reproduces it; the adapter does not implement a separate project-ID discovery path. |
| Pagination/serialization issue | Rejected: zero-based pagination and decoded JSON are valid, and keyed views deserialize correctly. |
| Owner mismatch | Rejected: direct project state and the creation receipt contain the exact queried owner. |
| Deployed contract/indexing defect | **Most likely; confirmed operationally.** `IterableMap::iter()` enumeration does not expose the persisted project to this view, while keyed lookup does. |

The create path calls `self.projects.insert(...)` and invokes `flush_for_storage_measurement`, which flushes the top-level map. The deployed behavior nevertheless shows that owner-based iteration is not reliable. Existing unit coverage checks sequential IDs and owner assignment but does not test `get_project_ids`; this is a coverage gap.

### Does the contract require modification?

Not to complete the immediate browser demonstration. The existing confirmed linkage already identifies project `0` and milestone `0`, and the API validates keyed project/milestone state before lifecycle operations.

For production-grade owner project discovery, yes: the contract needs an authorized upgrade or a new indexed method/storage design, followed by migration and Testnet regression testing. No such upgrade should be performed as part of hackathon demonstration preparation.

## 2. Recovered execution linkage

The relevant record is:

```text
exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061
```

It is stored in `apps/api/.data/executions.json` with `onChainLinkage.status: "confirmed"`.

| Linkage field | Recovered value | Assessment |
|---|---|---|
| On-chain project | `0` | Correct; matches direct RPC state and receipt. |
| On-chain milestone | `0` | Correct; matches direct RPC state and receipt. |
| Owner | `lateram9099.testnet` | Correct on-chain. The linkage record does not duplicate owner; it is verified from chain state. |
| Recipient | `lateram9099.testnet` | Correct; matches milestone view and registration arguments. |
| Budget | `10000000000000000000000` yoctoNEAR (`0.01 NEAR`) | Exact match. |
| Project creation hash | `DHK7Fd6e1STSM4CbNAMPK2d4GAnYWijVkJVERsLCjC4r` | Final and valid. |
| Milestone registration hash | `FK3KSdz1NFYsdPAo854xHgcwMGwJcjb4EYAv1S618ag9` | Final and valid. |
| Funding hash | `4YV5eQSMs4gnEZNqjqDwhk85upAWsdVZKk6Dv4BuAHHc` | Final and valid. |
| Activation hash | `BL5duj7bPn7BbmwMrtRDdk2AWspriywZQxnJYvqoawVR` | Final and valid. |
| Start hash | `JCLFBTdLthyWZqdFmxkiH5rixCF6zti9VBFZ7AeVYxTi` | Final and valid. |

One off-chain inconsistency exists: the record’s top-level `projectId` is `null`, while `onChainLinkage.onChainProjectId` is `"0"`. This does not undermine the confirmed chain linkage because the API uses the explicit on-chain linkage and verifies keyed chain state. It should remain documented rather than repaired by rewriting history.

The record’s final artifact digest and failed verification receipt digest are identical:

```text
7b8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a
```

The receipt is `Failed`, for project `0`, milestone `0`; it is not authorization to submit verification or release payment.

## 3. Phase 3D readiness audit

| Capability | Status | Security assessment |
|---|---|---|
| Authorized verifier wallet connection | Implemented | NEP-413 challenge signing is verified server-side, the account’s finalized access key must be `FullAccess`, and the session stores the signed account ID. |
| Independent verification submission | Implemented, not executed for this project | The API requires the authenticated account to equal `NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID`, requires `InProgress`, and requires a current passing receipt. The contract independently checks its authorized verifier predecessor. |
| Finalized verification reconciliation | Implemented | Reconciliation requires final success, exact receiver, one function call, exact method, signer identity, deposit, project/milestone IDs, receipt ID, digest, result, and resulting `VerificationPassed` state. |
| Owner approval | Implemented, not executed | The API requires the authenticated account to equal the on-chain project owner and checks matching passing verification, verifier, digest, and receipt. The contract repeats owner and receipt checks. |
| Payment settlement | Implemented, not executed | The API requires `OwnerApproved`, no pending payment, and matching approval. The contract requires owner approval, paid dependencies, sufficient reservation, and serializes project transfers. |
| Asynchronous settlement callback | Implemented and unit-tested | The private callback verifies contract predecessor, one promise result, operation ID, project, milestone, amount, recipient, and `PaymentPending` before accounting transitions. Successful callback marks `Paid`; failed callback preserves reservation and returns to approval-required state. |
| Payment evidence display | Implemented | The UI displays transaction hashes and chain balances, polls `PaymentPending`, supports reconciliation, and explicitly does not treat a hash as payment success. |

### Verifier impersonation and receipt replay

The owner cannot impersonate the verifier through the API because:

1. The wallet session account comes from a verified signed NEAR challenge, not client-supplied authorization.
2. `submit_verification` intent and reconciliation require the account to equal the configured authorized verifier.
3. The contract checks the predecessor against its authorized verifier account.
4. Owner approval is handled by a separate owner-only branch and cannot submit verification.

Rejected, stale, or outdated receipts cannot authorize payment because `latestPassingReceipt` requires:

- latest attempt status `verified`;
- result `Passed`;
- current final artifact digest;
- matching revision and execution ID;
- matching project and milestone IDs;
- current policy version and verifier implementation version;
- every required check passed.

The API and contract also require the on-chain verification digest/receipt/verifier to match before approval, and settlement requires the approval receipt to match the latest passing receipt.

## 4. Remaining blockers and minimum changes

### Priority 1 — required before browser demonstration

1. Configure the API with the real authorized verifier account and positive verification, approval, and settlement storage deposits. The current local environment does not visibly provide all of these values.
2. Ensure the API and browser use the same working directory and `apps/api/.data/executions.json` database path.
3. Produce a fresh passing off-chain verification for the recovered final deliverable under the authoritative criteria. Preserve the existing failed receipt as history.
4. Test verifier and owner in separate wallet sessions. Do not use the owner wallet for verifier submission.

### Priority 2 — correctness blocker for general project discovery

5. Treat `get_project_ids` as unreliable for the deployed contract. Use the confirmed project linkage for the hackathon flow.
6. After the hackathon, add a contract-level regression test for `get_project_ids`, investigate the deployed `IterableMap` storage/index behavior, and only then consider an authorized upgrade or migration.

### Priority 3 — non-blocking cleanup

7. Add a test asserting `get_project_ids(owner, 0, limit)` returns created projects.
8. Add an explicit invariant/test documenting that `onChainLinkage.onChainProjectId` is authoritative when the legacy/top-level `projectId` is absent.

No unrelated features or source changes are required for the controlled demo. No source code was changed during this audit because the confirmed defect is on the deployed contract/view path and cannot be safely fixed off-chain by fabricating an index.

## 5. Exact browser sequence

1. Start the API from `apps/api` using the intended local environment and confirm the database path is `apps/api/.data/executions.json`.
2. Confirm `/api/v1/near/config` reports Testnet, `escrow.attestra-owner.testnet`, authorized verifier, and all three lifecycle storage deposits.
3. Open execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`; confirm project `0`, milestone `0`, recipient, budget, and `InProgress` from keyed chain state.
4. Connect only the authorized verifier wallet. Request independent verification and confirm a `Passed` receipt with the final artifact digest.
5. Sign `submit_verification`. Wait for finalized reconciliation and confirm milestone status `VerificationPassed`.
6. Disconnect the verifier and connect `lateram9099.testnet`. Confirm a different account cannot enable approval.
7. Sign `approve_milestone`. Confirm finalized `OwnerApproved` and exact receipt binding.
8. Sign `settle_milestone`. Confirm the UI first shows `PaymentPending`, then waits for callback-updated `Paid` state.
9. Confirm final chain accounting: `pending_payment: null`, reserved balance reduced by `0.01 NEAR`, paid balance increased by `0.01 NEAR`, and milestone status `Paid`.
10. Save the new finalized hashes and before/after chain views separately. Do not overwrite the recovered JSON record or failed receipt.

This report is based on read-only RPC calls and local inspection only.
