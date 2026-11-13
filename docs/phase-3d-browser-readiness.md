# Phase 3D browser readiness

Date: 2026-11-12

## Result

The payment workflow is browser-ready after a small, confirmed integration fix. No wallet was connected, no message or transaction was signed, and no blockchain transaction was submitted during this audit.

The existing Testnet milestone remains the target:

- Contract: `escrow.attestra-owner.testnet`
- Network: `testnet`
- Project: `0`
- Milestone: `0`
- Owner/recipient: `lateram9099.testnet`
- Budget: `0.01 NEAR`
- Current status: `InProgress`

## Confirmed blocker and fix

The frontend could create a payment-eligible execution, but chain setup only supported attaching finalized project and milestone transaction hashes produced by that execution. Project 0 and milestone 0 are historical on-chain resources, and their transaction hashes are already linked to historical records. Reusing those hashes for a new execution would correctly be rejected as duplicate evidence.

The smallest safe correction was added:

1. `POST /api/v1/executions/:executionId/chain/attach` accepts explicit on-chain project and milestone IDs.
2. The API requires an authenticated wallet and a payment-eligible execution.
3. It reads `get_project` and `get_milestone` through the read-only Testnet adapter.
4. It requires the authenticated wallet to be the project owner and the milestone to be `InProgress`.
5. It binds Testnet, the configured escrow contract, project ID, milestone ID, owner, recipient, and budget.
6. It records no historical transaction hashes and cannot overwrite an existing linkage.
7. The Chain Setup panel exposes this as “Attach finalized chain state”, defaulting to project `0` and milestone `0`.
8. Payment-backed verification is disabled in the UI until this linkage is confirmed.

Files changed for this fix:

- `apps/api/src/app.ts`
- `apps/api/src/store.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/chain-setup-panel.tsx`
- `apps/web/src/components/verification-panel.tsx`

Historical executions, artifacts, receipts, and transaction evidence were not edited.

## Workflow readiness

The existing frontend supports wallet connection through NEAR Connect on Testnet and authenticates the selected account with a signed challenge. The API session is account-bound; switching wallets requires disconnecting the current wallet and reconnecting the intended account.

The normal payment-backed flow is now:

1. Connect the owner wallet `lateram9099.testnet`.
2. Start a new execution from the project form. It is marked `paymentEligible: true`.
3. Wait for Research, Builder, and QA to complete. Inspect the final artifact, QA evidence, and digest.
4. In On-chain lifecycle, enter on-chain project `0` and milestone `0`, then click **Attach finalized chain state**. This is a read-only view lookup and does not create or fund anything.
5. Confirm the panel shows project `0`, milestone `0`, owner `lateram9099.testnet`, recipient `lateram9099.testnet`, budget `0.01 NEAR`, and `InProgress`.
6. Open Verification. The request button remains disabled until the confirmed linkage is visible. Request independent verification and inspect every mandatory check and the exact artifact digest.
7. Disconnect the owner wallet and connect `verifier.attestra-owner.testnet`. Re-authenticate the browser session when prompted.
8. In Payment Lifecycle, confirm the receipt is `Passed`, its project/milestone are `0/0`, its digest matches the artifact, and the verifier is the authorized verifier. Request the server-issued `submit_verification` intent and approve it in the verifier wallet.
9. Wait for finalized reconciliation. The milestone should become `VerificationPassed` and the finalized verification transaction should be displayed.
10. Disconnect the verifier and reconnect `lateram9099.testnet`.
11. Request the owner approval intent. Confirm the intent references the exact new receipt ID, then approve in the owner wallet and wait for finality. The milestone should become `OwnerApproved`.
12. Request settlement. Confirm the intent targets project `0`, milestone `0`, and the registered recipient/budget. Approve in the owner wallet.
13. Wait for the asynchronous settlement callback. The UI should show `PaymentPending` while waiting, then finalized `Paid`, the settlement transaction evidence, and updated paid/reserved balances.

Do not use the historical rejected receipt or the previously passing but incorrectly linked receipt. Do not create or fund another project or milestone.

## Security gates reviewed

- Payment-eligible verification fails closed without confirmed chain linkage.
- Linkage is validated against live read-only project and milestone state.
- Network and contract account are checked before attachment and lifecycle intents.
- Project owner, recipient, and exact budget are persisted in the linkage and rechecked before payment intents.
- Verification submission requires the configured authorized verifier account.
- Owner approval requires finalized on-chain verification matching the exact receipt ID, digest, and authorized verifier.
- Settlement requires `OwnerApproved`, matching approval receipt, and no pending payment.
- Final artifact digest is recomputed before verification and before payment authorization.
- Historical transaction hashes cannot be copied into the new attachment path.
- Existing linkage is immutable after confirmation.
- The contract tests cover unauthorized verifier/owner operations, failed verification, receipt reuse, incorrect approval receipt, settlement ordering, callback replay, and duplicate settlement.

The browser wallet must not be treated as proof of authorization by itself; the API session and the contract both enforce account identity. The owner and verifier must be separate wallet sessions for the demonstration, even though the current milestone recipient is the owner.

## Automated validation

All requested validation completed successfully, run sequentially:

- `pnpm typecheck` — passed.
- `pnpm lint` — passed with no warnings or errors after the hook dependency correction.
- `pnpm --filter @attestra/api test` — 28/28 passed.
- `pnpm --filter @attestra/web test` — 21/21 passed.
- `pnpm build` — passed, including Next production build and package/API builds.
- `cargo test --manifest-path contracts/escrow/Cargo.toml` — 46/46 Rust tests passed; doc tests 0/0.

## Remaining blockers and operating limits

1. This report does not claim a payment occurred. The human operator must perform the wallet-controlled verification, approval, and settlement steps.
2. The local UI intentionally disables verification writes when built with `NODE_ENV=production`. For a judge demonstration, run the supported local development configuration or provide the server-side verification-write configuration; never expose a privileged verification token in browser code.
3. The deployed `get_project_ids` indexing defect remains. The browser path uses direct project/milestone IDs and direct finalized views, so it does not depend on that defective discovery method.
4. The existing execution created before the binding fix is not automatically eligible. Start a fresh execution so its payment eligibility and authoritative linkage are explicit from creation.
5. The new attachment endpoint is covered by type/build and surrounding linkage security coverage, but does not yet have a dedicated API integration test with a mocked finalized project/milestone view. Add that focused test before treating the attachment route as long-term regression-locked.

No contract, wallet, or historical-record change is required for the attachment fix.
