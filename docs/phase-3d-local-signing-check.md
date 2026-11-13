# Phase 3D Local Signing Capability Check

Date: 2026-11-12
Network: NEAR Testnet

## Scope and safety

This was a local-only cryptographic capability check. It used a clearly labeled non-transaction message in memory, verified the resulting Ed25519 signature, and discarded the signature. It did not construct, sign, or broadcast a NEAR transaction. No private key, seed phrase, signed payload, or signature bytes were printed or logged. Credential files were not modified.

## Available signing tools

Detected locally:

- NEAR CLI: installed at the local Node toolchain;
- Rust/cargo: installed;
- OpenSSL: installed;
- Node.js: installed;
- NEAR CLI’s bundled `@near-js/crypto`: available locally;
- project-local `near-api-js`, `@near-js/crypto`, `tweetnacl`, and `@noble/ed25519`: not installed.

The test used the already installed NEAR CLI crypto implementation. No dependency was installed.

## Test method

For each credential independently, the test:

1. Loaded the credential only into process memory.
2. Parsed its NEAR Ed25519 key pair using the bundled NEAR crypto implementation.
3. Signed a fixed non-transaction test message: `ATTESTRA local signing capability check; non-transaction test message`.
4. Verified the signature against the derived public key.
5. Compared the derived public key with the credential’s public-key metadata.
6. Performed a read-only `view_access_key_list` RPC call and compared the credential public key with the registered on-chain key and permission.

No NEAR transaction object, nonce, block hash, function call, or broadcast was involved.

## Results

### Administrator: `attestra-owner.testnet`

- local signature verification: **passed**;
- derived public key matched credential metadata: **passed**;
- credential public key matched a finalized on-chain access key: **passed**;
- registered permission: **FullAccess**.

### Verifier: `verifier.attestra-owner.testnet`

- local signature verification: **passed**;
- derived public key matched credential metadata: **passed**;
- credential public key matched a finalized on-chain access key: **passed**;
- registered permission: **FullAccess**.

## Operational interpretation

The local files can produce valid NEAR-compatible Ed25519 signatures, and their public keys correspond to the currently registered account keys. This establishes local cryptographic signing capability for both accounts.

It does not by itself establish that the current human operator is authorized to use those accounts. The task restrictions prohibited transaction signing and account operations, so administrator control and verifier account ownership remain an operator-governance question. The credentials must not be used solely because they are present on disk.

### Administrator signing

**Operational locally:** yes, the non-transaction signature test passed.

The administrator credential could technically sign an administrator-only contract call, including verifier rotation, but no such call was created or submitted. Use requires explicit authorization from the account owner and secure operational handling.

### Verifier signing

**Operational locally:** yes, the non-transaction signature test passed.

The verifier credential could technically sign a NEAR transaction, but the current account has FullAccess rather than a least-privilege FunctionCall key. It should not be used as a public backend credential. Provision a separate verifier service key restricted to the escrow contract and `submit_verification`, then rotate the contract only through an authorized administrator action.

### Existing deployment

The original deployment can technically be retained if the operator receives explicit authority to operate the matching administrator/verifier credentials. The local signature test removes the cryptographic-capability blocker, but it does not override the previously stated lack of account control.

Without that authorization, retain the earlier recommendation to deploy a replacement contract under operator-controlled administrator and verifier identities.

### Existing passing receipt

The v4 receipt `attest-1794510501481-h8yi6rpx` remains eligible for the existing project/milestone submission path subject to the previously implemented backend validation. It was not submitted. No receipt, execution, artifact, or chain state was changed.

## Exact next steps for the first payment

1. Obtain explicit operator authorization for the administrator and verifier accounts, or choose the replacement deployment path.
2. Do not use the existing FullAccess verifier key as a public service credential. Provision a dedicated restricted FunctionCall key held by a KMS/secret manager.
3. Install and review a production NEAR signing transport using the restricted key; keep it server-side and expose only the fixed verifier intent.
4. If retaining the old contract, have the authorized administrator rotate the contract verifier to the dedicated service account and reconcile that finalized change. This was not performed here.
5. Run the backend’s existing receipt/digest/linkage validation for `attest-1794510501481-h8yi6rpx`.
6. Submit verification only through the restricted backend signer and reconcile finalized `VerificationPassed` state.
7. Use `lateram9099.testnet` for manual owner approval and settlement. The verifier must not approve or settle.
8. Reconcile the callback and require final `Paid` state before displaying payment evidence.

If the original privileged accounts cannot be authorized for use, deploy the operator-controlled replacement contract and create fresh project/milestone linkage and verification evidence; the old receipt cannot authorize payment on a replacement contract.

## Final findings

1. **Administrator local signing:** passed; public key and on-chain FullAccess key matched.
2. **Verifier local signing:** passed; public key and on-chain FullAccess key matched.
3. **NEAR-compatible signing integration:** cryptographic capability is available locally, but the production backend signer still needs a reviewed transport and restricted access key.
4. **Original contract retention:** technically possible if explicit account authorization is established; not automatically safe based on file presence.
5. **Existing receipt:** remains eligible but was not submitted.
6. **Blockchain changes:** none.
