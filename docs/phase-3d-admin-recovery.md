# Phase 3D Administrator-Recovery Investigation

Date: 2026-11-12
Network: NEAR Testnet

## Recommendation

# DEPLOY REPLACEMENT CONTRACT

The operator-controlled `lateram9099.testnet` account is the owner of project `0`, but it is not the escrow administrator and cannot rotate the verifier. The deployed contract has no administrator-recovery, ownership-transfer, or emergency-verifier method. The existing administrator and verifier credential files are present on this workstation, but the operator explicitly does not control those privileged accounts; file presence is not proof of authorized access, and no private key was read or used.

The existing deployment can be retained only if the actual controller of `attestra-owner.testnet` authorizes a recovery path out of band. Under the stated access conditions, a replacement deployment owned and initialized by operator-controlled accounts is the safest judge-ready path. No replacement deployment was performed.

## Confirmed deployment history

The repository’s deployment script and documentation show this one-time flow:

- contract account/deployer: `escrow.attestra-owner.testnet`;
- initializer/administrator: `attestra-owner.testnet`;
- authorized verifier: `verifier.attestra-owner.testnet`;
- initializer: `new(administrator, verifier)`;
- initialization caller must equal the administrator;
- `set_authorized_verifier` is administrator-only and payable for measured storage growth;
- the deployment script refuses to overwrite an existing contract account and does not provide a recovery branch.

The local deployment report records deployment transaction `Bx92xgFa5rWGG336jntvwPphzbemjif76FZR2gMTnv33` and initialization transaction `7gy3W4KocEPMEo5P7o6S9idj9fEu1XJszX9oBvNpLVzy`. A read-only Testnet RPC lookup of the initialization transaction confirmed:

- signer: `attestra-owner.testnet`;
- receiver: `escrow.attestra-owner.testnet`;
- one `FunctionCall` action;
- final execution status: `FINAL`;
- status: `SuccessValue`.

The deployment report and initialization arguments identify the initialized administrator and verifier as `attestra-owner.testnet` and `verifier.attestra-owner.testnet`. The contract source independently confirms that these fields are stored during `new` and that the initializer caller is required to be the administrator.

## Local credential audit

Credential metadata was inspected without printing or reading private-key values:

- `<operator-controlled administrator credential>` exists, mode `600`, and contains the standard account/public/private-key fields.
- `<operator-controlled verifier credential>` exists, mode `600`, and contains the standard account/public/private-key fields.
- `<operator-controlled contract credential>` exists, mode `600`.
- A nested administrator credential file also exists, mode `600`.
- No local credential directory for `lateram9099.testnet` was found.
- The CLI account index marks `attestra-owner.testnet` as a signer, but this is local metadata, not proof that the current human operator is authorized to use it.

The existence of administrator/verifier files is a security finding, not a recovery conclusion. The current operator stated that neither privileged account is controlled. The files must not be copied, logged, tested by signing, committed, or used for this investigation. If they are not intentionally controlled, an account-owner/operator should handle their secure revocation or rotation separately.

## Read-only on-chain account and access-key findings

Finalized Testnet RPC views confirmed:

- `attestra-owner.testnet`: account exists and has a FullAccess key;
- `verifier.attestra-owner.testnet`: account exists and has a FullAccess key;
- `lateram9099.testnet`: account exists and has a FullAccess key;
- `escrow.attestra-owner.testnet`: account exists with deployed code and a non-default code hash.

A FullAccess key on an account proves only that the account currently has such a key on-chain. It does not identify the human controller or prove that a local private key is usable. No signing test was attempted.

`lateram9099.testnet` has no contract-administrator privilege merely because it owns project `0`. The contract’s administrator assertion compares the transaction predecessor to the stored administrator. Owner assertions apply to project lifecycle operations, not verifier rotation.

## Current project and milestone

Read-only finalized views of the deployed contract returned:

Project `0`:

- owner: `lateram9099.testnet`;
- total funded: `20000000000000000000000` yoctoNEAR (0.02 NEAR);
- available balance: `10000000000000000000000` yoctoNEAR (0.01 NEAR);
- reserved balance: `10000000000000000000000` yoctoNEAR (0.01 NEAR);
- paid balance: `0`;
- pending refund: none.

Milestone `0`:

- recipient: `lateram9099.testnet`;
- budget: `10000000000000000000000` yoctoNEAR (0.01 NEAR);
- status: `InProgress`;
- verification: none;
- approval receipt: none.

This state remains compatible with the existing passing v4 off-chain receipt, but no verifier transaction has been submitted on-chain.

## Recovery and rotation analysis

### Can the current administrator be recovered through the contract?

No supported recovery method exists. The contract stores `administrator` privately in contract state and exposes no public getter, ownership transfer, recovery key, or emergency override. `set_authorized_verifier` begins with `assert_administrator()` and therefore cannot be called by `lateram9099.testnet`, the contract account, the current verifier, or an arbitrary backend.

The only non-destructive possibility for retaining the deployment is for the actual controller of `attestra-owner.testnet` to sign the verifier rotation. That requires access outside this investigation and was not attempted.

### Can the verifier be rotated without the administrator?

No. The source and unit tests confirm administrator-only rotation. The call also requires the measured storage deposit. There is no permissionless rotation path.

### Can the existing project be refunded?

The owner can call `refund_project(0)` while the project is `InProgress`, provided no transfer is pending and the project has available balance. However, `refund_project` refunds only `available_balance`, which is currently 0.01 NEAR. The 0.01 NEAR reserved by milestone `0` is not available to that call.

The owner can call `cancel_milestone(0, 0)` from `InProgress`; the contract releases the milestone’s reserved budget back to the project’s available balance, subject to the contract’s dependency and pending-transfer checks. A subsequent owner refund can then return the released amount. These are two state-changing transactions and were not executed. Cancellation would end the current payment demonstration and cannot be used to recover administrator authority.

## Replacement deployment architecture

Use a new operator-controlled Testnet contract account and initialize it once with:

- administrator: an account actually controlled by the operator or a dedicated governance owner;
- authorized verifier: a separate dedicated verifier service account;
- owner/project account: `lateram9099.testnet` or a judge-controlled account for the demonstration.

The verifier must be separate from the owner and administrator. The backend should use a narrowly scoped function-call access key where NEAR’s account-key permissions support the required contract call. The key should be held by a KMS/secret manager or an isolated signer service, never in the frontend, repository, browser local storage, logs, or client-submitted payloads.

The signer service must:

1. accept only an internal execution identifier and server-selected passing v4 receipt;
2. revalidate artifact digest and exact Testnet contract/project/milestone/owner/recipient/budget state;
3. allow only `submit_verification` with server-generated arguments;
4. reject failed, skipped, stale, cross-network, cross-contract, replayed, or mismatched receipts;
5. use durable idempotency keyed by execution, receipt, and digest;
6. reconcile finalized transaction evidence and distinguish pending, failed, and unknown outcomes;
7. use bounded transport retries without creating a second authorization;
8. expose no private key or arbitrary contract-call capability to the API client;
9. leave owner approval and settlement on an owner-only path.

The current repository contains and tests the validation/idempotency boundary, but not a signing adapter or durable public service. That limitation must be resolved before deployment.

## Effect on existing evidence and bindings

A replacement contract does not inherit state from `escrow.attestra-owner.testnet`:

- project `0` and milestone `0` remain records on the old contract only;
- the old 0.02 NEAR remains subject to the old contract’s owner-controlled lifecycle;
- the existing v4 receipt remains valid historical off-chain evidence for its old contract binding, but cannot authorize payment on a replacement contract;
- the old rejected receipt, artifacts, execution records, and transaction records must remain immutable;
- a payment on the replacement contract requires a new authoritative project/milestone linkage and a receipt explicitly bound to the replacement contract and its IDs;
- reusing the old receipt by changing its contract or IDs would be invalid and must be rejected.

The safest approach is to preserve the old deployment and evidence as an archived historical demonstration, and run the new live payment through a fresh, operator-controlled contract and normal project/milestone workflow. No new execution or project was created during this audit.

## Exact operator actions

1. Securely determine whether the local admin/verifier credential files are intentionally controlled by the actual account owner. Do not use them based solely on filesystem presence. If control cannot be established, treat the old deployment as unrecoverable.
2. If access is legitimately recovered, use the existing deployment only after an authorized operator rotates the verifier to a dedicated service account and verifies the finalized rotation. Do not change the old project or receipts.
3. Otherwise, provision a new Testnet contract account controlled by the operator, build the reviewed escrow WASM, and deploy/initialize it through a separately reviewed write-enabled procedure.
4. Provision a separate verifier service account/key with restricted contract-call permission where supported; fund only the required gas/storage amount.
5. Configure the backend with the new contract, administrator/verifier identities, RPC, deposit values, signer/KMS reference, durable idempotency store, and finality reconciliation. Keep all credentials server-side.
6. Run the normal workflow on the replacement contract: connect owner wallet, create project, register milestone, fund, activate, start, create a compliant execution, verify the exact artifact, submit via the backend verifier, reconcile `VerificationPassed`, manually approve with the project owner, settle, and reconcile the callback to `Paid`.
7. For independent judges, expose a public HTTPS frontend/API with clear network and contract identifiers. Judges should use their own wallet for a judge-owned project or an explicitly provided owner-controlled demonstration account; they must never need the verifier or administrator key.
8. Publish the old contract and replacement contract IDs separately in the hackathon materials so historical evidence is not confused with the live judge path.

## Minimum critical path

The minimum safe path to a judge-testable payment is:

1. operator-controlled replacement contract and initialized verifier identity;
2. server-side restricted signer with durable idempotency and finality reconciliation;
3. backend/frontend configuration pointing to the replacement contract;
4. a fresh owner-created and funded milestone;
5. a genuinely passing v4 receipt bound to that exact project/milestone/contract;
6. backend verifier submission and finalized `VerificationPassed` evidence;
7. manual owner approval and settlement;
8. finalized callback evidence showing `Paid`;
9. browser tests using a non-privileged judge wallet for the judge-owned flow.

No blockchain writes were made in this investigation, and no credentials or private-key contents were exposed.
