# Phase 3D Settlement Failure Investigation

## Conclusion

The settlement calls were broadcast, but all failed before the contract could
persist `PaymentPending` or schedule the recipient transfer. The exact cause
was an insufficient settlement storage deposit for the actual recipient
account. The browser attached `510000000000000000000` yoctoNEAR, while the
reviewed contract measured `640000000000000000000` yoctoNEAR for a settlement
whose recipient is `lateram9099.testnet`.

NEAR surfaced the Rust assertion as the generic:

`WebAssembly trap: An unreachable opcode was executed.`

This was not gas exhaustion, a callback failure, or evidence of a successful
payment.

## Authoritative chain state

Read directly from finalized NEAR Testnet RPC after the failures:

- Contract: `escrow.attestra-owner.testnet`
- Project: `0`
- Owner: `lateram9099.testnet`
- Total funded: `20000000000000000000000` yoctoNEAR (0.02 NEAR)
- Available: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Reserved: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Paid: `0`
- Pending payment: `null`
- Milestone: `0`
- Recipient: `lateram9099.testnet`
- Budget: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Status: `OwnerApproved`
- Approval receipt: `attest-1794510501481-h8yi6rpx`

The full budget remains reserved. No payment is marked paid and no pending
callback requires reconciliation.

## Failed transactions

Read-only Testnet RPC confirmed three settlement attempts, each targeting
`settle_milestone(0, 0)` from `lateram9099.testnet` with 30 Tgas and an attached
deposit of `510000000000000000000` yoctoNEAR:

| Transaction | Contract receipt | Result |
| --- | --- | --- |
| `3u3DUkR5MehZyk2DAMDZUazatbA1xGthdg1QRQX9hREw` | `BFjszZhnNiyJ1EecRnnSnhti8JgYU65nN2DiG5MqmzQ9` | Failed: unreachable opcode |
| `3JmwChWAJdnhvBpLEi3strc6dsnfugciqdBTajTCqbsQ` | `EDjKYTyzfF66yCEXxgF61WqEnfWthhqGhosJCSTiapVj` | Failed: unreachable opcode |
| `GviGVoDK5HVzP4J7pyNriC89xLnUpuuf6isVgxbqwit6` | `GLiyGJThXo2fco6nxXxwh1rDytFgYAT7vGFFGp4JJ4P4` | Failed: unreachable opcode |

Each contract receipt had no logs and no successful payment-transfer receipt.
The owner-side refund receipts completed, consistent with the failed action
deposit being returned subject to transaction gas. The failures consumed
approximately 2.053641062642 Tgas each; this is not a gas-exhaustion pattern.

## Failure mechanism

The deployed WASM code hash is
`6LN97djaf78PAqgk3oaGF3ik2TVzbxP4PistdRhYFFya`, which matches the base58
encoding of the SHA-256 hash of the reviewed local WASM:
`4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`.

`settle_milestone` records the pending transfer and measures the resulting
storage growth before accepting the attached storage deposit. The prior
`0.00051 NEAR` value was based on a short test recipient. The actual account ID
`lateram9099.testnet` is longer and increases the serialized pending-transfer
storage.

A local near-sdk reproduction using the actual recipient and the attached
`0.00051 NEAR` produced the contract assertion:

`Insufficient storage deposit: required 640000000000000000000 yoctoNEAR`

The on-chain generic unreachable trap is the deployed WASM/runtime form of
that failed assertion. The contract’s existing 46 Rust tests pass, including
pending-transfer, callback, retry, duplicate-settlement, and accounting tests.

## Correction applied

No smart-contract change or redeployment is required. The local runtime
configuration was corrected:

`NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO=640000000000000000000`

The API was restarted and its live configuration endpoint now reports:

- Network: `testnet`
- Contract: `escrow.attestra-owner.testnet`
- Approval deposit: `330000000000000000000`
- Settlement deposit: `640000000000000000000`

The failed transaction history and all contract state remain unchanged.

## Recovery plan

The current deployed contract and milestone can be reused. Do not fund again,
approve again, resubmit verification, or create another execution.

After confirming the browser has loaded the restarted API, the owner may make
one explicit settlement attempt with:

- Receiver: `escrow.attestra-owner.testnet`
- Method: `settle_milestone`
- Arguments: `project_id: 0`, `milestone_id: 0`
- Signer: `lateram9099.testnet`
- Attached deposit: `640000000000000000000` yoctoNEAR (0.00064 NEAR)

The wallet must be checked before confirmation. After signing, wait for
finality and reconcile authoritative state. A transaction hash alone is not
success: the expected sequence is `PaymentPending`, then callback-confirmed
`Paid`, with reserved decreasing by 0.01 NEAR and paid increasing by 0.01 NEAR.
Do not automatically rebroadcast an ambiguous result.

## Validation

- Direct finalized Testnet RPC project and milestone reads: passed.
- All three failed transaction outcomes and receipt outcomes: inspected.
- Deployed/local WASM hash comparison: matched.
- Local actual-recipient storage-deposit reproduction: required value confirmed
  as `640000000000000000000` yoctoNEAR.
- Rust contract tests: 46 passed; 0 failed.
- No blockchain write, retry, redeployment, approval, funding, or settlement
  was performed during this investigation.

## Final determination

The milestone is still safely `OwnerApproved`, with funds reserved and no
payment initiated. The smallest safe correction is the off-chain settlement
deposit configuration. A human-controlled retry is safe only after verifying
the wallet prompt shows the corrected `0.00064 NEAR` deposit and the exact
method/arguments above.
