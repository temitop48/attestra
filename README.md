# ATTESTRA

ATTESTRA is a NEAR Testnet MVP for observable, proof-gated project execution. A user submits a brief, the API coordinates Research, Builder, and QA agents, the final artifact is independently verified, and escrow state is read from the NEAR contract before payment actions are enabled.

## Current MVP

- Next.js workspace for project submission, execution monitoring, artifacts, QA evidence, verification, and payment-state inspection.
- Fastify API with NEP-413 wallet authentication and owner/verifier authorization boundaries.
- Bounded Research → Builder → QA orchestration with deterministic validation, artifact digests, rework, and persisted execution history.
- Independent deterministic verification with immutable receipts and explicit re-verification rules.
- NEAR Testnet escrow integration for finalized project/milestone linkage, funding evidence, verification, owner approval, settlement, callback reconciliation, and `Paid` state display.
- Backend verifier submission is server-controlled; owner approval and settlement remain owner-wallet actions.

The public deployment is a controlled hackathon MVP, not a self-service production platform. The current deployed baseline is commit `30211b07d78095b6e6d9319bac0c39b2162dfb13`.

## Production

- Frontend: <https://attestra-woad.vercel.app>
- Backend: <https://attestra-api-o3ol.onrender.com>
- Backend health: <https://attestra-api-o3ol.onrender.com/health>

The backend is configured for NEAR Testnet and the escrow contract `escrow.attestra-owner.testnet`. Never place wallet keys, verifier credentials, provider keys, or privileged tokens in the frontend or repository.

## Architecture

- `apps/web` — Next.js workspace and payment/evidence panels.
- `apps/api` — Fastify API, authentication, orchestration boundary, verification, chain reads/intents, and reconciliation.
- `packages/agents` — provider interfaces and Research, Builder, and QA workers.
- `packages/orchestrator` — bounded lifecycle, agent sequencing, rework, artifact manifests, and QA/validation evidence.
- `packages/verification` — deterministic independent verification and receipt types.
- `packages/near-readonly` — finalized NEAR Testnet reads and transaction reconciliation.
- `contracts/escrow` — NEAR Rust escrow contract; agents never receive wallet keys.

Execution persistence uses PostgreSQL in production. The local JSON store remains available for development and deterministic tests. Phase 2B-2B PostgreSQL revision hardening is currently local and uncommitted; its migration has not been applied to production.

## Local setup

Requirements: Node.js 24, pnpm 10, and Rust for contract work.

```bash
pnpm install
pnpm dev
```

The web app runs on `http://localhost:3000`; the API runs on `http://localhost:4000`.

For a deterministic local rehearsal, explicitly enable demo mode:

```bash
ATTESTRA_DEMO_MODE=true pnpm --filter @attestra/api dev
pnpm --filter @attestra/web dev
```

Demo mode is suitable for UI and workflow rehearsal only. It is not evidence of real provider quality. A real provider-backed run requires `ATTESTRA_LLM_API_KEY`, compatible provider configuration, a persistent API data directory, and appropriate rate-limit/spend approval.

For local NEAR wallet work, use Testnet only and configure the values described in `docs/near-testnet-deployment.md`. Do not use production credentials.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo test --manifest-path contracts/escrow/Cargo.toml
git diff --check
```

The API integration suites require the explicitly isolated local PostgreSQL database described in their test instructions. They must never fall back to `DATABASE_URL` or a production Supabase instance.

## Demonstration evidence

The repository includes historical, read-only evidence under `docs/`, including:

- finalized verification transaction `6H2TcnRLxs9sCjLMJV8M343SxQiwENHiS61dJZpTLDez`;
- receipt `attest-1794510501481-h8yi6rpx` for project `0`, milestone `0`;
- artifact digest `0e31704687a6e29ed74eee794369083d35d516827bf7894d33d74e92a299d5b6`;
- finalized public chain state showing project `0` / milestone `0` as `Paid`.

The exact settlement transaction hash and an authenticated production execution record are not currently preserved in the accessible repository evidence. Do not claim those details from inference. Use [docs/hackathon-demo-runbook.md](docs/hackathon-demo-runbook.md) for the controlled presentation path.

## Known limitations

- The public demo requires prepared Testnet wallet access; a generic judge wallet cannot operate an owner-bound existing milestone.
- Real AI execution depends on provider availability, credentials, quotas, and model compatibility.
- Payment actions are intentionally owner-controlled and must be confirmed from finalized chain state, not a transaction hash alone.
- Production is a controlled single-instance MVP; multi-instance recovery and broader job-queue behavior are not claimed.
- Phase 2B-2B execution revision/migration hardening is not deployed.
- The contract stores receipt identifiers and digests, not artifact files; artifacts remain off-chain.
