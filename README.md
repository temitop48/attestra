# ATTESTRA

ATTESTRA is an autonomous multi-agent project execution system for NEAR. Users define projects, budgets, deadlines, tasks, and deliverables; specialized agents execute genuine work; and milestone payments are released only after authorized verification provides proof.

## Architecture

- `apps/web` — Next.js App Router frontend. Phase 1B contains only a running-state page.
- `apps/api` — Fastify backend with the initial `/health` endpoint.
- `packages/agents` — provider-agnostic agent types and planned Research, Builder, and QA roles.
- `packages/orchestrator` — future task dependency and execution planning boundary.
- `packages/verification` — future deliverable verification result types.
- `packages/shared` — shared contracts used across TypeScript applications and packages.
- `contracts/escrow` — minimal Rust library crate reserved for the future NEAR escrow contract.

## Technology stack

Next.js, React, TypeScript, Tailwind CSS, Fastify, pnpm workspaces, Vitest, Rust, and NEAR Testnet.

## Local development

Requirements: Node.js 24, pnpm 10, and Rust 1.99.

```bash
pnpm install
pnpm dev
```

The web app runs at `http://localhost:3000`; the API runs at `http://localhost:4000`. Check API readiness with `GET /health`. Copy `.env.example` to `.env` only when local configuration is needed. Never add credentials or private keys to the repository.

Validation commands:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo test --manifest-path contracts/escrow/Cargo.toml
```

## Current implementation status

Phase 1B establishes the monorepo, strict TypeScript boundaries, a minimal frontend, a Fastify health check, basic tests, and a compilable Rust contract boundary. AI orchestration, task execution, verification workflows, wallet interactions, and escrow/payment functionality are intentionally not implemented.

## Planned development phases

1. Phase 1B — monorepo foundation (current).
2. Phase 1C — product domain model and project creation flow.
3. Agent execution — real provider-backed Research, Builder, and QA workers.
4. Verification — deliverable evidence, authorized verification, and audit trail.
5. NEAR payments — testnet escrow, milestone release, dependency enforcement, and duplicate-payment protection.
6. Integration hardening — notifications, observability, security review, and hackathon demo readiness.
