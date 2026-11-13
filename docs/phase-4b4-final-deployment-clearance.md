# Phase 4B.4 Final Deployment Clearance

Date: 2026-11-13

## Verdict

**BLOCKED — not ready for authorized deployment.**

All read-only chain checks and local validation checks completed successfully. The remaining blocker is intentional: the currently registered verifier key is FullAccess, while production configuration now rejects FullAccess and requires a restricted FunctionCall key limited to `submit_verification` with zero attached deposit. No blockchain write was performed.

## RPC and finalized chain evidence

The configured RPC hostname initially failed DNS resolution inside the WSL sandbox. With bounded network access enabled, the configured endpoint was reachable and returned `chain_id: testnet`. The read-only endpoint used for the evidence below was:

`https://rpc.testnet.near.org`

The checked endpoint reported Testnet block height `277561803` at the status query, hash `7bV27TQ3o3RxYN71RebpmE6CMyPifYDgP72vis5Yi2eZ`.

Finalized contract views returned:

| Item | Result | Evidence block |
|---|---:|---|
| Project 0 owner | `lateram9099.testnet` | `277561767` / `BtfqAHjcbfWkpRmaQQEeWQVnDWwjf7ctYzHJ1RYdtacw` |
| Total funded | `20000000000000000000000` yoctoNEAR (0.02 NEAR) | same project view |
| Available balance | `10000000000000000000000` yoctoNEAR (0.01 NEAR) | same project view |
| Reserved balance | `0` | same project view |
| Paid balance | `10000000000000000000000` yoctoNEAR (0.01 NEAR) | same project view |
| Storage credit | `12050000000000000000000` yoctoNEAR (0.01205 NEAR) | same project view |
| Milestone 0 recipient | `lateram9099.testnet` | `277561774` / `917bEc6V1L4mzyfmpRwUD5uc4eHga5gCpf6HjD5sbNdo` |
| Milestone 0 budget | `10000000000000000000000` yoctoNEAR (0.01 NEAR) | same milestone view |
| Milestone 0 status | `Paid` | same milestone view |
| Recorded receipt | `attest-1794510501481-h8yi6rpx` | same milestone view |
| Recorded verifier | `verifier.attestra-owner.testnet` | same milestone view |
| Recorded artifact digest | `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6` | same milestone view |

The project query using the complete deployed signature (`owner`, `from_index`, `limit`) returned `[0]`. The project and milestone are therefore independently readable and the completed payment remains intact. The project has no reserved or pending payment balance.

The deployment metadata and the successful finalized verification record identify `verifier.attestra-owner.testnet` as the authorized verifier. The contract does not expose a public getter for its private `authorized_verifier` field; the milestone's finalized verification records the verifier identity, and the original deployment initialization metadata records the same configured verifier.

## Deployed WASM archive

The deployed code was retrieved with a read-only `view_code` query at finalized block:

`277561834` / `Ejh5cCAmvvmR8CyFNqfLcUqMVLrgvqMxK6JZAf4woiPC`

Rollback artifact:

`<repository-root>/.data/rollback/<rollback-wasm-artifact>`

- Size: `412624` bytes
- SHA-256: `4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`
- Contract: `escrow.attestra-owner.testnet`
- Retrieval: finalized Testnet RPC, as above

The file is nonempty and its hash matches the predecessor hash recorded in the prior release review. It was saved separately and did not overwrite the proposed upgrade artifact.

## Proposed upgrade review

Proposed artifact:

`<repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm`

- Size: `412829` bytes
- SHA-256: `355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`

The hash is unchanged from the reviewed Phase 4B.3 artifact and the release WASM build reproduced it exactly.

The local source review identifies one intended behavioral change: `submit_verification` now accepts a zero attached deposit when the existing project storage credit is sufficient, charges the calculated verification storage cost against that project credit, and preserves the existing positive-deposit path. Verifier authorization, project/milestone binding, receipt replay protection, and accounting checks remain in place. No serialized state fields were added or reordered. Existing project and milestone views decoded successfully from the deployed state, and project 0/milestone 0 is Paid.

The proposed WASM is not deployed. A byte-level semantic comparison cannot be inferred from the two hashes alone; the method-level conclusion is based on the reviewed source and the 48 Rust tests, including zero-deposit, insufficient-credit, unauthorized-verifier, replay, and accounting cases.

## Deployment authorization

Read-only finalized access-key queries found:

- `escrow.attestra-owner.testnet`: one `FullAccess` key, public key `ed25519:FtV8khC1f2UrmCVn5XmjsTvYFB8BeTRQwkXYM36s2K6q`, block `277562580` / `BXPdn9ReD7goZURUMVCmddb5h7LbvzpRHMC8LTaSmV7g`.
- Local operator credential at `<operator-controlled NEAR credential path>` is mode `600`; its derived public key matched that on-chain key. Private material was not printed or logged.
- `attestra-owner.testnet`: one `FullAccess` key whose derived local public key matched the finalized on-chain key.
- `verifier.attestra-owner.testnet`: one `FullAccess` key whose derived local public key matched the finalized on-chain key.

The required deployment authority is the contract account's authorized FullAccess identity, `escrow.attestra-owner.testnet`, or an operator-controlled account/key with equivalent authority according to the chosen deployment tool. The local contract credential metadata makes deployment authorization plausible, but no signing or deployment was attempted in this review.

The local verifier credential is **not** a restricted key. Production must reject it. The new bootstrap validation checks the derived public key against finalized RPC state and requires:

1. exact account `verifier.attestra-owner.testnet`;
2. `FunctionCall` permission, not `FullAccess`;
3. receiver exactly `escrow.attestra-owner.testnet`;
4. exactly one allowed method, `submit_verification`;
5. zero attached deposit enforced by the server transport.

## Source changes in this review

- `packages/near-readonly/src/index.ts`: preserves FunctionCall receiver and method-name details when reading a finalized access key.
- `apps/api/src/verifier-bootstrap.ts`: derives the credential public key in memory, validates finalized on-chain permission, rejects FullAccess in production/restricted mode, and binds the account and receiver identities.
- `apps/api/src/near-signing-transport.ts`: restricted mode rejects every nonzero deposit before account transport invocation.
- `apps/api/src/restricted-verifier-signer.ts`: exposes only an internal restricted-key capability flag for the submission boundary.
- `apps/api/src/verifier-submission.ts`: permits deposit `0` only when the injected signer is marked restricted; positive deposits remain required for non-restricted signers.
- `apps/api/test/verifier-permission.test.ts`: exact permission, receiver, method, and account mismatch tests.
- `apps/api/test/near-signing-transport.test.ts`: zero-deposit restricted transport regression test.

No contract, receipt, execution, project, milestone, or live chain state was modified.

## Validation

- Rust tests: **48 passed, 0 failed**.
- Release WASM build: **passed**.
- Proposed WASM hash: **unchanged**, `355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`.
- API typecheck: **passed**.
- Workspace typecheck: **passed**.
- Workspace lint: **passed**.
- API tests: **62 passed, 0 failed**.
- near-readonly tests: **4 passed, 0 failed**.
- Frontend tests: **26 passed, 0 failed**.
- Next.js production build: **passed**; `/workspace` was included in the generated app routes.

The test run did not create credentials, submit a transaction, or alter chain state.

## Exact operator sequence

The following steps require explicit operator authorization and must be performed only after reviewing the archived WASM and proposed hash.

### 1. Upgrade the existing contract

Use the operator-controlled deployment credential for `escrow.attestra-owner.testnet` and the reviewed artifact:

```bash
near deploy escrow.attestra-owner.testnet \
  <repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm \
  --networkId testnet
```

Do not call `new` after the upgrade. The contract is already initialized; reinitialization must fail and must not be attempted.

### 2. Verify the upgrade read-only

Query `view_code` and compare the deployed code hash/bytes with SHA-256 `355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`. Then query `get_project(0)` and `get_milestone(0, 0)` and confirm the records, `Paid` status, balances, receipt, and digest remain unchanged. If any state differs unexpectedly, stop and use the archived predecessor for operator-led recovery; do not run initialization.

### 3. Create the restricted verifier key

Generate the public/private key pair using the operator's approved secret-management process. Do not put the private key in source, browser configuration, logs, or a public deployment image. Add the public key to `verifier.attestra-owner.testnet` with a FunctionCall permission whose receiver is `escrow.attestra-owner.testnet`, whose only method is `submit_verification`, and whose allowance is sufficient for gas but does not need to cover a deposit. The exact CLI flag syntax must be confirmed against the operator's working NEAR CLI version before execution; the installed local CLI could not display help because its optional USB module is incompatible with Node 24.

After the write, query `view_access_key` and verify the exact receiver and method list. Do not configure the backend until that read-only check passes.

### 4. Configure the backend

Set server-only values in the deployment secret store, not the frontend:

```text
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE=<server-only restricted-key file>
ATTESTRA_REQUIRE_RESTRICTED_VERIFIER_KEY=true
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=0
```

The API must start only with a finalized on-chain FunctionCall key matching the exact receiver and method policy. Missing, FullAccess, wrong receiver, extra method, or wrong account must leave verifier submission unavailable. Never set a raw private-key environment variable.

### 5. Deploy the application and run the public test

Deploy the API as one persistent instance with durable storage and the frontend with the production API origin. Confirm health, authentication, execution history, and verifier readiness. Then use a fresh judge wallet for ordinary owner actions. The backend may submit only the independently generated, passing receipt; the owner wallet must remain responsible for approval and settlement. Confirm each transaction by finalized RPC state, not by a transaction hash alone.

## Remaining risks and blockers

1. **Blocking:** no restricted verifier key currently exists on-chain; the observed key is FullAccess.
2. **Blocking:** the proposed contract upgrade has not been deployed, so zero-deposit verification is not live.
3. **Blocking:** production hosting, secret management, and durable storage provisioning remain operator work.
4. The installed `near` CLI help path is currently broken by an optional USB/Node 24 incompatibility. This does not affect read-only RPC or the reviewed WASM, but the operator should use a supported NEAR CLI/runtime or a reviewed deployment tool before the write window.
5. The archived predecessor is a recovery artifact, not proof that an automated rollback transaction has been tested. Rollback requires the same contract deployment authority and operator approval.

## Final response

1. RPC connectivity: **restored with bounded network access; Testnet confirmed**.
2. Finalized milestone: **Paid**; project balances show 0.01 NEAR paid and 0.01 NEAR available.
3. Current deployed WASM SHA-256: **`4f405f7adeb9f53b156ccaf5ef1629361584419642df835b30f387772952a3e9`**.
4. Proposed upgrade WASM SHA-256: **`355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`**.
5. Deployment authorization: **local contract credential matches the contract account's finalized FullAccess key; no signing was attempted**.
6. Restricted-key validation: **implemented and tested; live configured verifier is FullAccess and therefore rejected for production**.
7. Remaining blockers: contract upgrade, restricted key creation, production secret/persistence hosting, and public deployment have not been authorized or executed.

**Final verdict: BLOCKED.**
