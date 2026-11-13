# ATTESTRA escrow predeployment security repairs

Status: Phase 1C.2C complete; no deployment performed.

## Reviewed implementation

- Crate: `attestra-escrow` 0.1.0
- SDK: `near-sdk = 5.30.1`, pinned exactly
- Rust: 1.99.1
- Contract: `contracts/escrow/src/lib.rs`

The review covered initialization, project creation/funding, milestone registration and activation, verification, approval, settlement, cancellation, refunds, views, collections, accounting, authorization, and asynchronous callbacks.

## Findings confirmed and repaired

### F-01 — HIGH: deferred collection writes undercharged storage

Confirmed in near-sdk 5.30.1. The SDK documentation states that `near_sdk::store` collections cache writes and that `env::storage_usage()` excludes those cached writes until the collection is flushed. Flushing an outer collection does not flush nested collections.

The previous code measured after `insert` but before flushing `IterableMap`, `IterableSet`, and nested project `LookupMap` values. It could therefore accept insufficient storage deposits.

Repair:

- Flush the touched project milestone map.
- Flush top-level projects and receipt collections.
- Persist serialized contract state with `env::state_write` before measuring.
- Check the measured delta against the attached deposit.
- Record storage credit separately from project funding.
- Persist again after adding the storage credit.

This is applied to `new`, `set_authorized_verifier`, `create_project`, `register_milestone`, `submit_verification`, `approve_milestone`, `settle_milestone`, and `refund_project`.

The final state invariant remains:

```text
total_funded = available_balance
             + reserved_balance
             + paid_balance
             + refunded_balance
             + pending_refund_balance
```

Storage deposits are excluded from every term and cannot consume reserved milestone funds.

### F-02 — HIGH: callback failure after an outgoing transfer

The limitation is confirmed, not eliminated. A successful native NEAR transfer is irreversible. If its callback never executes or exhausts gas, the contract cannot safely infer whether the transfer succeeded. The contract therefore leaves the operation pending and does not mark it paid/refunded.

Safety properties retained:

- The pending operation is persisted before the transfer promise.
- Project-level payment and refund slots serialize operations.
- Operation IDs are unique and stored with project, milestone, amount, and recipient.
- Private callbacks require the contract predecessor and exactly one promise result.
- Duplicate, stale, mismatched, or unauthorized callbacks fail before accounting changes.
- A pending payment cannot be settled again, and a pending refund cannot be started again.

Operational recovery procedure:

1. Treat the project as frozen for settlement/refund while the pending record exists.
2. Query the originating NEAR transaction and receipt outcome through a trusted RPC/indexer and independently verify the exact receiver and amount.
3. If the transfer failed, use the existing failure callback path when available; do not submit a guessed callback or timeout retry.
4. If the transfer succeeded but the callback did not finalize, stop automated settlement and escalate for a reviewed migration/recovery upgrade. Do not release the reservation or initiate a second transfer based on inference.

No unsafe timeout-based retry or automated reconciliation was added. This is a deployment limitation.

### F-03 — MEDIUM: storage deposit retention

The contract records the full attached deposit for storage-growing operations in contract-level or project-level `storage_deposit`. The measured amount is the storage liability; any excess remains locked in the contract’s storage-credit accounting. There is currently no automatic storage-credit withdrawal or refund method.

This is acceptable for a Testnet-only MVP only if callers are warned to attach a bounded amount based on measured usage. It should be redesigned before production, with explicit credit ownership and withdrawal rules that cannot touch escrow funding.

### F-04 — MEDIUM: callback gas

Callbacks reserve 20 TGas. The callback path is bounded: it loads one project, validates one pending record, reads one milestone, updates bounded state, and emits one event. Unit tests cannot measure live NEAR gas or prove that 20 TGas is sufficient on Testnet. No claim of sufficiency is made here.

Controlled Testnet testing must record actual callback gas consumption and failure behavior for both payment and refund callbacks. If 20 TGas is insufficient, increase it only after measuring the live receipt and re-running the review.

## Additional security review

No new issue was found in:

- predecessor-based administrator, owner, verifier, and callback authorization;
- global verification receipt replay protection;
- owner approval binding to the latest passed receipt;
- dependency existence, bounded dependency count, and paid-dependency settlement checks;
- exact reservation, payment, refund, and pending-refund accounting;
- unique operation IDs and duplicate settlement prevention;
- checked arithmetic and bounded milestone, digest, receipt, and pagination inputs;
- recipient binding in pending transfer records and callbacks.

## Regression tests

The Rust suite now contains 44 passing tests. New or strengthened coverage includes:

- `flushed_storage_growth_cannot_be_underfunded`: a one-yocto registration is rejected after realistic collection/state flushing.
- `verification_storage_deposit_is_not_project_funding`: storage attached to verification does not change funding balances.
- successful and failed payment callbacks;
- successful and failed refund callbacks;
- unauthorized and duplicate callbacks;
- pending-operation serialization and retry only after confirmed failure.

The tests use near-sdk mocked promise results for state-machine behavior. They do not substitute for live Testnet transfer and gas testing.

## Validation results

Executed from `contracts/escrow`:

- `cargo fmt --check`: passed.
- `cargo test`: passed — 44 tests, 0 failures.
- `cargo check --target wasm32-unknown-unknown`: passed.
- `cargo build --target wasm32-unknown-unknown --release`: passed.

Executed from the repository root:

- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm test`: passed.
- `pnpm build`: passed after approved filesystem access; the initial sandbox attempt failed only because existing build outputs were read-only (`EROFS`).

## WASM artifact

The official `cargo-near` workflow was attempted, but installing `cargo-near` failed because its HID dependency requires the unavailable system `libudev` development package. No system packages or global project configuration were changed.

The real release artifact was produced with the compatible Rust WASM workflow:

- Path: `contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm`
- Size: 412,624 bytes
- SHA-256: `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`

The fallback release build is a real WASM artifact; `cargo check` was not treated as an artifact substitute.

## Deployment readiness verdict

Recommended only for controlled Testnet testing with small amounts and an explicit operator freeze/review procedure for stuck callbacks. Not audited, not production-ready, and not suitable for unrestricted deployment until live callback gas and callback-loss recovery procedures are validated.
