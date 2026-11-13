# Phase 4B.5 Authorized Release Runbook

Date: 2026-11-13

This is a preparation-only runbook. No deployment, key creation, signing, or blockchain write was performed.

## 1. Deployment signer availability

A local credential file exists for:

`escrow.attestra-owner.testnet`

It is mode `600`, and its derived public key matched the account's finalized on-chain `FullAccess` key. This is a valid candidate deployment signer based on metadata and public-key comparison. It was not used to sign or broadcast a transaction during this review, so operational signing remains operator-confirmed at execution time.

The administrator credential is a separate account credential. Administrator authority must not be confused with code-deployment authority: the deployment signer must authorize the contract account deployment.

## 2. Tooling assessment

### Installed but unusable in the current shell

The installed classic CLI is `near-cli@4.0.13`. It fails before command dispatch because its optional `usb` dependency is incompatible with the active Node runtimes. Node 24 fails, and the same failure was observed under the locally installed Node 20 runtime. `near-cli-rs` and `cargo-near` are not installed. No unverified deployment tool was installed.

The repository's existing command remains the reviewed command, but it is not currently executable until the operator repairs or replaces the CLI runtime:

```bash
near deploy escrow.attestra-owner.testnet \
  <repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm \
  --networkId testnet
```

### Available reviewed SDK capability

The repository already has `near-api-js 5.1.1` installed for the backend. Its transaction API exposes the required `deployContract`, `addKey`, and `functionCallAccessKey` action constructors. It can therefore support an operator-reviewed signing script if the CLI remains unavailable. That script must use the contract-account credential, explicitly build one deployment action, and verify finality through Testnet RPC. It must not reuse the backend verifier signer for deployment.

Read-only state verification can use the already validated JSON-RPC endpoint:

`https://rpc.testnet.near.org`

with `status`, `view_code`, `view_account`, `view_access_key`, `get_project`, and `get_milestone` queries. The endpoint must report `chain_id: testnet` before any operator action.

No deployment tool is declared “working for writes” until the operator runs a separate non-production tool smoke test or accepts the reviewed near-api-js script. This release remains blocked until that choice is made.

## 3. Exact contract upgrade procedure

Operator confirmation is required immediately before the write.

1. Verify the artifact exists and hash it:

```bash
sha256sum <repository-root>/contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm
```

Expected SHA-256:

`355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`

2. Confirm the signer is the contract account deployment credential for `escrow.attestra-owner.testnet`.
3. Confirm the network is Testnet and the RPC endpoint is `https://rpc.testnet.near.org`.
4. Run the command above, or the separately reviewed near-api-js equivalent, once.
5. Do **not** call `new`; the contract is already initialized.
6. Wait for finality and record the deployment transaction hash.
7. Query `view_code` and verify the deployed bytes/hash against the expected artifact.
8. Query `get_project(0)` and `get_milestone(0, 0)` and require the existing `Paid` status, receipt, digest, recipient, and balances to be unchanged.

Expected deployment gas and cost are RPC/tool dependent. The operator must inspect the finalized receipt's actual gas and balance impact; this runbook does not guess a cost or attach a deposit to deployment.

Rollback artifact already archived:

`<repository-root>/.data/rollback/<rollback-wasm-artifact>`

Rollback SHA-256:

`4f405f7adeb9b53b156ccaf5ef1629361584419642df835b30f387772952a3e9`

## 4. Restricted verifier key procedure

This requires explicit operator authorization and a write by the existing verifier account. Do not use the existing FullAccess verifier key in a public backend.

Generate a new Ed25519 key using an approved local secret manager or isolated operator process. Keep the private half server-only and never print, commit, or place it in frontend configuration. Submit one `add_key` action from `verifier.attestra-owner.testnet` with:

```text
receiver_id: escrow.attestra-owner.testnet
method_names: exactly [submit_verification]
allowance: operator-selected gas allowance only
attached deposit capability: none; FunctionCall keys cannot attach a positive deposit
```

The equivalent near-api-js action shape is:

```ts
addKey(
  generatedPublicKey,
  functionCallAccessKey(
    "escrow.attestra-owner.testnet",
    ["submit_verification"],
    allowanceYocto
  )
)
```

The operator must use a supported transaction sender to submit that action from the verifier account. Do not use a CLI syntax copied from an unverified version. After finality, query the exact public key with `view_access_key` and require `FunctionCall`, the exact receiver, and exactly one method. Any `FullAccess`, extra method, wrong receiver, or missing permission is a stop condition.

The post-upgrade backend configuration must use:

```text
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
ATTESTRA_REQUIRE_RESTRICTED_VERIFIER_KEY=true
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=0
ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE=<restricted-key credential path>
```

The existing FullAccess verifier credential must not be copied to the public host, secret store, environment variable, or container image. The backend must start verifier submission only after finalized permission validation succeeds.

## 5. Short operator release sequence

Each numbered write or deployment step requires explicit confirmation:

1. Confirm the contract-account FullAccess deployment credential and expected WASM hash.
2. Deploy the reviewed WASM once.
3. Verify finalized code hash and preserved Paid project state using read-only RPC.
4. Create the restricted verifier FunctionCall key.
5. Verify its finalized receiver and method list.
6. Configure the backend with only the restricted credential and zero verification deposit.
7. Provision one persistent backend instance and durable storage; configure production origins, cookies, AI provider secret, and server-only signer secret.
8. Deploy backend and frontend.
9. Verify health, authentication, verifier readiness, and persistence recovery.
10. Run the public smoke test with a fresh judge wallet. The backend may submit only a genuine passing receipt; owner approval and settlement remain explicit owner-wallet actions.

Stop on any unexpected code hash, state change, signer identity, permission, finality, or reconciliation result.

## Remaining operator prerequisites

- Explicit authorization to upgrade `escrow.attestra-owner.testnet`.
- A supported write-capable NEAR transaction tool: repair the approved CLI runtime or approve a reviewed near-api-js operator script.
- Explicit authorization and secure handling for creating the restricted verifier key.
- Persistent production hosting and secret management.
- Final production smoke-test approval.

## Final status

1. Valid contract deployment signer available: **candidate available and public-key matched; live signing not attempted**.
2. Working NEAR deployment tooling: **read-only RPC and near-api-js action constructors work; installed near-cli 4.0.13 is blocked by its USB/Node incompatibility, so no write tool is currently certified**.
3. Exact contract deployment command: shown above; do not execute without operator authorization and a working signer tool.
4. Exact restricted-key procedure: one FunctionCall key on `verifier.attestra-owner.testnet`, receiver `escrow.attestra-owner.testnet`, method list exactly `submit_verification`, zero-deposit transaction behavior.
5. Remaining prerequisites: working write tooling, explicit contract upgrade authorization, restricted-key creation authorization, secure production hosting, and post-write finalized verification.

**No transaction was performed.**
