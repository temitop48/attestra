# Phase 3D Binding-Recovery Report

Date: 2026-11-12

## Recovery result

The terminal crash did not erase the binding work. The following changes were present in source and were completed before recovery:

- `packages/orchestrator/src/index.ts` defines and validates `paymentEligible` on execution requests and preserves it on execution records.
- `apps/api/src/app.ts` carries the payment-eligibility flag, prefers the confirmed on-chain milestone ID, requires confirmed linkage for payment-eligible verification, and validates project owner, recipient, and budget while reading finalized chain state.
- `apps/api/src/store.ts` adds `ownerAccountId` to linkage and validates it against finalized project state before confirming linkage.
- `apps/web/src/lib/api.ts` carries payment eligibility and owner linkage fields.
- `apps/web/src/components/project-form.tsx` marks normal workspace executions as payment eligible.
- `apps/api/test/executions.test.ts` contains the recovered linkage fixtures and a regression test proving that payment-eligible verification is rejected without confirmed chain linkage.

No historical execution, receipt, artifact, or transaction record was changed.

## Root cause

ATTESTRA had two different milestone namespaces:

1. The API assigned an internal milestone identity by scanning local execution records (`nextMilestoneId`).
2. NEAR assigned the authoritative milestone ID during `register_milestone`.

Execution `exec-b4d37157-8bde-4e87-9188-feefa1927027` was created locally after other project-0 records existed, so its internal milestone became `4`. Its passing receipt therefore referenced project `0` / milestone `4`. The funded contract milestone remained project `0` / milestone `0`.

The prior implementation only preferred the chain milestone when linkage was already confirmed. A fresh execution could therefore be independently verified before its chain linkage existed, producing a receipt that looked valid but could not authorize the live milestone.

## Binding implementation

The current implementation now distinguishes the namespaces explicitly:

- `milestoneIdentity.milestoneId` remains the internal server-assigned identity.
- `onChainLinkage.onChainProjectId` and `onChainLinkage.onChainMilestoneId` are the only IDs used for payment intents after confirmation.
- A confirmed linkage must include testnet network, escrow contract account, chain project ID, chain milestone ID, project owner, recipient, and budget.
- Finalized read-only project and milestone state must match every bound field.
- Payment-eligible verification fails with `CHAIN_LINKAGE_REQUIRED` until the linkage is confirmed.
- Once confirmed, verification receipts use the authoritative on-chain milestone ID.
- Chain intents continue to validate the receipt’s project ID, milestone ID, artifact digest, receipt ID, verifier, recipient, and budget before wallet signing.
- Existing duplicate transaction-hash and duplicate settlement protections remain active.

The project-link reconciliation route now records the finalized project owner. Linkage confirmation rejects owner, recipient, or budget mismatches, as well as adapter network or contract mismatches. The old rejected receipt and the incorrectly linked passing receipt remain payment-ineligible because they are not a confirmed binding for project `0` / milestone `0`.

## Files changed or recovered

- `packages/orchestrator/src/index.ts`
- `apps/api/src/app.ts`
- `apps/api/src/store.ts`
- `apps/api/test/executions.test.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/project-form.tsx`
- Generated package `dist` outputs were rebuilt by the package build commands.

The repository contains many untracked project files, so Git status alone is not a reliable change inventory. The list above was verified from current source contents and the recovered implementation markers.

## Historical records and reuse

The following records remain unchanged and must not be used for payment:

- Historical execution `exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061`.
- Its rejected revision-3 receipt `attest-1794473689115-m0pqv0xw`.
- Passing receipt `attest-1794488495989-0z3nt678` for execution `exec-b4d37157-8bde-4e87-9188-feefa1927027`, because it references internal milestone `4` and has no confirmed chain linkage.

Project `0` and on-chain milestone `0` remain reusable. The existing milestone is still the correct target, but a new payment-backed execution and new receipt are required. Historical transaction hashes cannot be copied into a second execution because the store intentionally rejects duplicate transaction-hash linkage.

## Security coverage

The recovered and existing tests cover:

- Correct project/milestone linkage and finalized-state reconciliation.
- Project and milestone argument matching.
- Owner authentication and signer checks.
- Recipient and budget mismatch rejection.
- Network and escrow-contract adapter mismatch rejection.
- Authorized verifier enforcement.
- Receipt digest, receipt ID, project ID, milestone ID, and verifier matching.
- Historical/incorrect receipt substitution rejection during approval and settlement intent generation.
- Duplicate verification and duplicate settlement/payment-callback rejection.
- Payment-eligible verification rejection before authoritative linkage.

The Rust contract suite independently covers unauthorized verification, failed verification, receipt reuse across projects, incorrect approval receipts, duplicate settlement, callback authorization, and payment state transitions.

## Test results

Commands were run sequentially:

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm --filter @attestra/api test` — passed, 28 tests.
- `pnpm --filter @attestra/web test` — passed, 21 tests.
- `pnpm build` — passed; Next.js production build and API/package builds completed.
- `cargo test --manifest-path contracts/Cargo.toml` — expected path failure because that manifest does not exist.
- `cargo test --manifest-path contracts/escrow/Cargo.toml` — passed, 46 tests; doc tests passed with 0 tests.

No blockchain transaction, wallet signature, deployment, upgrade, or Gemini invocation occurred.

## Remaining issue

The current workspace still creates the local execution before the chain setup panel completes project and milestone reconciliation, because the existing chain routes use the execution ID as their persistence key. The security boundary is now closed at payment-backed verification: the agents may run, but a payment-eligible execution cannot produce an authorizing verification receipt until the chain binding is confirmed.

For a stricter UI sequence in which agent execution itself begins only after chain setup, the next incremental change should be a draft chain-session record or a two-phase workspace flow. That is not required to prevent payment authorization and was not introduced during recovery.

## Next browser demonstration

1. Start a new execution from the workspace; it is marked payment eligible. Do not use either historical receipt.
2. Connect the owner wallet and complete project creation and milestone registration through the existing chain panel.
3. Reconcile both finalized transaction hashes. Confirm the UI shows the authoritative on-chain project and milestone IDs, owner, recipient, budget, testnet network, and contract.
4. Fund, activate, and start the milestone through wallet prompts, reconciling each finalized transaction before continuing.
5. Run the AI workflow and wait for QA approval.
6. Request independent verification only after the chain panel reports confirmed linkage. The resulting receipt must show the actual on-chain milestone ID `0`, not the internal execution milestone number.
7. Connect `verifier.attestra-owner.testnet`; submit the passing verification and reconcile finality.
8. Switch to `lateram9099.testnet`; approve only the new receipt ID and reconcile finality.
9. Settle the milestone; wait for the asynchronous callback and reconcile until the contract reports `Paid`.
10. Confirm the UI displays the same authoritative linkage, receipt digest, finalized transaction hashes, recipient, `0.01 NEAR` budget, and final `Paid` state.

If verification is attempted before linkage, the expected result is a fail-closed `CHAIN_LINKAGE_REQUIRED` response. If the receipt displays milestone `4`, stop; it is not authorized for milestone `0`.
