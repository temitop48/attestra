# Phase 3D re-verification UI investigation

**Date:** 2026-11-12  
**Execution:** `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac`

## Executive result

The re-verification authorization gates were not bypassed. The UI had one confirmed defect: when the re-verification form was available, an empty or whitespace-only reason disabled the button without showing the operator why.

The smallest fix adds explicit disabled-state explanations while preserving every existing gate. No verification request was created by this investigation, no receipt was modified, and no blockchain operation was performed.

During inspection, the persisted execution state had already changed from the previously reported v3 rejection: it contained an externally-produced v4 passing attempt and receipt. That state was read only and was not created or changed by this work.

## Frontend disabled-state analysis

`apps/web/src/components/verification-panel.tsx` disables the re-verification button when any of these conditions holds:

- the execution is not eligible according to QA, lifecycle, artifact, and validation checks;
- confirmed chain linkage is unavailable for a payment-eligible execution;
- a request is being submitted;
- verification status is loading;
- verification is already in progress;
- the reason is empty after trimming;
- local verification writes are disabled in a production browser.

The original component displayed general eligibility and chain notices, but it did not display the reason associated with the `!reason.trim()` predicate. Therefore the button could appear inexplicably disabled even though the only missing input was the reason field.

## Backend eligibility and authorization

The backend remains authoritative and secure:

- `verificationEligibility` requires a completed execution in `AwaitingIndependentVerification` state.
- The final artifact must exist and its canonical digest must match the stored digest.
- QA must have approved the exact final revision and digest.
- A deterministic validation report must exist without blocking failures.
- Re-verification requires a non-empty, trimmed reason of at most 500 characters.
- A previous attempt requires either a changed server-controlled verifier/policy version or a recoverable interrupted attempt.
- The client cannot override the verifier implementation version or policy.
- Payment-backed chain operations continue to require confirmed chain linkage and exact receipt/project/milestone bindings.

The reason field was not the only theoretical gate: it is only the missing requirement when the backend reports `reverification.available: true`, eligibility is true, chain linkage is ready, status is not loading/in-progress, and local writes are enabled. The new UI exposes all applicable reasons instead of guessing.

## Current persisted execution state

The read-only store inspection showed:

- lifecycle: `completed`
- status: `AwaitingIndependentVerification`
- final revision: `2`
- digest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`
- chain linkage: `confirmed`
- on-chain project: `0`
- on-chain milestone: `0`
- internal/off-chain milestone: `2`
- historical v3 receipt: `attest-1794504848275-qiuysqwp`, rejected
- current v4 receipt: `attest-1794510501481-h8yi6rpx`, passed
- current attempt verifier: `attestra-independent-verifier-v4`

Because the latest attempt is already v4 and the server also uses v4, the backend correctly reports that another re-verification is not available merely for the same version. If a browser still displays the old re-verification form, it is stale UI/API state; refresh the execution and verification panel. The next workflow is payment demonstration, not another verification attempt.

## Running API/version confirmation

No API process was listening on `127.0.0.1:4000` during the read-only probe, so a live process could not be interrogated directly. The compiled server dependency and verifier distribution both contain `attestra-independent-verifier-v4`, and no v3 production constant was found in the compiled verifier/API output. The persisted current v4 attempt is consistent with an API running the v4 code, but the absence of a live process means this report does not claim an active server-process check.

Before browser testing, start/restart the API from the current build and refresh the page. Then confirm the verification response reports the v4 attempt and passing receipt before any payment intent is requested.

## Changes made

### `apps/web/src/components/verification-panel.tsx`

- Added `reverificationDisabledReasons` to compute explicit, deduplicated messages for every disabled-state predicate.
- Added an `aria-live="polite"` list beneath the re-verification button.
- Kept the existing `disabled` expression and request handler unchanged; messages do not weaken authorization or eligibility.

### `apps/web/test/components.test.tsx`

Added regression coverage proving that:

- blank/whitespace reason reports the missing reason;
- ineligible and unconfirmed-linkage states report both applicable blockers.

### `apps/api/test/executions.test.ts`

Updated synthetic current-verifier expectations from v3 to v4 where required by the verifier version bump. Explicit legacy v3 fixtures remain v3 so historical compatibility tests retain their meaning.

## Validation

- Frontend typecheck: passed.
- Frontend lint: passed.
- Frontend tests: **25/25 passed**.
- API tests: **29/29 passed**.
- Production build: passed.

The API test suite initially exposed stale expectations for v3 and was corrected to expect v4 for current synthetic attempts. No application security failure was found.

## Readiness and exact next steps

The browser is ready to display accurate re-verification blockers, but a fresh re-verification request is **not currently eligible or necessary** because the persisted execution already has a v4 passing receipt. Do not submit another verification request.

For browser retesting:

1. Restart the API using the current build and open `/workspace`.
2. Select execution `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac`.
3. Refresh the verification panel and confirm the v4 passed receipt and unchanged digest.
4. Confirm the historical v3 rejection remains visible in verification history.
5. Confirm the chain panel still shows project `0`, milestone `0`, and `InProgress`.
6. Continue only with the authorized verifier-wallet submission flow, then owner approval and settlement, using the displayed v4 receipt. Those are human wallet actions and were not executed here.

If the operator intentionally tests the form against a stale v3 state in a disposable local fixture, enter a non-empty reason. The UI will now explicitly say `Enter an explicit reason before requesting re-verification.` while the field is blank; the backend remains the final authority.
