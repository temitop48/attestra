# ATTESTRA architecture

ATTESTRA separates user experience, project coordination, agent execution, verification, and financial settlement. The separation is intentional: agents never receive user private keys, and financial state is eventually enforced by a smart contract rather than by an agent or UI process.

## Components

### Web (`apps/web`)

The Next.js App Router client will collect structured project inputs, present generated milestone plans for user approval, show execution state, and surface verification/payment notifications. Phase 1B only proves that the application shell is running.

### API (`apps/api`)

The Fastify service will be the authenticated boundary for project CRUD, plan approval, task dispatch, verification submissions, notifications, and read models. It currently exposes only a health endpoint.

### Agent workers (`packages/agents`)

Workers will implement a provider-agnostic LLM interface and specialized capabilities: Research, Builder, and QA. Workers must execute genuine scoped tasks and return evidence, not synthetic success states. They do not hold wallets or sign transactions.

### Orchestrator (`packages/orchestrator`)

The orchestrator will turn an approved project plan into dependency-aware work, schedule eligible tasks, track attempts, and hand completed outputs to verification. Task dependencies must be enforced before dispatch.

### Verification (`packages/verification`)

Verification associates evidence and decisions with the correct project and milestone. Only an authorized verification result can make a milestone eligible for payment. Results must be auditable and immutable after settlement.

### Escrow contract (`contracts/escrow`)

The future NEAR contract will hold project budgets, enforce milestone state transitions, prevent duplicate payments, require authorized verification, and emit auditable events. SDK integration and payment behavior are explicitly deferred from Phase 1B.

## Trust boundaries

The browser and agents are untrusted with respect to funds. The API coordinates intent and evidence, while the NEAR contract is the final authority for budget accounting and authorized milestone release. Private keys remain in user-controlled wallet flows and are never passed to agents.
