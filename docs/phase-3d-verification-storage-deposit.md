# Phase 3D Verification Storage Deposit

Date: 2026-11-13

## Result

The exact minimum attached deposit for the recovered receipt shape is:

```text
3,080,000,000,000,000,000,000 yoctoNEAR
0.00308 NEAR
```

This value was derived from the reviewed contract implementation and an isolated local NEAR VM measurement using the exact deployed contract code, exact account identifiers, project/milestone shape, artifact digest, and receipt ID. No transaction was signed or submitted.

The value has been placed in the ignored local `.env.local` as `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO`. The backend’s in-process configuration check now reports the exact value. No credential or historical record was changed.

## Contract storage accounting

`submit_verification` does not use a fixed deposit. It:

1. Records `env::storage_usage()` before mutation.
2. Validates the authorized verifier, bounded digest/receipt lengths, receipt uniqueness, project existence, milestone existence, and `InProgress` status.
3. Inserts the receipt ID into the global `used_receipt_ids` collection.
4. Replaces the milestone with its verification attestation and status.
5. Flushes the nested milestone collection, project collection, receipt collection, and contract state.
6. Computes the storage delta multiplied by `env::storage_byte_cost()`.
7. Requires the attached deposit to be at least that computed amount.
8. Adds the entire attached deposit to the project’s `storage_deposit` accounting.

The helper is:

```rust
required = (storage_usage_after - storage_usage_before)
           * env::storage_byte_cost()
```

The reviewed deployed/local WASM uses the same implementation.

## Exact recovered receipt shape

- Receipt ID: `attest-1794510501481-h8yi6rpx`
- Receipt ID length: 29 bytes
- Artifact digest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`
- Digest length: 64 bytes
- Verifier: `verifier.attestra-owner.testnet` (31 bytes)
- Project ID: 0
- Milestone ID: 0
- Result: `Passed`

The local VM probe used the exact deployed account identifiers:

- administrator: `attestra-owner.testnet`
- verifier: `verifier.attestra-owner.testnet`
- project owner and recipient: `lateram9099.testnet`

It measured:

```text
storage before: 307200 bytes
storage after:  307508 bytes
delta:          308 bytes
storage byte cost: 10,000,000,000,000,000,000 yoctoNEAR
required:       3,080,000,000,000,000,000,000 yoctoNEAR
```

The local project setup used the same project/milestone identifiers, empty dependency list, exact receipt/digest lengths, and exact verifier/owner/recipient account strings. The live project’s finalized view also reports `next_milestone_id: 1` and `storage_deposit: 8,000,000,000,000,000,000,000` yoctoNEAR, consistent with the recovered project shape.

## Deployed-code verification

The local release WASM and the deployed contract were compared read-only:

| Source | SHA-256 | Bytes |
|---|---|---:|
| Local `attestra_escrow.wasm` | `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9` | 412,624 |
| Deployed `escrow.attestra-owner.testnet` code | `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9` | 412,624 |

The hashes and byte lengths match exactly. No deployment or upgrade was attempted.

## Excess deposit behavior

Excess is **not refunded** by `submit_verification`. The contract adds the full attached deposit to `project.storage_deposit` after satisfying the measured requirement. Therefore the exact measured minimum, `3080000000000000000000`, is the justified value for this receipt. Rounding upward would lock additional storage credit in the contract rather than return it.

The existing Rust test `verification_storage_deposit_is_not_project_funding` confirms that verification storage deposit accounting is separate from project funding balances. The contract source confirms there is no refund branch for excess verification deposit.

## Verifier balance

A finalized Testnet account view returned:

- verifier account: `verifier.attestra-owner.testnet`
- available account amount: `1,000,000,000,000,000,000,000,000` yoctoNEAR (`1 NEAR`)
- locked amount: `0`
- storage usage: `182`

The balance is sufficient for the exact `0.00308 NEAR` attached deposit plus transaction execution fees. This is a read-only balance observation; no funds were moved.

## Backend configuration and construction

The backend configuration path is now complete for this controlled local demonstration:

- `NEAR_NETWORK=testnet`
- `NEAR_RPC_URL=https://rpc.testnet.near.org`
- `NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet`
- `NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet`
- `ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE` points to the existing server-only credential file
- `NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=3080000000000000000000`

The backend’s `chainConfig()` parses this as a positive yoctoNEAR integer. `chainIntent()` uses it as the attached deposit, and the restricted signer forwards only the trusted `submit_verification` call. The browser cannot provide or override this value.

An in-process Fastify injection check loaded the ignored environment and returned:

```json
{
  "configured": true,
  "signerAccountId": "verifier.attestra-owner.testnet",
  "configurationError": null,
  "verificationStorageDeposit": "3080000000000000000000"
}
```

No live call was constructed for broadcast and no transaction was submitted.

## Tests inspected and run

- `verification_storage_deposit_is_not_project_funding`: passed.
- `successful_verification_is_stored_without_approval`: passed.
- Exact-account local storage probe: passed with 308-byte delta and 0.00308 NEAR minimum.
- Full local escrow implementation and deployed WASM comparison: exact SHA-256 match.
- Existing API configuration and signer readiness checks: passed in-process.

## Final answers

1. **Required deposit:** `3,080,000,000,000,000,000,000` yoctoNEAR.
2. **Equivalent:** `0.00308 NEAR`.
3. **Storage accounting:** dynamic measured storage growth after collection/state flushing, multiplied by NEAR storage byte cost.
4. **Excess refunded:** No. Excess is retained in the project’s storage-deposit accounting.
5. **Verifier balance:** Yes. The account has 1 NEAR, exceeding the deposit and expected fees.
6. **Safe for the existing receipt:** Yes, based on exact receipt/account shape, matching deployed WASM, and the live project state. The contract will still perform its own final storage measurement and fail closed if live state differs.
7. **API configuration complete:** Yes for the controlled local demonstration. The exact deposit is configured and readiness validation passes. Public deployment still requires the previously identified restricted signer and durable shared idempotency infrastructure.

The next action is a separately authorized live `submit_verification` transaction through the backend. This investigation did not perform it.
