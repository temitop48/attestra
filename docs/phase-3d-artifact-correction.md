# Phase 3D Artifact Correction Report

Date: 2026-11-12

## Executive result

A compliant FocusFlow artifact was produced through the existing Research → Builder → QA workflow using a deterministic local provider. The original execution and revision 3 were not modified. QA passed, and a new verifier-v3 receipt was persisted and survived an API restart.

The payment demonstration is **not authorized**. The new execution was server-assigned off-chain milestone `4`, while the live chain milestone is `0`. Consequently, the passing receipt is bound to project `0` / milestone `4`, not project `0` / milestone `0`. Preparing a chain intent from it would be unsafe and is correctly blocked by the existing linkage checks.

## Rework capability and execution choice

The original execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061` already contains three Builder revisions. The orchestrator accepts rework attempts only in the bounded range 1–3; there is no supported fourth-revision endpoint. I did not bypass that limit or alter revision 3.

A fresh execution was therefore necessary. The first correction attempt was rejected by normal QA for genuine accessibility findings. A second corrected attempt also exposed the API restart race during local validation. The successful fresh execution is:

- Execution: `exec-b4d37157-8bde-4e87-9188-feefa1927027`
- Project field: `0`
- Server-assigned off-chain milestone: `4`
- Artifact revision: `1`
- Artifact digest: `5d7747cd70d5341c2b5bd5f6389be2e91fdba94f1def73c9f0f20f740c034d69`
- Artifact size: `2989` bytes
- QA: passed with no findings
- Lifecycle: `AwaitingIndependentVerification`

The historical execution remains unchanged:

- Execution: `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`
- Historical artifact: revision `3`
- Historical digest: `7b8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a`
- Historical receipt: `attest-1794473689115-m0pqv0xw`
- Historical result: `Failed`

## Artifact acceptance evidence

The corrected artifact contains:

- Visible total, completed, and remaining counters.
- Add-task form with explicit text input type and accessible submit naming.
- Complete/undo behavior using an explicit button.
- Delete behavior using an explicit button.
- `localStorage.getItem` and `localStorage.setItem` persistence.
- Counter recomputation after every add, complete, undo, or delete operation.
- Responsive CSS with a mobile media query.
- Semantic landmarks, labels, language declaration, and accessible dynamic controls.
- Only local HTML, CSS, and JavaScript files.
- No remote resources, `eval`, `new Function`, or `javascript:` URLs.

The independent verifier ran 22 required checks: artifact integrity, file structure, paths, media types, size, HTML structure, stylesheet reference, required sections, accessibility, remote-resource checks, unsafe-code checks, and eight deterministic acceptance checks. All checks passed; none were skipped.

## Independent verification

The new receipt is:

- Receipt ID: `attest-1794488495989-0z3nt678`
- Result: `Passed`
- Verifier: `attestra-independent-verifier-v3`
- Execution: `exec-b4d37157-8bde-4e87-9188-feefa1927027`
- Revision: `1`
- Digest: `5d8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a`
- Project: `0`
- Receipt milestone: `4`
- Policy: `verification-policy-v1`
- LLM review: disabled

The receipt has a unique ID and does not overwrite the rejected receipt. It is not replayable against a different milestone under the API’s server-controlled milestone identity checks. However, it is intentionally **not** a receipt for the live milestone `0`; that mismatch is the remaining blocker.

## Persistence validation

The corrected execution and passing receipt were read successfully after reopening the API against `apps/api/.data/executions.json`.

The historical execution was also read after restart and retained its original revision 3 digest, rejected receipt ID, v2 verifier label, confirmed chain linkage, and milestone `0`. No historical record was edited or reconstructed.

The persistence test also exposed a real operational race: closing an API instance immediately after an asynchronous execution can interrupt the background workflow because `app.close()` does not await the detached orchestration promise. The production persistence behavior is safe once the execution reaches completed state and pending writes drain; the isolated API test suite currently passes. A lifecycle shutdown/drain mechanism remains advisable before judging under forced restarts.

## On-chain linkage and payment readiness

The existing chain state is project `0`, milestone `0`, owner/recipient `lateram9099.testnet`, budget `0.01 NEAR`, and status `InProgress`. The new execution is `unlinked`, and its receipt milestone is `4`.

The current safe correction path is therefore:

1. Do not submit the new receipt to the contract.
2. Do not approve or settle milestone `0`.
3. Add a narrowly scoped, authenticated off-chain attachment flow that verifies project/milestone `0` through read-only RPC, checks owner/recipient/budget/network/contract, and binds the new execution to the existing chain milestone without reusing historical transaction hashes.
4. Make verification use the confirmed on-chain milestone identity when such an attachment exists.
5. Re-run independent verification so the new receipt explicitly contains project `0` / milestone `0`.
6. Restart and re-read the execution and receipt before any browser transaction.

An alternative is a genuinely fresh on-chain project/milestone, but that would violate the current demonstration target and requires blockchain transactions. No chain transaction was performed here.

## Test reliability

The complete workspace test run passed:

- Agents: 40 tests
- Web: 21 tests
- Shared: 2 tests
- Near-readonly: 4 tests
- Orchestrator: 22 tests
- Verification: 44 tests
- API: 27 tests

The API execution test file was then run five consecutive times in isolation; all five runs passed, including the asynchronous execution polling test. The reported timeout was not reproduced as an application defect. The evidence is consistent with timing/resource contention around detached asynchronous orchestration and persistence, not a deterministic verifier or artifact failure. No unrelated timing change was made.

## Remaining blockers

1. Fresh-execution-to-existing-milestone attachment is not implemented.
2. The verification endpoint currently binds a fresh execution to its server-assigned off-chain milestone, producing milestone `4` here.
3. The detached background execution is not drained by API shutdown, so an immediate restart can mark a still-running execution as interrupted.
4. Until a receipt explicitly bound to project `0` / milestone `0` is persisted, verifier-wallet submission, owner approval, and settlement must remain blocked.

## Browser testing sequence after the blockers are resolved

1. Open the local ATTESTRA website and load the corrected execution.
2. Confirm the artifact digest is `5d8587b41df9b7ecdab54046e09299b2a708075ccdd23ba10da904148fc7a73a`.
3. Confirm the receipt is `Passed`, verifier v3, and explicitly bound to project `0` / milestone `0`.
4. Connect only `verifier.attestra-owner.testnet`; verify the UI shows the authorized verifier account and refuses owner-only accounts for verification submission.
5. Review every mandatory check and confirm there are no skipped required checks.
6. Have the verifier wallet submit verification through the browser; wait for finalized status and confirm the chain state becomes `VerificationPassed`.
7. Switch to `lateram9099.testnet`; confirm the approval action references the new receipt ID, never the rejected receipt.
8. Approve the milestone and wait for finality; confirm `OwnerApproved`.
9. Settle the milestone and wait for the asynchronous callback; confirm the payment is `0.01 NEAR` to `lateram9099.testnet`.
10. Confirm finalized evidence, settlement transaction hash, duplicate-settlement protection, and final `Paid` status in the UI.

Do not begin step 4 until the receipt’s milestone field is `0` and the API reports confirmed linkage to the existing chain milestone.
