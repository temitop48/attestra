# ATTESTRA Hackathon Demo Runbook

This runbook is for a controlled, read-only-first presentation. Do not create a production project, submit a new verification, approve a milestone, settle payment, or broadcast a transaction during the demo unless separately authorized.

## Demo order

### 1. Establish the product

Open <https://attestra-woad.vercel.app>.

Show the homepage sections:

- product statement;
- **How It Works**: brief → agents → verification → payment;
- Research, Builder, and QA specialists;
- proof-gated NEAR Testnet payment language.

Do not describe the landing-page copy as proof that a live AI run has just occurred.

### 2. Open the workspace

Select **Get Started** or open <https://attestra-woad.vercel.app/workspace>.

Expected initial state:

- project brief form is visible;
- execution history is available after authentication;
- wallet status initially shows disconnected/not authenticated;
- chain and payment panels are disabled until an execution is selected and the required wallet state exists.

For a local deterministic rehearsal, run the commands in the README with `ATTESTRA_DEMO_MODE=true`, then use the same workspace flow. Label that run as deterministic demo output, not real AI evidence.

### 3. Show autonomous execution

For a local rehearsal:

1. Enter a bounded landing-page brief with audience and constraints.
2. Submit **Start autonomous execution**.
3. Show the console moving through Research, Builder, and QA.
4. Show the timeline, agent assignments, QA result, validation report, rework history where present, final revision, and artifact digest.

Expected successful state:

- lifecycle `completed`;
- status `AwaitingIndependentVerification`;
- final deliverable and revision digest visible;
- QA assessment and deterministic validation evidence visible.

The production database cannot be read anonymously. Do not claim a specific production execution is available unless the prepared authenticated owner/operator session loads it successfully.

### 4. Show deliverables and verification

Select the execution, then open **Deliverables**, **QA Evidence**, and **Verification**.

Show the artifact files and digest, QA/validation evidence, verification status, receipt binding, and verifier identity.

Historical finalized verification evidence:

```text
Transaction: 6H2TcnRLxs9sCjLMJV8M343SxQiwENHiS61dJZpTLDez
Contract:    escrow.attestra-owner.testnet
Method:      submit_verification
Project:     0
Milestone:   0
Receipt:     attest-1794510501481-h8yi6rpx
Digest:      0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6
```

This is historical evidence. Do not submit it again or attempt to reuse it.

### 5. Show NEAR chain evidence

Use the workspace chain panel only after an authenticated session loads an execution with confirmed linkage. Show:

- NEAR Testnet network;
- contract `escrow.attestra-owner.testnet`;
- project and milestone IDs;
- owner, recipient, and milestone budget;
- finalized funding and verification evidence;
- payment status and balances.

The latest read-only public RPC inspection confirmed project `0` / milestone `0` as `Paid`, with `0.01 NEAR` paid and no pending payment. The repository does not preserve the exact settlement transaction hash in accessible evidence, so present the finalized chain state rather than inventing a transaction reference.

### 6. Explain authorization boundaries

State clearly:

- Research, Builder, and QA do not hold wallet keys.
- Independent verification is separate from QA.
- Backend verifier submission is separate from owner approval.
- Owner approval and settlement require the project owner wallet.
- A transaction hash alone is not payment success; the UI waits for finalized contract state.

The documented owner for the existing project is `lateram9099.testnet`. Do not ask a judge to sign unless the owner-controlled demonstration session and explicit authorization are available.

## Evidence matrix

| Evidence | Status | Source or limitation |
|---|---|---|
| Homepage and workspace | Verified | Production HTTP 200 and deployed bundle inspection |
| Agent workflow | Verified locally | Deterministic API/orchestrator tests and workspace UI |
| Completed execution | Available locally | Deterministic demo/tests; authenticated production record not anonymously accessible |
| Generated deliverable | Available locally | Artifact persistence, digest, and viewer tests |
| QA assessment | Available locally | QA/validation tests and historical records |
| Independent receipt | Verified historically | Receipt and finalized `submit_verification` transaction above |
| NEAR Testnet configuration | Verified | Production `/api/v1/near/config` and `/api/v1/near/status` |
| Funded milestone | Verified historically/currently | Public finalized project state and repository reports |
| Successful settlement | Chain state verified | Milestone currently `Paid`; exact settlement hash unavailable in accessible evidence |

## Read-only production preflight

```bash
curl -sS https://attestra-api-o3ol.onrender.com/health
curl -sS https://attestra-api-o3ol.onrender.com/api/v1/near/config
curl -sS https://attestra-api-o3ol.onrender.com/api/v1/near/status
curl -sS https://attestra-api-o3ol.onrender.com/api/v1/near/verifier-status
```

Expected:

- health returns `status: ok`;
- network is `testnet`;
- contract is `escrow.attestra-owner.testnet`;
- authorized verifier is configured;
- no credential material is exposed.

Unauthenticated `/api/v1/auth/me` and `/api/v1/executions` should return `401`.

## Troubleshooting

- **Workspace shows API unavailable:** confirm the deployed frontend bundle points to `https://attestra-api-o3ol.onrender.com`; check `/health`; reload once after hosting wake-up.
- **Wallet button remains disabled:** wait for wallet connector initialization, use a NEAR Testnet wallet, and confirm the browser is not blocking the wallet modal.
- **Connected but actions remain disabled:** wallet connection is not API authentication. Complete NEP-413 authentication and verify the displayed account.
- **Execution history is empty:** authenticate with the owner/operator session that owns the records; anonymous reads are intentionally rejected.
- **Chain linkage is unavailable:** stop. Do not attach a different project or milestone from memory; confirm authoritative finalized chain IDs.
- **Verification or payment action is unavailable:** treat that as a safety gate. Confirm lifecycle, artifact digest, passing receipt, owner/verifier identity, and finalized chain status.
- **A transaction hash exists but state is pending:** do not click again. Use reconciliation and wait for finalized contract state.

## Stop conditions

Stop if the network is not Testnet, any contract/signer/receiver/method/project/milestone/digest/receipt/recipient/budget differs from the displayed evidence, a receipt is rejected or stale, the UI reports `PaymentPending` or unknown state, or a wallet prompt requests an unexpected amount or method.

## Presenter statement

“ATTESTRA coordinates bounded Research, Builder, and QA execution, preserves artifact and QA evidence, verifies independently, and gates NEAR payment on authorized receipt and finalized contract state. This is a controlled Testnet MVP; production-scale multi-instance recovery and the local Phase 2B-2B migration are not being presented as deployed features.”
