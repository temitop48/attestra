# ATTESTRA NEAR Testnet deployment

This workflow prepares the existing escrow contract for Testnet. It is dry by default. Do not paste private keys or seed phrases into ChatGPT, source files, `.env` files committed to the repository, or issue trackers.

## Contract initialization

The contract initializer is:

```text
new(administrator: AccountId, verifier: AccountId) -> Escrow
```

It is `#[init]` and `#[payable]`. The initialization caller must equal `administrator`, and the attached deposit must cover measured contract storage. Initialization cannot be repeated because the contract rejects an existing state. Deployment and initialization are separate NEAR transactions in this workflow; they are not assumed to be atomic.

## Accounts

Use Testnet accounts for:

1. The contract account, which owns the deployed code.
2. The administrator account, which must initialize the contract and can rotate the verifier.
3. The authorized verifier account, which submits verification attestations later.

The contract account and deployment signer are intentionally required to be the same in this minimal workflow. Check balances with the NEAR wallet or a read-only CLI/RPC account query before deployment. Keep enough Testnet NEAR for storage, gas, and the initialization deposit.

## Configure and prepare

Copy `.env.near-testnet.example` to a local, ignored environment file and replace only the account placeholders. Keep `NEAR_NETWORK=testnet`. The deployment script rejects Mainnet and invalid account IDs.

Run:

```bash
pnpm near:prepare
```

This builds `contracts/escrow` for `wasm32-unknown-unknown`, records the SHA-256 hash, validates initialization arguments, and writes a 0600 deployment report. It performs no NEAR CLI call and no blockchain write.

The exact initializer arguments are:

```json
{"administrator":"<administrator-account>","verifier":"<authorized-verifier-account>"}
```

## Authorized deployment

Review the WASM hash and report first. Ensure the standard classic NEAR CLI is installed and authenticated locally through its normal credential store. Do not pass a private key on the command line.

The future write-enabled invocation requires all of:

```bash
NEAR_CLI_MODE=classic \
ATTESTRA_DEPLOY_AUTHORIZATION=I_UNDERSTAND_ATTESTRA_TESTNET_DEPLOYMENT \
node scripts/deploy-near-testnet.mjs --execute
```

The script checks Testnet, checks that the contract account does not already contain code, invokes the classic CLI deployment command (`near deploy <account-id> <wasm-file> --networkId testnet`), then invokes `new` from the administrator with the configured storage deposit. It stops on any failed command and never silently redeploys existing code.

This workflow targets the deprecated JavaScript `near-cli` command family. The newer Rust `near-cli-rs` has a different command syntax and is not interchangeable with this script.

Review the actual CLI output and record the returned deployment and initialization transaction hashes in the local environment only:

```text
NEAR_DEPLOYMENT_TRANSACTION_HASH=...
NEAR_INITIALIZATION_TRANSACTION_HASH=...
```

The script never invents transaction hashes.

## Verify deployment

Run the read-only verification phase after reviewing the real hashes:

```bash
node scripts/deploy-near-testnet.mjs --verify
```

It verifies the Testnet chain ID, reads the contract account state through RPC, records the WASM hash and supplied transaction hashes, and writes a deployment report. Account code presence alone is not treated as proof that initialization succeeded; initialization must also be reviewed from the initialization transaction outcome and contract view behavior.

## Troubleshooting

- `NEAR_NETWORK must be exactly testnet`: remove any Mainnet configuration and use `NEAR_NETWORK=testnet`.
- Invalid account ID: use lowercase NEAR account IDs with valid subaccount syntax.
- Existing code detected: stop and review the account; the script will not overwrite it.
- Initialization rejected: confirm the caller is the administrator and that the attached deposit is sufficient.
- RPC chain mismatch: confirm the RPC URL is Testnet and not a proxy for another network.
- CLI not found: install and authenticate the standard NEAR CLI locally; do not add credentials to this repository.
- Transaction failure or timeout: stop, inspect the real transaction outcome, and do not retry initialization blindly.

No deployment, account creation, funding, signing, or transaction was performed while preparing this workflow.
