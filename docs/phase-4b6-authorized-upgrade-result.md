# Phase 4B.6 Authorized Upgrade Result

Date: 2026-11-13
Network: NEAR Testnet only

## Result

Both explicitly authorized blockchain operations completed successfully and were independently verified at finalized state:

1. Contract upgrade: finalized.
2. Exactly one restricted verifier access key: finalized.

No verification, approval, settlement, account rotation, or other contract method was called.

## Contract upgrade

- Contract: `escrow.attestra-owner.testnet`
- Signer: `escrow.attestra-owner.testnet`
- Receiver: `escrow.attestra-owner.testnet`
- Method/action: one `DeployContract` action
- Transaction: `DwkJAtJKkYqsZkhm7AprgL54JwjfdbAcpVjh3B6UpmhS`
- Final status: `FINAL`, `SuccessValue`
- Gas burned: `26950409148576` in the transaction outcome; the finalized receipt outcomes were also successful.
- Final code retrieval block: `277566405` / `HyggXMef53qrUT9PEezsv7YLpi7re6DB7UFcHj94AAvC`
- Deployed WASM size: `412829` bytes
- Deployed WASM SHA-256: `355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`

The deployed hash exactly matches the reviewed upgrade artifact. The pre-upgrade hash was verified as `4f405f7adeb9b53b156ccaf5ef1629361584419642df835b30f387772952a3e9` before broadcast.

The transaction was sent through the corrected near-api-js 5.1.1 path after the broken near-cli import path was avoided. No automatic retry occurred.

## Existing state preservation

Finalized read-only views after upgrade confirmed:

- Project: `0`
- Milestone: `0`
- Owner: `lateram9099.testnet`
- Recipient: `lateram9099.testnet`
- Budget: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Milestone status: `Paid`
- Total funded: `20000000000000000000000` yoctoNEAR (0.02 NEAR)
- Available: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Reserved: `0`
- Paid: `10000000000000000000000` yoctoNEAR (0.01 NEAR)
- Storage credit: `12050000000000000000000` yoctoNEAR (0.01205 NEAR)
- Pending payment: `null`
- Pending refund: `null`
- Receipt: `attest-1794510501481-h8yi6rpx`
- Artifact digest: `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`
- Recorded verifier: `verifier.attestra-owner.testnet`

The project view was read at block `277566412` / `96Q2Gvrj6Gji9UxZiVZReyGhLd312DixvYGKH1xGDp3m`. The milestone view was read at block `277566418` / `Ebg5GPXpn7136ZMcLekGQwteyavcVx9CnjJvPP2H2Mfe`.

No state reset or reinitialization was performed. The existing Paid milestone and payment evidence remain intact.

## Restricted verifier key

Before creation, finalized access-key state showed only the existing verifier FullAccess key. No matching restricted key existed.

Exactly one AddKey transaction was then broadcast:

- Signer: `verifier.attestra-owner.testnet`
- Receiver: `verifier.attestra-owner.testnet`
- Transaction: `GRJktNUbFRjJ43McZpk8wszf4e1kZ2RwFFEQ79HQj852`
- Final status: successful
- New public key: `ed25519:BYsabqgMA3ps9EQxyD5H7FmnNcznf3MhZMUsa6tYcHMa`
- Final permission query block: `277566543` / `5kzk6iT9oyGDFZv8mucUorNwFW3ugPda2xhnWvZuNyX3`

Finalized permission:

```text
type: FunctionCall
receiver_id: escrow.attestra-owner.testnet
method_names: [submit_verification]
allowance: 100000000000000000000000 yoctoNEAR (0.1 NEAR)
```

The full account key list at block `277566548` / `D3cUeV3bktShw4YyPGnzrjsEPMwY2nL5qdQ3ppFFFNE9` contains the original FullAccess key and this one restricted key. The restricted key has no permission for unrelated contract methods and cannot attach a positive deposit. The old FullAccess key was not deleted because deletion was not authorized.

## Credential handling

The new restricted credential was stored outside the repository at:

`<operator-controlled restricted verifier credential path>`

Its file mode is `600`; the derived public key matches the finalized on-chain key. The private key was never printed, logged, committed, or sent to frontend code.

Production configuration must use this restricted credential only. It must reject the existing FullAccess verifier credential and require:

```text
ATTESTRA_REQUIRE_RESTRICTED_VERIFIER_KEY=true
NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO=0
NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID=verifier.attestra-owner.testnet
NEAR_ESCROW_CONTRACT_ACCOUNT=escrow.attestra-owner.testnet
NEAR_NETWORK=testnet
```

The backend's finalized permission validation and zero-deposit transport guard are already implemented and tested.

## Remaining production configuration

Before public hosting:

1. Put the restricted credential into the backend's server-only secret store or protected mounted file.
2. Do not copy the verifier FullAccess credential to the public host.
3. Set the production RPC, contract, verifier, zero-deposit, AI-provider, origin, session, and durable-storage configuration.
4. Deploy one persistent backend instance with durable storage.
5. Deploy the frontend with the production API origin.
6. Verify backend readiness and finalized access-key validation after startup.
7. Run the public smoke test using owner-wallet approval and settlement only after a genuine passing verification receipt exists.

No further blockchain write is authorized by this task.

## Phase 4B.7 readiness

Public hosting can proceed as the next operational phase, subject to secure secret provisioning and durable storage configuration. The chain upgrade and restricted-key prerequisites are complete. The application must still be smoke-tested in the actual production environment before claiming public deployment readiness.

## Final status

- Contract upgrade: **SUCCESS**
- Upgrade transaction: `DwkJAtJKkYqsZkhm7AprgL54JwjfdbAcpVjh3B6UpmhS`
- Final deployed WASM: `355bfde1ac971c8cb50354315e416ff30b616d5e8ed8eb5beb6950298f8a2a83`
- Paid milestone preserved: **YES**
- Restricted-key creation: **SUCCESS**
- Restricted-key permission: **FunctionCall → escrow.attestra-owner.testnet → submit_verification only → 0-deposit call capability**
- Public hosting can proceed: **YES, after server-only restricted credential and persistent production configuration are provisioned**
