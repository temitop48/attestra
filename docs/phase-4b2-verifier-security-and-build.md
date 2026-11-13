# Phase 4B.2 verifier security and production build

Date: 2026-11-13

## Result

Zero-deposit verification is feasible as a narrowly scoped contract change, but the currently deployed contract does not support it. The deployed method requires the attached deposit to cover the measured storage delta. The local implementation now supports an exact-zero-deposit path that charges the same delta against the project’s existing storage credit and fails closed when that credit is insufficient.

No contract upgrade, blockchain transaction, key creation, key rotation, or deployment was performed.

## Contract change

Changed `contracts/escrow/src/lib.rs` only:

- Added `charge_verification_storage`.
- Positive attached deposits retain the existing behavior: the deposit must cover the measured storage growth and is credited to the project storage balance.
- A zero attached deposit is accepted only for `submit_verification`.
- The project’s `storage_deposit` must be at least the measured storage growth; otherwise the call panics with `Insufficient project storage credit`.
- On success, the required amount is subtracted from `project.storage_deposit`.
- No serialized state fields were added or reordered.
- Existing verifier authorization, receipt uniqueness, milestone-state checks, digest/receipt bounds, and project/milestone binding remain unchanged.

This is economically defensible because the credit is already held by the escrow for storage. It does not consume project funding, available balance, reserved balance, or milestone budget. It does not create credit when none exists. The transaction is reverted if any later storage/accounting assertion fails.

The change is not safe to apply blindly to the live contract: it requires an administrator-authorized code upgrade and a reviewed deployed-WASM/state-compatibility procedure. The current live contract remains positive-deposit-only until that upgrade is explicitly authorized.

## Tests

Added contract tests for:

- Successful zero-deposit verification using existing project storage credit.
- Rejection when storage credit is insufficient.

Existing tests cover unauthorized verifier calls, receipt replay, failed verification, project/milestone state gates, funding/accounting invariants, and callback behavior.

Validation completed:

- Rust tests: **48 passed, 0 failed**.
- Contract WASM release build: **passed** (`cargo build --target wasm32-unknown-unknown --release`).
- Generated artifact: `contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm`.

No live contract behavior was changed or tested through a write transaction.

## Restricted verifier access-key configuration

After the compatible contract upgrade, the backend signer should use a dedicated FunctionCall access key on `verifier.attestra-owner.testnet` with:

```text
receiver_id: escrow.attestra-owner.testnet
method_names: [submit_verification]
allowance: bounded NEAR amount sufficient for gas only
attached deposit: always 0 yoctoNEAR
signer account: verifier.attestra-owner.testnet
network: testnet
```

The backend must:

1. Load the key only from a server-side secret file/manager.
2. Query the account’s finalized access-key state before readiness.
3. Require the key permission to be FunctionCall, the receiver to match exactly, and the method allowlist to contain only `submit_verification`.
4. Reject FullAccess keys in the public deployment configuration unless an operator explicitly accepts a separate isolated trusted-signer risk.
5. Construct arguments only from the persisted passing PROOFLOCK receipt and authoritative chain linkage.
6. force `deposit = 0` for the restricted-key path and reject any client-supplied deposit.
7. Preserve idempotency and reconcile finalized state before permitting another attempt.

The current backend already constrains the receiver/method/receipt shape at its application boundary, but the signer bootstrap does not yet enforce this on-chain FunctionCall permission shape. That validation should be added before public deployment of the restricted-key design. A FunctionCall allowance pays gas; it cannot fund storage deposit, which is why the contract change is required.

## Existing-state compatibility

The proposed change does not add or reorder fields in `Escrow`, `Project`, `Milestone`, or receipt state. It preserves the existing Borsh layout. Existing projects, milestones, receipts, used receipt IDs, balances, and payment evidence remain readable. The upgrade still requires an operator with administrator/deployment authority and an explicit state-preservation review; no upgrade is authorized by this report.

The already completed project 0/milestone 0 is not a suitable zero-deposit verification test target because it is terminal and historically paid. A future test must use a legitimately InProgress milestone and a fresh passing receipt. Historical evidence must remain untouched.

## Next.js production build investigation

The previous apparent timeout was not an application compilation error. The Next process produced no early output while compiling, and the prior build wrapper returned without a usable completion record. The project already isolates production output in `apps/web/.next-production`, separate from the development `.next` cache, and the generated output contained the workspace bundle.

The build was rerun with telemetry disabled and observed to completion:

- Next.js 15.5.29 compiled successfully in approximately 60 seconds.
- Type validation and linting completed.
- Static generation completed for all 5 pages.
- Production build exit code: 0.
- `/workspace` is present in the production server output.

Routes generated:

```text
/          512 B / 106 kB first load
/workspace 15.6 kB / 121 kB first load
```

The likely cause of the earlier report was slow resource-constrained compilation combined with an external command timeout, not a reproducible Next application failure. The isolated dist directory and development lock remain important safeguards.

## Deployment checklist

Before any live upgrade or deployment:

1. Obtain explicit administrator/operator authorization for the contract upgrade; do not use the paid project as a test fixture.
2. Review the generated WASM and confirm the unchanged serialized state layout.
3. Add backend finalized access-key permission validation and tests.
4. Provision a dedicated FunctionCall key only after the upgraded method is live; do not create or rotate one in this task.
5. Configure the backend with the restricted key through a secret manager, durable storage volume, exact HTTPS frontend origin, Gemini credentials, and Testnet contract settings.
6. Run one fresh-wallet end-to-end test on a new test project/milestone, including verification, owner approval, and settlement.
7. Confirm restart recovery, transaction reconciliation, CORS, Secure HttpOnly cookie behavior, and no secret leakage.
8. Deploy the frontend to Vercel and the single persistent backend to Render (or equivalent persistent host) only after the smoke test passes.

## Remaining blockers

1. **Critical:** the live contract has not been upgraded; restricted-key verification is unavailable against the current deployed positive-deposit method.
2. **Critical:** backend on-chain FunctionCall permission validation for the restricted key must be implemented and tested.
3. **Important:** an administrator-controlled upgrade and a dedicated restricted verifier key are still required.
4. **Important:** public hosting, durable storage, Gemini secrets, and production origins remain unconfigured.

## Recommendation

Do not proceed to public deployment yet. The safest viable path is to review and explicitly authorize the minimal contract upgrade, then use a dedicated FunctionCall key limited to `escrow.attestra-owner.testnet` / `submit_verification` with zero attached deposit. If administrator access or upgrade authorization is unavailable, retain the current contract and use a tightly isolated operator-controlled submission workflow; do not put a FullAccess verifier credential on a general public server.
