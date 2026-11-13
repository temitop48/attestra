# ATTESTRA escrow contract design

Status: implemented baseline — Phase 1C.2C predeployment review

This document specifies the smallest NEAR Testnet escrow contract that can support the ATTESTRA MVP. Phase 1C.2B implements the verification, approval, lifecycle, settlement, callback, cancellation, and refund methods described below. It does not add a token, deploy a contract, or claim that off-chain verification is cryptographic proof of correctness.

## Architectural boundary

The browser, API, orchestrator, agents, and verifier are outside the contract trust boundary. Agents never hold user keys. The API may coordinate transactions and evidence, but it cannot change balances or bypass a contract precondition. The contract is the final authority for:

- project ownership and milestone configuration;
- native NEAR deposits and internal accounting;
- verifier authorization;
- dependency and approval checks;
- one-time settlement;
- asynchronous transfer completion and recovery.

The contract stores identifiers and digests, not deliverable files. Evidence and verification details remain off-chain and are addressed by a digest and receipt identifier.

## SDK and toolchain decision

The repository currently has a Rust 2021 placeholder crate with no `near-sdk` dependency. The repository README records Rust 1.99. The official `near/near-sdk-rs` repository currently reports an MSRV of Rust 1.95, and its official release page lists `near-sdk` 5.30.1 as the latest stable release at the time of this design. Rust 1.99 therefore satisfies the published minimum for that release.

The implementation should pin the exact reviewed version:

```toml
near-sdk = "=5.30.1"
```

This is a recommendation for the implementation phase, not a dependency change in Phase 1C.1. Before coding, run a clean WASM build and unit/integration tests against the pinned version. A later patch release must not be substituted after review without rerunning the security and serialization checks. The SDK release and MSRV references are recorded in the sources section below.

## State model

### Contract state

```text
administrator: AccountId
authorized_verifier: AccountId
storage_deposit: Balance              // contract-level storage accounting
next_project_id: u64
projects: Map<u64, Project>
used_receipt_ids: Set<ReceiptId>
```

`administrator` is the initialized contract account or explicitly supplied admin. It can rotate the verifier and, after review, may be given a narrow emergency pause capability. It cannot withdraw project funds or approve a milestone for an owner.

There is exactly one authorized verifier in the MVP. This keeps the authorization rule auditable. A future version may use a set or threshold policy, but that is not needed for the hackathon.

### Project

```text
Project {
  project_id: u64                    // generated sequentially by contract
  owner: AccountId
  total_funded: Balance              // cumulative accepted project funding
  available_balance: Balance         // unreserved funds available for refund
  reserved_balance: Balance          // budgets reserved by active milestones
  paid_balance: Balance              // successfully completed payouts
  refunded_balance: Balance          // completed refunds
  pending_refund_balance: Balance    // refund transfer currently pending
  next_milestone_id: u64
  milestones: Map<MilestoneId, Milestone>
  pending_payment: Option<PendingTransfer>
  pending_refund: Option<PendingTransfer>
  storage_deposit: Balance           // storage accounting only
}
```

The contract generates `project_id` from `next_project_id` and increments it with checked arithmetic. Milestone IDs are likewise generated sequentially within each project. Callers never select either identifier, eliminating collision and cross-project ambiguity.

The funding fields are deliberately separate. The contract must never treat `env::account_balance()` as spendable project money: it includes storage stake, protocol balances, and funds belonging to other projects. The accounting invariant is:

```text
total_funded = available_balance
              + reserved_balance
              + paid_balance
              + refunded_balance
              + pending_refund_balance
```

`storage_deposit` is excluded from this identity and is never available for milestone funding or refunds. Contract-level storage deposits are tracked separately from project storage deposits.

### Milestone

```text
Milestone {
  milestone_id: u64
  recipient: AccountId
  budget: Balance
  dependencies: Vec<u64>             // existing milestone IDs in this project
  status: MilestoneStatus
  verification: Option<VerificationAttestation>
  owner_approval: OwnerApproval
}
```

`budget` is fixed at registration and cannot be edited after activation. A recipient is fixed before funding and is copied into the pending payment record so callback handling can verify the intended destination. There is no agent wallet field and no recipient-controlled payment routing.

### Verification attestation

```text
VerificationAttestation {
  project_id: String
  milestone_id: u64
  deliverable_digest: String
  receipt_id: String
  result: VerificationResult       // Passed or Failed
  verifier: AccountId
}
```

The contract checks that the caller is the current authorized verifier, that the project and milestone IDs match the call, that the receipt has not been used, and that the milestone is in a verifiable state. The receipt is an authorized off-chain attestation. It is not a zero-knowledge proof, a consensus proof, or an on-chain determination that the deliverable is correct.

### Stored versus derived state

Store milestone status, the latest verification attestation, owner approval, pending transfer metadata, and accounting totals. Derive these values rather than storing them independently:

- `is_payment_pending` from the project-level `pending_payment.is_some()`;
- `is_reserved` from a milestone status that owns a budget reservation or from its pending payment;
- project solvency from `available_balance + reserved_balance + paid_balance` and the project’s accepted funding/refund ledger;
- dependency readiness by querying each dependency’s status.

Do not store independent booleans such as `paid` and `cancelled`; they invite contradictory combinations.

## Milestone lifecycle

The lifecycle uses a single status enum. `owner_approval` is separate because approval is an authorization fact attached to a passed verification, not an alternative payment state.

```text
Created
  -> Funded
  -> Cancelled

Funded
  -> InProgress
  -> Cancelled

InProgress
  -> VerificationPassed
  -> VerificationFailed
  -> Cancelled                     (only before owner approval)

VerificationFailed
  -> InProgress                     (rework and a new receipt)
  -> Cancelled

VerificationPassed + owner approval
  -> OwnerApproved

OwnerApproved
  -> PaymentPending

PaymentPending
  -> Paid                           (successful callback)
  -> OwnerApproved                  (failed callback; budget remains reserved)

Cancelled
  -> Refunded                       (only after its released budget is included in a successful refund)

Paid, Refunded
  -> terminal
```

`Funded` means the milestone budget has been reserved, not that payment has occurred. Activation is allowed only after reservation. Dependencies may still be in progress while work is performed, but every dependency must be `Paid` before this milestone can enter `PaymentPending`.

Verification failure clears any owner approval and does not release the reservation automatically. The owner must explicitly start rework to return the milestone to `InProgress`, or cancel it before owner approval. Once `OwnerApproved` is reached, cancellation is forbidden.

Cancellation is disallowed when a nonterminal milestone depends on the target. This prevents a dependency graph that can never settle. Cancellation releases a reservation into `available_balance`; it does not itself send money. A later refund transfers only available balance.

## Accounting and funding

### Funding

`fund_project(project_id)` is payable and accepts only native NEAR. `env::predecessor_account_id()` must equal the project owner, the amount must be positive, and the project must not be closed. The attached deposit is added to `total_funded` and `available_balance`.

Milestone registration records a budget but does not reserve it. `activate_milestone` checks:

```text
available_balance >= milestone.budget
```

It then atomically decreases `available_balance`, increases `reserved_balance`, and moves the milestone to `Funded`. This prevents underfunded milestones and ensures that later deposits cannot accidentally change an already-defined budget.

An excess deposit remains `available_balance`. It is not automatically assigned to a milestone and is eligible for owner refund. The contract never uses the complete account balance as a project balance.

### Settlement accounting

When settlement begins, the milestone budget remains in `reserved_balance` and the milestone enters `PaymentPending`. No second settlement can begin. On a successful callback, the contract decreases `reserved_balance`, increases `paid_balance`, clears the pending payment, and marks the milestone `Paid`.

On a failed callback, the contract clears the pending payment and returns the milestone to `OwnerApproved`; the reservation remains intact. The owner can retry only after the failure callback is confirmed. A pending payment or pending refund serializes all future payment/refund operations for that project.

### Refunds

The MVP has one refund target: the project owner. `cancel_milestone` releases a milestone budget to `available_balance`; `refund_project` transfers available balance to the owner. A refund cannot consume `reserved_balance`, `paid_balance`, or any amount represented by a pending settlement.

For a simple and safe MVP, `refund_project` rejects while any milestone has a pending payment. It also rejects while another project refund is pending. This is stricter than necessary but prevents overlapping accounting paths and is practical before November 10.

The refund call decreases `available_balance` before creating the transfer and records a `PendingTransfer` with the exact amount and owner recipient. Success completes the refund. Failure restores the exact amount to `available_balance`. A repeated or unauthorized refund callback is rejected and cannot restore or spend funds a second time.

### Storage

Storage stake is not project funding. Every storage-growing method measures the storage delta, requires enough attached deposit at `env::storage_byte_cost()`, and records the attached amount in contract-level or project-level `storage_deposit`. This includes initialization, verifier rotation, verification submission, approval, and pending transfer creation, in addition to project and milestone creation. Automatic storage-credit withdrawals are out of scope; therefore no storage deposit is included in the funding invariant or made available to project operations. Receipt IDs, digests, dependency lists, and milestone counts are bounded.

## Contract API

The following is the proposed MVP surface. View methods are read-only and never accept deposits.

| Method | Caller and deposit | Preconditions and state changes | Events/errors |
| --- | --- | --- | --- |
| `new(admin, verifier)` | One-time initialization; no project funds; storage deposit as measured | Contract uninitialized; sets admin and authorized verifier | `contract_initialized`; `AlreadyInitialized` |
| `set_authorized_verifier(verifier)` | Admin; measured storage deposit (at least one yoctoNEAR) | Valid account; replaces verifier for future receipts only | `verifier_changed`; `Unauthorized` |
| `create_project()` | `env::predecessor_account_id()` becomes owner; storage deposit required; no implicit funding | Allocates the next checked sequential ID and creates a zero-balance project | `project_created`; `StorageDepositInsufficient`, `ProjectIdExhausted` |
| `fund_project(project_id)` | Project owner; attached deposit > 0 | Project active; adds deposit to funding and available totals | `project_funded`; `NotOwner`, `ZeroDeposit` |
| `register_milestone(project_id, recipient, budget, dependencies)` | Project owner; storage deposit required; no payment deposit | Budget > 0, recipient valid, IDs exist, no self/cyclic dependency, bounded graph; allocates next sequential milestone ID and creates `Created` milestone | `milestone_registered`; `InvalidDependency`, `MilestoneIdExhausted` |
| `activate_milestone(project_id, milestone_id)` | Project owner; storage deposit only if needed | `Created`, budget available; reserves budget and moves to `Funded` | `milestone_funded`; `InsufficientAvailableFunds`, `InvalidMilestone` |
| `start_milestone(project_id, milestone_id)` | Project owner; 1 yoctoNEAR | `Funded` or reworkable `VerificationFailed`; moves to `InProgress`, clears prior approval | `milestone_started`; `InvalidTransition` |
| `submit_verification(project_id, milestone_id, deliverable_digest, receipt_id, result)` | Authorized verifier; measured project storage deposit | `InProgress`; IDs/digest/receipt bounded; receipt unused; stores attestation and result | `verification_submitted`; `UnauthorizedVerifier`, `ReceiptReused` |
| `approve_milestone(project_id, milestone_id, receipt_id)` | Project owner; measured project storage deposit | Status `VerificationPassed`, receipt matches latest attestation; sets owner approval and `OwnerApproved` | `milestone_approved`; `NotOwner`, `ApprovalMismatch` |
| `settle_milestone(project_id, milestone_id)` | Project owner; measured project storage deposit plus gas attached | `OwnerApproved`, all dependencies `Paid`, no pending transfer; records pending payment and creates native NEAR transfer | `payment_pending`; `DependenciesUnmet`, `PaymentAlreadyPending` |
| `cancel_milestone(project_id, milestone_id)` | Project owner; 1 yoctoNEAR | No payment pending/paid; no nonterminal dependent milestone; releases reservation and marks `Cancelled` | `milestone_cancelled`; `DependentMilestoneExists`, `InvalidTransition` |
| `refund_project(project_id)` | Project owner; measured project storage deposit plus gas | No pending project refund or milestone payment; available balance > 0; moves amount to `pending_refund_balance` and records refund transfer | `refund_pending`; `RefundUnavailable`, `TransferAlreadyPending` |
| `on_payment_complete(project_id, milestone_id, transfer_id)` | Private callback only | Caller must be contract account; pending transfer ID/amount/recipient must match; success marks `Paid`, failure returns to `OwnerApproved` | `payment_succeeded` or `payment_failed`; `InvalidCallback` |
| `on_refund_complete(project_id, transfer_id)` | Private callback only | Caller and transfer ID must match; success finalizes refund, failure restores amount | `refund_succeeded` or `refund_failed`; `InvalidCallback` |
| `get_project(project_id)` | Anyone; no deposit | Returns project accounting and owner metadata | None |
| `get_milestone(project_id, milestone_id)` | Anyone; no deposit | Returns status, budget, recipient, dependencies, attestation metadata, and pending flag | None |
| `get_project_ids(owner, from_index, limit)` | Anyone; no deposit | Bounded pagination | None |

The callback methods are not user-callable despite being exposed as public ABI methods. They must use the SDK’s private-caller guard and validate stored transfer metadata. The implementation may make callbacks private Rust methods whose names are not intended for clients.

Every mutating method should emit a versioned event with project ID, milestone ID where applicable, actor, and a monotonic operation/transfer ID. Events are an audit trail, not a substitute for state checks.

## Authorization matrix

| Action | Admin | Owner | Authorized verifier | Anyone |
| --- | --- | --- | --- | --- |
| Initialize | Initial caller only | — | — | — |
| Rotate verifier | Yes | No | No | No |
| Create/fund/configure project | No | Yes | No | No |
| Start, cancel, approve, settle | No | Yes | No | No |
| Submit verification | No | No, unless also configured verifier | Yes | No |
| Execute callback | Contract predecessor only | No | No | No |
| Query state | Yes | Yes | Yes | Yes |

## Verification semantics

The verifier submits a receipt that binds exactly `(project_id, milestone_id, deliverable_digest, receipt_id, result, verifier)`. The contract accepts only the configured verifier’s signer account. Receipt IDs are globally single-use, including failed results, so an old receipt cannot be replayed after rework or against another milestone. A new verification after rework must use a new receipt ID and digest.

The contract does not authenticate the off-chain evidence itself. A compromised verifier can attest to bad work, and an honest verifier can make a mistake. The trust decision, verifier key custody, evidence retention, and dispute process remain product-level limitations and are called out for review.

## Dependencies

Dependencies are milestone IDs within one project. Registration accepts only existing IDs and must reject self-dependencies and cycles. The implementation can perform cycle detection on the bounded graph or require dependencies to be registered in an order that makes a cycle impossible; explicit cycle detection is preferred.

Settlement, not activation, enforces completion: every dependency must be `Paid`. A dependency in `Cancelled`, `Refunded`, `VerificationFailed`, or `PaymentPending` blocks settlement. Cancellation of a dependency is rejected while a nonterminal dependent exists.

## Sources and implementation references

- [near-sdk-rs official repository](https://github.com/near/near-sdk-rs) — Rust SDK purpose, `#[near]` contract shape, build guidance, and MSRV.
- [near-sdk-rs official releases](https://github.com/near/near-sdk-rs/releases) — `near-sdk` 5.30.1 release and associated 5.30.1 contract standards release.
- [near-sdk API reference](https://docs.rs/near-sdk/latest/near_sdk/) — authoritative generated API reference for the exact pinned crate.

## Decisions requiring review

1. Confirm whether project IDs are globally unique or scoped by owner. This design recommends global uniqueness.
2. Confirm the single verifier account and its key-rotation operational process.
3. Confirm whether failed verification may be retried indefinitely or needs a retry limit/deadline.
4. Confirm the product policy for cancellation after work has started.
5. Confirm storage deposit sizing and whether dynamic excess refunds are included in the first implementation.
6. Confirm whether the admin may pause new operations during an incident. No admin withdrawal power is proposed.
