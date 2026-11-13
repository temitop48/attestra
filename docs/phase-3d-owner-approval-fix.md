# Phase 3D Owner Approval Fix

Date: 2026-11-13
Network: NEAR Testnet
Contract: `escrow.attestra-owner.testnet`

## Result

The browser error was an off-chain configuration failure. The API had no positive value for `NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO`, so it correctly failed closed before issuing an approval intent. The contract and milestone were not changed.

The local development configuration now contains the contract-measured values:

```text
NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO=330000000000000000000
NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=510000000000000000000
```

No wallet approval or settlement transaction was signed or broadcast during this investigation.

## Contract and deposit analysis

The deployed `approve_milestone` implementation:

1. Requires the predecessor to be the project owner.
2. Requires milestone status `VerificationPassed`.
3. Requires the supplied receipt ID to equal the recorded passing receipt.
4. Stores the owner approval receipt and changes the status to `OwnerApproved`.
5. Measures the storage delta and requires an attached deposit of at least that amount.
6. Adds the entire attached deposit to the project's storage accounting.

It does not require exactly 1 yoctoNEAR. It uses dynamic storage accounting. There is no refund branch for excess storage deposit; excess remains recorded as project storage credit. The configured values therefore use the measured minimum for this exact receipt and milestone shape rather than an arbitrary cushion.

The local contract VM probe used the exact receipt ID and the same verification-to-approval-to-settlement lifecycle:

- Approval growth: 33 bytes
- Settlement growth: 51 bytes
- NEAR storage byte cost: `10000000000000000000` yoctoNEAR
- Approval minimum: `33 × 10000000000000000000 = 330000000000000000000` yoctoNEAR (`0.00033 NEAR`)
- Settlement minimum: `51 × 10000000000000000000 = 510000000000000000000` yoctoNEAR (`0.00051 NEAR`)

The deployed contract WASM and the reviewed local release WASM both measured 412,624 bytes and had SHA-256:

`4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`

## Finalized chain state check

Read-only finalized RPC state confirms:

- Project: `0`
- Project owner: `lateram9099.testnet`
- Total funded: `20000000000000000000000` yoctoNEAR (`0.02 NEAR`)
- Available: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Reserved: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Paid: `0`
- Milestone: `0`
- Recipient: `lateram9099.testnet`
- Budget: `10000000000000000000000` yoctoNEAR (`0.01 NEAR`)
- Status: `VerificationPassed`
- Receipt: `attest-1794510501481-h8yi6rpx`
- Verification digest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`

The approval configuration and settlement configuration are now positive yoctoNEAR values. The backend's `chainConfig`, intent construction, and reconciliation paths already convert and validate these strings as yoctoNEAR values. The frontend sends the server-issued deposit unchanged through the connected wallet.

## Workflow/security review

The approval intent is server-generated with:

- receiver `escrow.attestra-owner.testnet`
- method `approve_milestone`
- project `0`
- milestone `0`
- exact receipt `attest-1794510501481-h8yi6rpx`
- approval deposit `330000000000000000000` yoctoNEAR

The frontend requires the connected account to equal the authoritative project owner and requires the finalized milestone state to be `VerificationPassed`. The user must explicitly confirm the wallet transaction. A busy-state guard prevents overlapping submissions; if a hash exists without confirmed final state, the UI requires reconciliation rather than signing again.

Settlement remains owner-only and is enabled only after authoritative `OwnerApproved` state. It uses `settle_milestone` with project `0` and milestone `0`, the configured settlement storage deposit, and the owner wallet. The UI polls `PaymentPending` until the callback produces finalized `Paid` state. A transaction hash alone is not treated as payment success.

## Changes made

- Added the measured approval deposit to the local ignored runtime environment.
- Added the measured settlement deposit to the local ignored runtime environment so the next owner-approved step does not fail for the same reason.
- No contract source, artifact, receipt, execution, or historical record was modified.
- No blockchain transaction was executed.

## Validation

- `pnpm typecheck` — passed
- `pnpm lint` — passed
- API tests — 53 passed
- Frontend tests — 25 passed
- Rust contract tests — 46 passed
- `pnpm build` — passed
- Deployed/local WASM hash comparison — passed
- Finalized NEAR project/milestone/config read — passed

## Exact browser steps

1. Restart the local API so it loads the updated ignored environment file, then restart/reload the Next.js frontend.
2. Open the workspace and select the execution linked to project `0`, milestone `0`.
3. Connect `lateram9099.testnet` and confirm the page shows `VerificationPassed`, receipt `attest-1794510501481-h8yi6rpx`, recipient `lateram9099.testnet`, and budget `0.01 NEAR`.
4. Click **Approve milestone**.
5. In the wallet confirmation, verify receiver `escrow.attestra-owner.testnet`, method `approve_milestone`, project `0`, milestone `0`, the exact receipt ID, and attached deposit `0.00033 NEAR`.
6. Confirm the transaction explicitly in the owner wallet. Wait for the UI to show finalized evidence and `OwnerApproved`.
7. Confirm the approval transaction hash is displayed and the settlement action becomes enabled.
8. Click **Settle milestone** only after `OwnerApproved` is visible.
9. In the wallet confirmation, verify method `settle_milestone`, project `0`, milestone `0`, and attached deposit `0.00051 NEAR`.
10. Confirm the transaction explicitly. Wait through `PaymentPending` until the callback is finalized.
11. Confirm the UI and direct chain state show `Paid`, paid balance `0.01 NEAR`, reserved balance `0`, and recipient `lateram9099.testnet`.

If any wallet prompt shows a different receiver, method, IDs, receipt, or deposit, reject it and stop.
