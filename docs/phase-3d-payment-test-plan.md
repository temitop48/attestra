# ATTESTRA Phase 3D Proof-Gated Payment Test Plan

Generated: 2026-11-12  
Network: NEAR Testnet  
Contract: `escrow.attestra-owner.testnet`  
Project: `0`  
Milestone: `0`

## Executive decision

Reuse the existing project, milestone, execution, and revision 3 artifact. Do not create a fresh project or milestone, and do not create a second execution solely to bypass the rejected receipt.

The recovered execution already contains a corrected revision 3 artifact whose exact digest is:

```text
7b8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a
```

The current verifier evaluates that exact artifact with all mandatory checks passed. The historical rejected receipt was produced before the deterministic acceptance-criteria coverage fix, but was labeled with the same verifier implementation version. That stale version prevented the API’s safe re-verification gate from recognizing the verifier behavior change.

A minimal off-chain fix was made: `VERIFIER_IMPLEMENTATION_VERSION` is now `attestra-independent-verifier-v3`. This is a server-controlled version bump only; it does not alter the artifact, rejected receipt, execution record, contract, or chain state. It allows an explicit, auditable re-verification attempt while preserving the rejected `v2` receipt.

## 1. Recovered execution and artifact assessment

Execution:

```text
exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061
```

Stored at:

```text
apps/api/.data/executions.json
```

### Execution state

- Lifecycle: `completed`
- Status: `AwaitingIndependentVerification`
- On-chain project: `0`
- On-chain milestone: `0`
- Recipient: `lateram9099.testnet`
- Budget: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Existing chain state: `InProgress`
- Original requirements: FocusFlow task dashboard with add, complete, delete, counters, localStorage, responsive layout, semantic/accessibility requirements, and no external dependencies.

### Revision history

| Revision | Digest | QA | Verification result | Decision |
|---:|---|---|---|---|
| 1 | `92b887b4e75bea256203ec151431f85d22fb3840407638c4533b2c737e7651f2` | Failed | Not submitted | Historical only |
| 2 | `b12f422d1471fe54ef81f01323348982568d82ce6b7fb964c18654a53fb5d22c` | Failed | Not submitted | Historical only |
| 3 | `7b8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a` | Passed | Rejected by stale verifier behavior | Reuse unchanged |

Revision 3 contains `index.html`, `styles.css`, and `script.js`. It uses `textContent` for task text rendering, localStorage, responsive CSS, accessible labels/headings, plain HTML/CSS/JavaScript, and no remote resources.

### Historical rejected receipt

Receipt:

```text
attest-1794473689115-m0pqv0xw
```

It is preserved as `status: rejected`, `result: Failed`, for project `0`, milestone `0`, and the exact revision 3 digest. It must not be reused, edited, deleted, or treated as payment authorization.

The rejection recorded mandatory acceptance checks as `skipped`, including vanilla implementation, localStorage, counters, CRUD, and dynamic-code criteria. The current verifier deterministically evaluates these checks as `passed` for the unchanged revision 3 artifact. A direct local run confirmed `result: Passed` and every mandatory check `passed` without invoking Gemini or changing records.

## 2. Safest correction path

### Option A — new revision of the existing execution

The orchestrator supports immutable revisions during its original Research → Builder → QA loop, and this execution already reached revision 3. There is no public API to append a new builder revision to a completed execution without modifying persisted historical state.

More importantly, a new artifact revision is unnecessary: revision 3 already passed QA and now passes the corrected deterministic verifier.

### Option B — fresh execution bound to project 0/milestone 0

Not recommended. It would create a second off-chain execution for the same chain work, complicate digest/receipt provenance, and conflict with the existing transaction-hash uniqueness and immutable linkage model. It is unnecessary and increases demo risk.

### Option C — fresh project and milestone

Not recommended. The recovered project has the exact budget and valid `InProgress` state required for the first proof-gated payment. Creating another project would add funding and lifecycle risk without improving evidence quality.

### Selected path

Use the existing execution and revision 3. Request a fresh verification under `v3` with an explicit reason such as:

```text
Re-evaluate unchanged revision 3 after the server-controlled verifier v3 deterministic acceptance-criteria coverage fix. Preserve the prior rejected v2 receipt as historical evidence.
```

The API will create a new attempt and receipt; it will not overwrite the prior receipt. The new receipt must be independently inspected before any wallet signing.

## 3. Acceptance criteria and fail-closed rules

The current verifier must evaluate the actual stored revision 3 artifacts, recompute the canonical SHA-256 digest, and bind the new receipt to:

- execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`;
- project `0`;
- milestone `0`;
- revision `3`;
- digest `7b8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a`;
- verifier implementation `attestra-independent-verifier-v3`.

Mandatory checks must all be `passed`. Any `failed` or `skipped` mandatory check must prevent a `Passed` receipt and prevent `submit_verification` intent creation. No manual criteria override, receipt editing, or client-supplied verifier version is permitted.

The criteria to verify are:

- add tasks;
- complete/undo tasks;
- delete tasks;
- correct remaining-task counter updates;
- browser localStorage persistence;
- responsive desktop/mobile CSS;
- semantic and accessible HTML/form labeling;
- plain HTML, CSS, and JavaScript only;
- no external libraries, frameworks, remote resources, `eval`, or dynamic code execution.

The verifier’s deterministic checks establish the static evidence. Browser QA should additionally demonstrate add, complete, delete, refresh persistence, counter updates, empty state, keyboard/focus behavior, and mobile layout. Browser behavior is evidence for the demo, not a replacement for the receipt’s exact digest binding.

## 4. Authorized verifier signing and role separation

Authorized verifier:

```text
verifier.attestra-owner.testnet
```

Project owner:

```text
lateram9099.testnet
```

The verifier flow is:

1. Browser requests a NEP-413 challenge from the API.
2. The verifier wallet signs the challenge message.
3. The API verifies the signature and queries the signer’s finalized access key.
4. The session is bound to the signed account ID.
5. The payment panel enables `submit_verification` only when the session account equals the configured authorized verifier and the milestone is `InProgress` with a passing receipt.
6. The wallet signs the server-issued `submit_verification` function call.
7. The API reconciles finalized transaction evidence and confirms the contract state is `VerificationPassed` with the same receipt ID, digest, and verifier account.

The owner cannot impersonate the verifier because the API compares the authenticated account to `NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID`, the transaction signer is checked during reconciliation, and the contract independently restricts `submit_verification` to its authorized verifier predecessor. Owner approval and settlement use a separate owner-only path based on the on-chain project owner.

Before testing, confirm the API runtime has the authorized verifier account and positive verification/approval/settlement storage deposits configured. Never place private keys, seed phrases, or privileged tokens in the browser bundle.

## 5. Exact browser demonstration sequence

### Preparation

1. Start the API with the intended environment and confirm it opens `apps/api/.data/executions.json`.
2. Confirm `/api/v1/near/config` reports Testnet, `escrow.attestra-owner.testnet`, `verifier.attestra-owner.testnet`, and all required positive lifecycle deposits.
3. Confirm the selected execution is `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`.
4. Confirm keyed chain state shows project `0`, milestone `0`, owner/recipient `lateram9099.testnet`, budget `0.01 NEAR`, and status `InProgress`.
5. Verify the displayed final artifact digest is the revision 3 digest above.

### Browser artifact QA

6. Open the final artifact and test with an empty localStorage key: empty state and zero counters.
7. Add two tasks; verify total and remaining counters.
8. Complete one task; verify completed/remaining counters update correctly.
9. Delete the remaining task; verify list and counters update.
10. Refresh; verify localStorage persistence for the surviving task/state.
11. Test keyboard labels/focus and a mobile viewport. Confirm no external network/resource dependency.

### Independent verification

12. Connect only `verifier.attestra-owner.testnet` in the verifier wallet.
13. Request re-verification with the explicit v3 correction reason above.
14. Confirm the new receipt is `Passed`, has implementation `v3`, project `0`, milestone `0`, revision 3 digest, and no mandatory `skipped` or `failed` checks.
15. Do not continue if any check is skipped, failed, digest-mismatched, or bound to another project/milestone.
16. Request the server-issued `submit_verification` intent and inspect method, IDs, receipt ID, digest, deposit, and receiver before signing.
17. Sign only with the verifier wallet. Reconcile the finalized hash and confirm chain status `VerificationPassed`.

### Owner approval and payment

18. Disconnect the verifier wallet and connect only `lateram9099.testnet`.
19. Confirm the verifier submission action is unavailable to the owner and the approval action is available only for the owner after finalized `VerificationPassed`.
20. Inspect the approval intent: `approve_milestone`, project `0`, milestone `0`, exact new receipt ID, exact approval storage deposit.
21. Sign owner approval and reconcile finalized `OwnerApproved` state.
22. Inspect the settlement intent: `settle_milestone`, project `0`, milestone `0`, exact settlement storage deposit.
23. Sign settlement as the owner. Confirm the UI shows `PaymentPending`, not `Paid`, from the transaction hash alone.
24. Wait for the asynchronous contract callback and poll keyed chain state until it reports `Paid`.
25. Confirm `pending_payment` is `null`, reserved balance decreases by `0.01 NEAR`, paid balance increases by `0.01 NEAR`, and the recipient is `lateram9099.testnet`.
26. Preserve all new finalized hashes, the new receipt, before/after chain views, and the old rejected receipt as separate evidence. Never overwrite historical records.

## 6. Remaining blockers

1. **Runtime configuration:** the verifier account and three lifecycle storage deposits must be explicitly configured and reviewed before the browser run.
2. **Production UI mode:** the verification panel disables verification writes when `NODE_ENV=production`; run the controlled demonstration in the supported development/demo environment or make an explicitly reviewed deployment-mode change. Do not expose a privileged verification token to the client.
3. **Fresh receipt required:** the v3 receipt must be generated and inspected before any contract call. It has not been generated by this audit, and no transaction should be attempted until it exists.
4. **Deployed project discovery defect:** do not use `get_project_ids` for this demonstration; use the confirmed execution linkage and keyed project/milestone views.
5. **No live end-to-end payment evidence yet:** verifier submission, owner approval, callback completion, and `Paid` state remain unexecuted.

## 7. Changes made in this preparation

One minimal source change was made:

- `packages/verification/src/index.ts`: bumped `VERIFIER_IMPLEMENTATION_VERSION` from `v2` to `v3` and documented that the bump represents the deterministic acceptance-criteria coverage fix.
- `apps/api/test/executions.test.ts`: updated test fixtures/expectations to use the new server-controlled version.
- Rebuilt `packages/verification/dist` so the API uses the corrected version locally.

No historical JSON record, artifact, rejected receipt, contract, wallet, or blockchain state was changed.

Validation after the change:

- Verification tests: **44 passed**.
- API tests: **27 passed**.
- Verification and API TypeScript typechecks: **passed**.

The real AI provider was not invoked.
