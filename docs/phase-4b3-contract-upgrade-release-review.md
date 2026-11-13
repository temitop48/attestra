# Phase 4B.3 contract upgrade release review

Date: 2026-11-13

## Release verdict

**BLOCKED — NOT SAFE TO PROCEED.**

The proposed WASM is locally tested and state-layout compatible, but this review could not complete a fresh finalized Testnet RPC read because `rpc.testnet.near.org` was not DNS-resolvable from the current environment. The completed `Paid` state supplied in the release context is not independently re-verified here. In addition, the backend restricted-key permission check is still required before public deployment, and the original deployed WASM artifact has not been archived locally for rollback.

No blockchain transaction, upgrade, key operation, or live-state modification was performed.

## Reviewed artifact

```text
Path: `<repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm`
SHA-256: 355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83
Size: 412,829 bytes
```

The last recorded deployed-code comparison in `docs/phase-3d-verification-storage-deposit.md` identified the deployed predecessor as 412,624 bytes with SHA-256 `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`. Therefore the proposed artifact is intentionally different; it is not currently deployed.

## Exact behavior change

The only production method behavior changed is `submit_verification` storage charging:

- Positive attached deposits retain the old behavior: the measured storage delta must be covered and the attached amount is credited to `project.storage_deposit`.
- An exact zero attached deposit is now allowed only when the project’s existing `storage_deposit` covers the measured delta.
- The required delta is subtracted from that project storage credit.
- Insufficient credit causes a panic before successful completion: `Insufficient project storage credit`.

The helper is `charge_verification_storage`; no public method signature changed. Existing verifier authorization, `InProgress` requirement, receipt uniqueness, digest/receipt bounds, project/milestone IDs, and verification status transitions remain unchanged.

## Serialized state compatibility

The proposed source does not add, remove, reorder, or rename fields in the serialized types:

- `Escrow`: administrator, authorized verifier, storage deposit, counters, project map, receipt set.
- `Project`: owner, funding/accounting balances, milestone map, pending transfers, storage deposit.
- `Milestone`: recipient, budget, dependencies, status, verification, approval receipt.
- `VerificationAttestation` and `PendingTransfer` remain unchanged.

The change is a method/helper change only. Existing Borsh state should therefore remain readable without `new` or migration. Reinitialization would be incorrect: `new` rejects existing state and must not be called during an upgrade.

## Existing project and milestone

The release context says project `0` / milestone `0` is completed and `Paid`. Local durable evidence contains the associated verification, approval, and settlement transaction hashes for execution `exec-88740fc1-d85a-4be4-a42f-22fd0dfb43ac`.

However, the current environment could not perform the required direct finalized RPC reads. The latest historical direct-chain documents in the repository predate the later payment and report `InProgress`; they are not sufficient to independently certify today’s `Paid` state. Before release, read `get_project(0)` and `get_milestone(0, 0)` at finalized state and require:

```text
milestone.status = Paid
project.pending_payment = null
project.reserved_balance = 0.01 NEAR less than its pre-payment value
project.paid_balance = 0.01 NEAR greater than its pre-payment value
recipient = lateram9099.testnet
```

Do not use project 0/milestone 0 for a zero-deposit verification test; a `Paid` milestone is terminal.

## Security regression review

The 48 Rust tests pass, including coverage for:

- unauthorized verifier rejection;
- receipt replay rejection and cross-project receipt reuse;
- zero-deposit verification with sufficient storage credit;
- zero-deposit verification with insufficient storage credit;
- positive-deposit verification accounting;
- funding/reservation/payment/refund accounting invariants;
- callback and duplicate-payment protections.

The zero-deposit path cannot bypass authorization or replay checks because those checks execute before storage charging. A failed storage-credit assertion reverts the transaction, so it must not persist the receipt ID or milestone transition.

## Deployment authorization

Code deployment authorization belongs to the contract account’s deployment signer/access key:

```text
escrow.attestra-owner.testnet
```

The contract administrator `attestra-owner.testnet` is required for administrator-only contract methods, but is not automatically the code deployment signer. The operator must prove access to the contract account’s deployment authority. No new administrator is introduced. The authorized verifier remains `verifier.attestra-owner.testnet`.

## Exact deployment command

After the RPC preflight, artifact review, archived rollback artifact, and explicit operator authorization, the classic NEAR CLI command documented by this repository is:

```bash
near deploy \
  escrow.attestra-owner.testnet \
  <repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm \
  --networkId testnet
```

This command is intentionally not being run. It must be signed by the contract-account deployment authority and must not be followed by `new`; an upgrade preserves existing state and must not reinitialize the contract.

## Rollback and recovery

Before upgrading:

1. Read and archive the current deployed code bytes from finalized Testnet RPC and verify the recorded predecessor hash `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`.
2. Capture finalized views of the administrator/verifier configuration, project 0, milestone 0, balances, storage credit, and relevant transaction hashes.
3. Stop all writes and ensure no pending transfer exists.
4. Deploy the reviewed artifact once.
5. Re-read the same views and verify project/milestone/payment evidence before allowing any new verification.

If the upgraded code is defective, redeploy the archived predecessor WASM to the same contract account using the same deployment authority. Do not call `new`, reset state, create a replacement project, or alter historical receipts. The predecessor WASM is not currently present in the repository; only its hash and prior comparison are recorded, so an upgrade without first archiving it would have an incomplete rollback plan.

## Backend work still required

Before production deployment, the signer bootstrap must query finalized access-key state and fail closed unless all of the following hold:

```text
signer account: verifier.attestra-owner.testnet
permission: FunctionCall (not FullAccess)
receiver_id: escrow.attestra-owner.testnet
method_names: exactly submit_verification
transaction deposit: exactly 0 yoctoNEAR
```

The backend must also reject client-supplied receiver, method, arguments, deposit, and signer identity, while retaining receipt/artifact/linkage validation, idempotency, and finalized reconciliation. No restricted key has been created or rotated in this review.

## Required order of operations

1. Restore DNS/RPC access and capture the final pre-upgrade state.
2. Archive the deployed predecessor WASM and verify its hash.
3. Obtain explicit contract-account deployment authorization.
4. Upgrade the contract with the reviewed WASM; do not initialize it.
5. Verify the upgrade transaction and all preserved state through finalized read-only RPC.
6. Create the dedicated restricted FunctionCall key only with explicit operator authorization.
7. Verify its finalized permission and configure the backend secret reference.
8. Deploy the persistent backend and frontend with production secrets/origins.
9. Run a fresh project/milestone public end-to-end test: execution → independent verification → zero-deposit backend submission → owner approval → settlement → callback-confirmed `Paid`.

## Final checks required before release

- Fresh RPC confirms project 0/milestone 0 is `Paid` and balances are consistent.
- Post-upgrade code hash is recorded and differs from the predecessor as expected.
- All 48 Rust tests and WASM build pass.
- Restricted-key permission validation tests pass.
- Backend and frontend production smoke tests pass.
- Rollback WASM is archived and hash-verified.
- No FullAccess verifier credential is placed on a public host.
