# ATTESTRA escrow security specification

Status: implemented baseline — Phase 1C.2C predeployment review

This specification turns the escrow design into testable security rules. It assumes native NEAR only, one authorized verifier, a project owner who controls user-facing approval, and asynchronous transfers through NEAR promises. It does not claim that verifier attestations prove deliverable correctness.

## Phase 1C.2B implementation coverage

Implemented in the Rust contract:

- authenticated verifier receipts with global replay protection;
- successful/failed verification states and explicit owner approval;
- funded/rework lifecycle transitions;
- project-serialized pending native-NEAR payments and refunds;
- private callbacks that validate operation, project, milestone, amount, and recipient;
- exact reserved/paid/refunded accounting and cancellation release rules.

The callback tests use near-sdk’s mocked promise results. They prove state-transition and authorization behavior, but they do not prove that a Testnet transfer actually reaches a live account. No deployment or live transfer has been performed.

The Rust suite contains 43 passing tests: the original 15 Phase 1C.2A tests plus the Phase 1C.2B coverage and a Phase 1C.2C regression test for storage deposits attached to verification. The suite covers verification, approvals, rework, dependency checks, pending transfers, callbacks, cancellation, refunds, replay protection, and accounting.

## Security objectives

The contract must:

1. keep project accounting independent from the account’s raw NEAR balance;
2. accept verification only from the configured verifier;
3. bind a receipt to one project, milestone, digest, result, and verifier;
4. require owner approval after a passed verification;
5. require every dependency to be paid before a dependent settlement;
6. make each milestone payout one-time and exact;
7. treat an asynchronous transfer as pending until its callback resolves;
8. recover failed transfers without releasing or spending the same funds twice;
9. make refunds unable to consume reservations or pending payouts;
10. reject malformed IDs and impossible state transitions.

## Canonical invariants

These invariants should become unit and integration assertions before deployment.

### Accounting

- `available_balance`, `reserved_balance`, and `paid_balance` are non-negative.
- `total_funded = available_balance + reserved_balance + paid_balance + refunded_balance + pending_refund_balance`.
- Storage deposits are tracked separately and are excluded from the funding invariant.
- A milestone budget is reserved at most once.
- A milestone budget is never both available and reserved.
- A pending payment remains reserved until a successful callback.
- A failed payment callback restores the milestone to an approval-required state without changing the reservation.
- A refund moves only available balance into `pending_refund_balance` before transfer initiation.
- A successful refund moves the exact amount from `pending_refund_balance` to `refunded_balance`.
- A failed refund callback restores exactly the refund amount from `pending_refund_balance` to `available_balance` once.
- The contract never authorizes a payout from the raw account balance.
- `storage_deposit` is never included in `total_funded` or any payout/refund calculation.
- Storage-growing calls charge measured storage deposits; attached storage deposits are not silently treated as project funding.

### Authorization

- Only the project owner can fund, register, activate, start, cancel, approve, settle, or refund that project.
- Only the administrator can rotate the authorized verifier.
- Only the current authorized verifier can submit verification.
- Only the contract account can execute a transfer callback.
- A callback must match the exact stored operation ID, amount, recipient, project, and milestone.
- View methods cannot mutate state or transfer value.

### Verification and lifecycle

- A verification submission must identify the exact project and milestone.
- A receipt ID is globally single-use, even when its result is failed.
- A failed verification cannot authorize approval or settlement.
- Owner approval must refer to the latest passed receipt.
- Rework clears owner approval and requires a new receipt.
- A milestone cannot move from `Paid` or `Refunded` to any nonterminal state.
- A milestone cannot be settled twice.
- A payment cannot start unless status is `OwnerApproved`.
- A payment or refund cannot start while any payment/refund operation for the project is pending under the MVP serialization policy.
- Cancellation is forbidden after owner approval.
- A failed payment can be retried only after its confirmed failure callback.

### Dependencies

- Every dependency ID exists in the same project.
- A milestone cannot depend on itself or participate in a cycle.
- Every dependency is `Paid` before settlement.
- A dependency cannot be cancelled while a nonterminal milestone depends on it.
- A dependency in `Cancelled`, `Refunded`, `VerificationFailed`, or `PaymentPending` blocks settlement.

## Implemented callback behavior

Settlement records a project-level `PendingTransfer` before returning a `Promise` that transfers exactly the registered milestone budget to the registered recipient and schedules a private callback. The callback requires exactly one promise result and checks the stored operation ID, project ID, milestone ID, amount, and recipient.

On success, the callback clears the pending record, moves the budget from `reserved_balance` to `paid_balance`, and marks the milestone `Paid`. On failure, it clears only the pending record and returns the milestone to `OwnerApproved`, preserving the reservation for an explicit retry. A callback cannot finalize a payment based on promise creation alone.

Refunds use the same project-level serialization. The amount moves from `available_balance` to `pending_refund_balance` before the transfer. Success moves it to `refunded_balance`; failure restores it to `available_balance`. Duplicate callbacks find no pending record and fail.

## Transfer and callback model

NEAR native transfers are asynchronous. The contract must use a checks-effects-interactions order:

1. Validate signer, status, accounting, recipient, amount, dependencies, and operation uniqueness.
2. Change state to the pending form and persist the exact amount, recipient, project, milestone, and unique transfer ID.
3. Create the native NEAR transfer and attach a callback.
4. In the private callback, validate predecessor and the stored transfer record.
5. Consume the record exactly once and apply either the success or failure transition.

### Settlement success

Before the promise is created, status becomes `PaymentPending`; `reserved_balance` does not change. A successful callback requires one successful promise result and the matching pending transfer. It then:

- clears the pending payment;
- decreases `reserved_balance` by the exact budget;
- increases `paid_balance` by the exact budget;
- marks the milestone `Paid`;
- emits a success event.

### Settlement failure

A failed promise result is not a payment. The callback:

- clears the pending payment;
- keeps the budget reserved;
- returns the milestone to `OwnerApproved` (or a separately reviewed `PaymentFailed` state);
- emits a failure event.

The owner may retry a failed transfer only through a fresh `settle_milestone` call after the callback. A callback with no pending record, a mismatched transfer ID, an unexpected predecessor, or a second callback must fail without changing accounting.

### Refund success and failure

`refund_project` may run only when no milestone payment is pending. It moves `available_balance` into `pending_refund_balance` and records a pending refund to the project owner. Success moves that amount to `refunded_balance`. Failure restores it exactly once. Because reserved and pending-payment funds are excluded at call time, a refund cannot steal a payout budget.

The implementation should not infer transfer success from a local promise creation result. Only the callback’s promise result is authoritative.

## Threat model

### Untrusted actors

- A project owner may submit malformed project data, attempt to approve failed work, race transactions, or request excess refunds.
- An agent may be malicious or compromised. Agents have no contract authority and no wallet custody.
- An API may be compromised. It can submit transactions only through the caller’s account and cannot bypass contract checks.
- A non-authorized account may try to impersonate the verifier.
- A verifier may be compromised, make an incorrect attestation, or reuse receipt IDs.
- A recipient may be invalid, deleted, or unable to receive the transfer.
- A caller may replay old transaction payloads or callback payloads.

### Trusted assumptions

- NEAR runtime enforces transaction signatures, attached deposits, promise execution, and predecessor identity.
- The administrator key and verifier key are secured operationally. Key rotation is available before compromise is detected; it does not invalidate already stored attestations.
- The owner understands that approval authorizes payment but does not establish work correctness on-chain.
- Contract storage bounds and gas limits are enforced by implementation and tested on Testnet.

### Out of scope

- Cryptographic proof of AI output quality.
- Dispute arbitration, slashing, insurance, marketplace features, and multi-verifier threshold consensus.
- Cross-contract token transfers and fungible-token accounting.
- Contract upgrade governance. Upgrade authority must be designed separately before any mainnet use.

## Authorization and state attack cases

The implementation test suite must include at least these cases:

1. **Unauthorized verifier:** a non-verifier submits a passed receipt; call fails and state is unchanged.
2. **Verifier rotation:** an old verifier cannot submit a new receipt after rotation; existing stored attestations remain auditable.
3. **Unauthorized owner approval:** a non-owner calls approval; no approval is stored.
4. **Duplicate receipt:** the same receipt is submitted twice for the same or another milestone; the second call fails.
5. **Receipt mismatch:** approval references another milestone, project, digest, or receipt; call fails.
6. **Failed verification:** a failed result cannot be approved or settled.
7. **Replay after rework:** a previously used passed receipt is replayed after rework; call fails and approval remains clear.
8. **Double settlement:** settlement is called twice before callback and after success; only one transfer is created.
9. **Incorrect recipient:** state or callback recipient differs from the stored milestone recipient; callback fails safely and no payout is marked paid.
10. **Insufficient funding:** activation with insufficient `available_balance` fails; no partial reservation occurs.
11. **Dependency gap:** a dependent milestone is approved but a dependency is not `Paid`; settlement fails.
12. **Cancelled dependency:** a dependency cannot be cancelled while a live dependent exists.
13. **Invalid project ID:** calls for absent or malformed IDs fail without creating state.
14. **Invalid milestone ID:** calls for absent IDs fail without changing balances.
15. **Self/cyclic dependency:** registration rejects self-reference and a bounded cycle.
16. **Payment pending:** a second settlement or refund is attempted while a payment is pending; it fails.
17. **Refund during pending payment:** refund is attempted after payment initiation; it fails and leaves the reservation intact.
18. **Transfer callback success:** a matching success callback marks exactly one milestone paid and moves exactly one budget from reserved to paid.
19. **Transfer callback failure:** a matching failure callback clears pending state, leaves the reservation, and allows a later retry.
20. **Repeated callback:** the same callback is submitted twice or with a stale transfer ID; the second call fails without accounting changes.
21. **Unauthorized callback:** a direct user call to the callback is rejected by the private-caller guard.
22. **Refund callback failure:** refund transfer failure restores available balance once.
23. **Refund callback replay:** a second refund callback cannot restore the amount twice.
24. **Excess deposit:** an amount greater than all current milestone budgets remains refundable and is never paid automatically.
25. **Storage deposit separation:** storage stake and storage refunds do not alter project funding totals.
26. **Recipient edge cases:** invalid account IDs and zero-value budgets are rejected at registration.
27. **Bounded input:** oversized IDs, digests, receipt IDs, dependency lists, or milestone counts are rejected before unbounded storage/gas use.

## Event and audit requirements

Every state-changing path emits a versioned event with an actor and operation context. At minimum:

```text
project_created
project_funded
milestone_registered
milestone_funded
milestone_started
verification_submitted
milestone_approved
milestone_cancelled
payment_pending
payment_succeeded
payment_failed
refund_pending
refund_succeeded
refund_failed
verifier_changed
```

Events must not contain private evidence or credentials. The digest and receipt ID are public audit references. Event emission must occur only after the corresponding state mutation is internally valid.

## Design trade-offs

### One verifier instead of a verifier set

This reduces state and implementation time, but makes verifier key custody and availability a central risk. Rotation is required. A multi-verifier policy is deferred.

### Owner approval after verification

This prevents an independent verifier from unilaterally spending the owner’s budget, but it allows an owner to withhold payment after accepted work. A dispute/timeout path is intentionally deferred and must be a product decision before production use.

### Refund only from available balance

This is easy to reason about and safe with async transfers. It requires the owner to cancel eligible milestones before refunding their released budgets. A future version may support batch cancellation/refund with a more complex journal.

### Reject refund while any payment is pending

This serializes project withdrawals and sacrifices some throughput. It materially simplifies callback recovery for the MVP and removes a class of reservation/refund races.

### Store digest and receipt, not evidence

This keeps storage and gas bounded and respects the API’s off-chain evidence boundary. It means evidence availability, digest construction, and verifier behavior must be secured outside the contract.

## Known limitations and review gates

- An authorized verifier can still attest incorrectly; the contract cannot determine semantic correctness.
- There is no timeout, dispute, arbitration, or forced owner approval in the MVP.
- A lost verifier key or unavailable verifier can block new milestones until rotation.
- A recipient account that cannot receive funds causes a pending transfer failure and requires retry or cancellation policy.
- Storage and gas bounds must be selected from Testnet measurements, not guessed.
- A successful native transfer can become externally irreversible if its callback never executes; the contract deliberately does not mark such a transfer paid without callback confirmation. Callback gas and runtime behavior must be exercised on Testnet, and an operational procedure for stuck pending operations is still required.
- Upgrade authority and migration of serialized state require a separate review.
- The implementation must verify the exact `near-sdk` 5.30.1 APIs and callback behavior with a clean build before any deployment.

## Approval checklist before implementation

- [ ] Canonical project ID scope approved.
- [ ] Verifier account and rotation procedure approved.
- [ ] Status enum and cancellation policy approved.
- [ ] Storage deposit/refund policy approved.
- [ ] Retry policy for failed transfers approved.
- [ ] Owner timeout/dispute behavior explicitly accepted as out of scope.
- [ ] Exact SDK pin and clean WASM build verified.
- [ ] Unit tests, callback tests, and Testnet integration tests pass.
