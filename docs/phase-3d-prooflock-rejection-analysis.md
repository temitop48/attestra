# Phase 3D PROOFLOCK rejection analysis

**Date:** 2026-11-12  
**Execution:** `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac`  
**Scope:** Read-only inspection of the persisted execution, immutable revision 2 artifacts, verifier implementation, and verification policy.

## Executive conclusion

The rejection is real and must remain immutable, but it was not caused by a detected artifact defect. The receipt contains **zero failed checks** and three **required checks marked skipped**. Under the current verifier, required checks must have status `passed`, so the skipped checks make `deterministicPassed` false and produce `DETERMINISTIC_CHECK_FAILED`.

Revision 2 visibly implements all three skipped behaviors:

- `input.value.trim()` rejects empty and whitespace-only task submissions;
- task text is rendered with `textContent`;
- the UI is built with DOM APIs and does not inject task content as HTML.

The minimum safe classification is **B/C: verifier implementation coverage defect and resulting missing deterministic evidence**, not an artifact defect and not a chain-binding defect. The existing rejected receipt and artifact must not be rewritten or treated as payment authorization.

## Persisted verification record

The record was read from `apps/api/.data/executions.json` for the requested execution.

- Receipt ID: `attest-1794504848275-qiuysqwp`
- Attempt ID: `faaab414-c132-4e9d-a126-e3833b8fc083`
- Artifact revision: `2`
- Artifact digest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`
- Policy: `verification-policy-v1`
- Verifier engine ID: `attestra-independent-verifier-v1`
- Verifier implementation: `attestra-independent-verifier-v3`
- LLM review: `disabled`
- Result: `Failed`
- Failure: `DETERMINISTIC_CHECK_FAILED` — “One or more mandatory deterministic checks failed”
- Failure stage: `deterministic`
- Retryable: `false`
- Verification timestamp: `2026-11-12T17:34:08.276Z`

### All 27 checks

| ID | Required | Status | Result/evidence |
|---|---:|---|---|
| `artifact_digest` | yes | passed | Digest matches expected manifest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6` |
| `required_index` | yes | passed | `index.html` present |
| `required_styles` | yes | passed | `styles.css` present |
| `artifact_paths` | yes | passed | Paths are relative and traversal-safe |
| `artifact_media_types` | yes | passed | Supported media types |
| `artifact_sizes` | yes | passed | `3582 bytes total` |
| `html_structure` | yes | passed | Required HTML/head/title/body structure present |
| `stylesheet_reference` | yes | passed | Local `styles.css` referenced |
| `required_sections` | yes | passed | All required sections represented |
| `accessibility` | yes | passed | Language and basic accessible labeling present |
| `remote_scripts` | yes | passed | No remote scripts |
| `external_resources` | yes | passed | No remote dependencies |
| `unsafe_inline_scripts` | yes | passed | No prohibited dynamic-code patterns |
| `acceptance_0` | yes | passed | localStorage persistence covered |
| `acceptance_1` | yes | **skipped** | Could not establish input validation for empty/whitespace-only tasks |
| `acceptance_2` | yes | **skipped** | Could not establish `textContent` safe DOM manipulation |
| `acceptance_3` | yes | passed | Real-time total/completed/remaining counters covered |
| `acceptance_4` | yes | passed | No external dependencies or remote resources |
| `acceptance_5` | yes | passed | Semantic and accessible HTML |
| `acceptance_6` | yes | passed | HTML, CSS, and vanilla JavaScript only |
| `acceptance_7` | yes | passed | No external resources |
| `acceptance_8` | yes | passed | No third-party libraries/frameworks |
| `acceptance_9` | yes | passed | No `eval` or unsafe dynamic code execution |
| `acceptance_10` | yes | **skipped** | Could not establish safe DOM manipulation |
| `acceptance_11` | yes | passed | Desktop/mobile layout covered |
| `acceptance_12` | yes | passed | Tasks persisted with localStorage |
| `acceptance_13` | yes | passed | Separate task counters displayed |

There are no failed checks. The failed-check set is empty. The mandatory-skipped set is:

1. `acceptance_1`: empty/whitespace-only input validation.
2. `acceptance_2`: `textContent` safe DOM manipulation.
3. `acceptance_10`: safe DOM manipulation.

The rejection follows directly from the verifier's calculation:

```text
every required check must have status === "passed"
```

`skipped` is not accepted as passing, even though the check is marked required.

## Revision 2 artifact inspection

The stored manifest is immutable revision 2 with the digest above. It contains exactly `index.html`, `styles.css`, and `script.js`.

### Functional requirements

- **Task creation:** `form.onsubmit` trims input, rejects a falsy trimmed value, pushes `{ text, done: false }`, clears the input, and refreshes the UI.
- **Completion and reversal:** each task gets a `Done`/`Undo` button; `toggleTask` reverses `t.done` and refreshes the UI.
- **Deletion:** each task gets a `Delete` button; `deleteTask` removes the indexed task and refreshes the UI.
- **Counters:** `total-count`, `completed-count`, and `remaining-count` are independently visible in the HTML and assigned from the current task collection on every update.
- **Persistence:** `localStorage.getItem('tasks')` initializes the collection and `localStorage.setItem('tasks', JSON.stringify(tasks))` runs on every UI update.
- **Empty state:** `empty-state-message` is present and is hidden only when tasks exist.
- **Whitespace-only input:** `input.value.trim()` prevents insertion of blank or whitespace-only tasks.
- **Safe rendering:** task text is assigned with `span.textContent = t.text`; buttons and list nodes are created with DOM APIs. `list.innerHTML = ''` is used only to clear a container with a fixed empty string; no user-controlled value is assigned to `innerHTML`.
- **Responsive layout:** the CSS contains a mobile media query changing the three-column statistics grid to one column below 480px.
- **Basic accessibility:** `html lang="en"`, an `aria-label` for the input, visible button text, and semantic `header`, `main`, `form`, `ul`, and `li` elements are present. Generated buttons are keyboard-focusable native buttons.
- **No external dependencies:** the only stylesheet and script references are local files; no library, font, API, or remote resource is referenced.
- **No unsafe dynamic code:** no `eval`, `new Function`, or `javascript:` pattern is present.

The source therefore supports the conclusion that the three skipped acceptance criteria are verifier detection gaps. This inspection does not convert the historical receipt into a passing receipt.

## Verifier behavior and defect

`packages/verification/src/index.ts` has explicit deterministic handlers for localStorage, counters, CRUD, remote resources, accessibility, responsive CSS, and unsafe code. It does not have an `acceptanceCovered` handler for:

- input validation / whitespace rejection;
- `textContent` safe DOM manipulation;
- the generic safe DOM manipulation criterion.

Those criteria fall through to the default `unknown` result. The verifier then changes the check status to `skipped`. Because all acceptance checks are constructed as required, the final calculation rejects any receipt containing one of these skips.

This is a verifier implementation/evidence-coverage defect. The policy itself is behaving fail-closed: it does not silently treat unknown mandatory criteria as passed. The policy must not be weakened merely to make this receipt pass. If verifier code is corrected later, it must be versioned and applied only through a new verification attempt; it must not mutate this receipt.

## Execution-to-chain binding

The execution is linked to the intended NEAR resource:

- Network: `testnet`
- Contract: `escrow.attestra-owner.testnet`
- On-chain project: `0`
- On-chain milestone: `0`
- Owner: `lateram9099.testnet`
- Recipient: `lateram9099.testnet`
- Budget: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Linkage status: `confirmed`

The record also contains internal/off-chain milestone ID `2` and explicitly preserves it as `offChainMilestoneId: "2"`. That is distinct from the authoritative on-chain milestone ID `0`; it is not evidence of a mismatch because the binding stores both namespaces separately. The receipt itself is bound to `projectId: "0"` and `milestoneId: "0"`, matching the on-chain linkage.

The chain-binding status is therefore **correct and confirmed** based on the persisted record. No RPC write or transaction was performed in this investigation.

## Recovery recommendation

1. Preserve receipt `attest-1794504848275-qiuysqwp`, attempt `faaab414-c132-4e9d-a126-e3833b8fc083`, revision 2, and its digest unchanged.
2. Preserve the execution and all prior QA/revision evidence unchanged.
3. Fix or extend the verifier implementation with explicit, reviewable deterministic checks for trimmed input validation and safe text rendering. Version the verifier implementation; do not alter `verification-policy-v1` semantics to treat required skips as passing.
4. Add verifier tests proving the checks pass for this exact immutable artifact and fail for artifacts that omit trimming or render task text unsafely.
5. Re-run verification as a new attempt against the unchanged revision 2 only if the API's legitimate re-verification path allows it. The new receipt must have a new ID, preserve the old rejected receipt, recompute and match the same digest, and remain bound to project 0/milestone 0.
6. Do not generate a passing receipt manually and do not authorize payment from the historical rejected receipt.

## Reuse decision

The existing execution can be safely reused as an evidence source and for a legitimate re-verification attempt because:

- its final artifact is present and internally digest-consistent;
- QA approved revision 2;
- its chain linkage is confirmed to project 0/milestone 0;
- the rejected receipt is immutable and payment-ineligible.

The execution must not be considered independently verified until a new, genuinely passing receipt is produced. A new artifact revision is **not necessary based on the source inspection**. A new verifier implementation/version is necessary unless the existing verifier is extended to deterministically establish the three currently skipped mandatory checks. A fresh AI execution is not required for this verifier-only recovery.

## Files inspected

- `apps/api/.data/executions.json`
- `packages/verification/src/index.ts`
- `packages/agents/src/html-validation.ts`
- `apps/api/src/app.ts`
- `apps/api/src/store.ts`

No source, artifact, receipt, execution record, policy, or blockchain state was modified.
