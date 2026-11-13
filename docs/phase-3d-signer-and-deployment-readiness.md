# Phase 3D Signer and Deployment Readiness

Date: 2026-11-12
Network: NEAR Testnet

## Executive result

The original deployment is **not safely recoverable by the stated operator**. Local metadata makes the administrator and verifier credentials plausible, but the operator explicitly does not control those accounts and no signing test was permitted. The local files contain private-key fields and are mode `600`; their existence is not evidence of operational authority.

The missing server-side work is partially implemented as a strict signer boundary, but a real NEAR/KMS transaction transport is not installed or connected. Therefore the automated verifier is **not ready to submit live transactions** and must not be deployed as if it were complete.

The replacement deployment is technically prepared at the architecture and configuration-template level, but it is not deployment-ready until operator-controlled accounts, a restricted verifier access key, an approved NEAR signing transport, and durable submission state are provisioned.

No blockchain transaction, account operation, signature, deployment, receipt modification, or execution was performed.

## 1. Credential-access assessment

### Local metadata

The following metadata was inspected without reading, printing, copying, exporting, or logging private-key values:

- administrator credential file: `<operator-controlled NEAR credential path>`, mode `600`;
- verifier credential file: `<operator-controlled NEAR credential path>`, mode `600`;
- contract credential file also exists, mode `600`;
- no local credential directory for `lateram9099.testnet` was found;
- the CLI account index marks `attestra-owner.testnet` as a signer.

The administrator and verifier files expose public-key metadata matching the corresponding public access keys returned by finalized Testnet RPC. This is a metadata match only. Private-key usability and human control were not tested because doing so would require signing or broadcasting.

The operator-controlled `lateram9099.testnet` account has no local CLI credential directory in this environment. Its browser-wallet control is outside this filesystem audit.

### Finalized on-chain access-key views

Read-only RPC confirmed that each of these accounts exists with a FullAccess key:

- `attestra-owner.testnet`;
- `verifier.attestra-owner.testnet`;
- `lateram9099.testnet`.

FullAccess on an account does not prove who controls its private key. In particular, it does not give `lateram9099.testnet` administrator authority over the escrow contract.

### Deployment initialization evidence

The recorded initialization transaction `7gy3W4KocEPMEo5P7o6S9idj9fEu1XJszX9oBvNpLVzy` was read through Testnet RPC and confirmed as:

- signer: `attestra-owner.testnet`;
- receiver: `escrow.attestra-owner.testnet`;
- one function-call action;
- final status: `FINAL`;
- successful `SuccessValue` result.

The deployment report and contract source identify the initialized administrator as `attestra-owner.testnet` and authorized verifier as `verifier.attestra-owner.testnet`. The contract does not expose a public administrator/verifier getter.

### Access conclusion

- Original administrator access: **plausible from local metadata, not operationally established, and not recoverable under the operator’s stated control boundary**.
- Original verifier access: **plausible from local metadata, not operationally established, and not safe to use without explicit account-owner authorization**.
- `lateram9099.testnet` administrator authority: **none**. It is the project owner only.

## 2. Signer implementation

Added [restricted-verifier-signer.ts](../apps/api/src/restricted-verifier-signer.ts).

The component provides a narrow server-side transport boundary:

- accepts only `submit_verification`;
- requires the configured escrow contract as receiver;
- permits only `Passed` results;
- validates non-negative safe project/milestone IDs;
- validates a SHA-256-shaped artifact digest and non-empty receipt/idempotency key;
- passes the signer account, exact arguments, gas, deposit, and idempotency key to an injected server/KMS transport;
- rejects raw `NEAR_VERIFIER_PRIVATE_KEY` configuration;
- requires a server-only `ATTESTRA_NEAR_SIGNER_SECRET_REF` reference;
- exposes no signer capability to the frontend;
- cannot approve or settle milestones.

The existing [verifier-submission.ts](../apps/api/src/verifier-submission.ts) remains the authoritative validation/reconciliation layer. Together they enforce execution, immutable artifact digest, v4 receipt, Testnet, contract, project, milestone, owner, recipient, budget, receipt replay, finalized transaction, and final chain-state checks.

### What is not implemented

The repository still lacks a concrete NEAR cryptographic/KMS transport. `near-api-js` and the `@near-js/*` packages were not installed. A bounded package-install attempt was aborted after registry DNS failures; no package manifest or lockfile change resulted.

This was deliberate: embedding an unreviewed transaction/Borsh/Ed25519 implementation or using the local privileged files would be less safe than leaving the transport explicit. The adapter is ready to receive a reviewed transport, but it is not itself a live signer.

### Restricted access-key requirement

The production transport must use a dedicated verifier account with a restricted FunctionCall access key where supported. The key permission must name only:

- the replacement escrow contract account as receiver;
- `submit_verification` as the allowed method set;
- no transfer or owner-approval/settlement capability.

The transport must verify the finalized access-key permission before enabling the service and must keep the key in KMS/secret-manager infrastructure rather than the browser, repository, logs, or request payloads. The current adapter requires the transport boundary but cannot verify a permission that has not yet been provisioned.

## 3. Security regression tests

Added [restricted-verifier-signer.test.ts](../apps/api/test/restricted-verifier-signer.test.ts).

The signer-specific suite covers:

- forwarding the exact fixed function-call shape;
- rejecting a client-controlled receiver;
- rejecting a client-controlled method;
- rejecting a failed result;
- rejecting a malformed digest;
- refusing raw private-key configuration;
- requiring a secret-manager reference.

Combined with the existing verifier submission suite, 18 API signer/binding tests pass.

## 4. Replacement deployment preparation

`.env.example` now documents only the server-side secret reference:

```text
ATTESTRA_NEAR_SIGNER_SECRET_REF=
```

It does not accept or document a private-key value. The replacement contract should be deployed and initialized with:

- administrator: a new operator-controlled account with recoverable credentials;
- authorized verifier: a separate dedicated verifier-service account;
- project owner: `lateram9099.testnet` for the controlled demo, or a judge-controlled account for public judge flow.

The old project 0, milestone 0, receipt `attest-1794510501481-h8yi6rpx`, rejected receipts, artifacts, and execution records remain bound to the old contract. They must not be relinked or rewritten. A replacement contract requires fresh authoritative project/milestone linkage and fresh verification evidence bound to the replacement contract and IDs.

## 5. Validation results

- `pnpm typecheck`: passed;
- `pnpm lint`: passed;
- `pnpm test`: passed across all workspaces;
- signer and submission-boundary tests: 18/18 passed;
- `pnpm build`: passed;
- escrow Rust tests: 46/46 passed.

No live signer test was run. No blockchain write was attempted.

## 6. Exact operator actions remaining

1. Decide whether the local privileged credential files are legitimately controlled by the actual account owner. Do not use them merely because they exist.
2. If legitimate control cannot be established, archive the old deployment as historical and do not attempt recovery.
3. Create or designate an operator-controlled replacement contract account and administrator account through the normal NEAR Testnet process.
4. Provision a separate verifier service account and a restricted FunctionCall access key for only the replacement escrow contract’s `submit_verification` method.
5. Store the key in a KMS/secret manager and configure only its secret reference, account ID, contract ID, network, and measured deposits in the backend.
6. Install and review an approved NEAR signing transport. It must return a transaction hash only after signing/submission, never treat the hash as final success, and use durable idempotency plus finalized reconciliation.
7. Deploy and initialize the replacement contract under explicit operator authorization. This task did not do so.
8. Configure frontend/API with the replacement contract and preserve old execution data unchanged.
9. Create a fresh owner-linked project and milestone, fund and start it, then run a compliant execution and independent v4 verification.
10. Submit verification through the backend signer, reconcile finalized `VerificationPassed`, manually approve with the project owner, settle, and reconcile the callback to `Paid`.

## 7. Shortest path to a real payment

The shortest safe path is:

1. operator-controlled replacement contract;
2. dedicated restricted verifier FunctionCall key in KMS;
3. reviewed NEAR signing transport wired to `RestrictedVerifierSigner`;
4. durable idempotency and finality reconciliation;
5. fresh project/milestone linkage on the replacement contract;
6. passing v4 receipt bound to those exact IDs and digest;
7. backend verifier submission and finalized reconciliation;
8. manual owner approval and settlement;
9. finalized callback showing `Paid`.

## 8. Remaining blockers to public judge testing

- no verified operator control of the old administrator/verifier;
- no concrete NEAR signing/KMS transport installed;
- no restricted verifier access key provisioned;
- no replacement contract deployed or initialized;
- no durable public submission/reconciliation store;
- no fresh replacement-contract execution/receipt;
- owner approval and settlement still require the project owner by design.

## Final report

1. **Original administrator access recoverable?** Not safely established. Local metadata matches the on-chain key, but the operator disclaims control; no signing was attempted.
2. **Original verifier access recoverable?** Same conclusion: plausible metadata, no proven operational control.
3. **Server-side signing implemented and tested?** The restricted, fail-closed signing boundary is implemented and tested. The actual NEAR cryptographic/KMS transport is not implemented because the required dependency/infrastructure is unavailable.
4. **Replacement deployment technically ready?** Architecture and configuration template are ready; deployment is not operationally ready until operator-controlled accounts, restricted key, signing transport, and durable reconciliation are provisioned.
5. **Operator actions remaining?** Provision accounts and KMS signer, install/review transport, deploy/initialize replacement, configure backend/frontend, run fresh linked execution, then manually approve and settle.
6. **Shortest path to settlement?** Replacement contract → restricted backend verifier → fresh linked project/milestone → v4 verification → backend submission/reconciliation → owner approval → settlement callback.
7. **Public judge blockers?** Privileged account control, signer transport/key provisioning, replacement deployment, durable public service state, and a fresh replacement-contract browser demonstration.
