# ATTESTRA Backend API Architecture

Phase 3A connects the Fastify API to the existing agents, orchestrator, and independent verifier. The API is a single-process MVP and does not call NEAR or submit escrow attestations.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health response retained from Phase 1B |
| POST | `/api/v1/executions` | Validate and queue a project execution; returns `202` and an execution ID |
| GET | `/api/v1/executions` | List recent execution summaries with `offset` and `limit` |
| GET | `/api/v1/executions/:executionId` | Return the persisted execution record |
| GET | `/api/v1/executions/:executionId/events` | Return the bounded append-only execution timeline |
| GET | `/api/v1/executions/:executionId/artifacts` | Return final artifact metadata and contents when ready |
| POST | `/api/v1/executions/:executionId/verify` | Verify the server-stored final deliverable |
| GET | `/api/v1/executions/:executionId/verification` | Return the latest persisted verification receipt |

Execution creation accepts the existing `ProjectExecutionRequest` fields: `requirements`, optional `projectId`, `targetAudience`, `constraints`, and bounded execution controls. The verification endpoint accepts criteria and optional policy settings, plus an optional decimal milestone ID. It never accepts replacement artifacts or a client-provided decision.

## Persistence

The repository did not contain SQLite support, so Phase 3A uses a bounded local JSON store at `DATABASE_URL` (default `.data/executions.json`). Records are written using a temporary file and atomic rename with file mode `0600`. The store persists requirements, statuses, agent assignments and steps, timeline events, all builder revisions, final artifacts, digests, failures, QA data, and verification receipts.

The store is limited to 1,000 records and artifact responses are limited to 300 KB. It persists one deterministic HTML/CSS validation report and one complete QA assessment per Builder revision, each tied to the exact artifact digest. QA data includes the decision, findings, missing requirements, recommendations, revision, and digest; validation data includes rule outcomes, evidence, severity, blocking status, revision, timestamp, and digest. If a process restarts while a record is queued or running, the next API instance marks it `Failed` with `PROCESS_RESTART_INTERRUPTED` and `retryable: true`. It never converts an interrupted execution into success. Older version-1 records without `qaAssessments` or `validationReports` are normalized to empty lists when loaded. There is no distributed lock or queue; concurrency protection is process-local.

## Agent lifecycle

`POST /executions` persists a queued record before starting work and returns immediately. A background task resolves the provider, constructs the existing `ResearchAgent`, `BuilderAgent`, `QaAgent`, and `Orchestrator`, then persists the completed or failed result. Demo mode uses the deterministic provider only when explicitly enabled. Without `ATTESTRA_LLM_API_KEY` and without demo mode, the execution fails explicitly with `PROVIDER_CONFIG`; it is not silently converted to a mock run.

The API does not duplicate agent or orchestration logic. It stores the orchestrator's bounded event history and revisions after execution completes. During a long-running request, the persisted lifecycle is `running` and the execution status remains the orchestrator's initial `Created` status until the orchestrator returns; this is a known single-process integration limitation.

## Verification integration

Verification reads `finalDeliverable` from the store, recalculates the digest through the existing `VerificationEngine`, and persists the resulting receipt. Repeated verification requests return the existing receipt rather than generating another one. The verifier's deterministic checks remain authoritative, and optional LLM review uses the existing provider abstraction. No NEAR transaction or settlement is performed.

For local pre-chain use, the endpoint maps decimal stored `projectId` and request `milestoneId` values into the verifier receipt. Non-decimal or omitted IDs use `0`; future escrow integration must provide real contract-generated IDs and should make these fields mandatory. The receipt remains an off-chain attestation, not cryptographic proof of correctness.

## Security controls

- Fastify request bodies are limited to 40 KB.
- Artifact output is capped at 300 KB.
- Pagination is bounded to 50 records.
- A basic process-local rate limit allows 60 requests per source IP per minute.
- CORS allows only `FRONTEND_ORIGIN` (default `http://localhost:3000`).
- Error responses contain bounded codes and messages and never include credentials.
- The API does not expose provider API keys or private keys.
- Generated JavaScript is never executed and no unrestricted filesystem write is exposed.
- Database writes use parameter-free local serialization rather than interpolated queries.

## Configuration and local development

Copy `.env.example` to a local environment and configure `ATTESTRA_LLM_API_KEY`, model, base URL, timeout, `API_PORT`, `FRONTEND_ORIGIN`, and `DATABASE_URL` as needed. Set `ATTESTRA_DEMO_MODE=true` only for explicitly labeled deterministic demo runs. Run:

```text
pnpm install
pnpm --filter @attestra/api dev
```

The API listens on `API_PORT` (default 4000). `pnpm test` exercises deterministic mock workflows through Fastify injection.

## Limitations

This MVP has no distributed queue, authentication, durable job lease, database transactions, or multi-process coordination. A process can lose in-flight work between writes, and external LLM calls can fail or time out. No on-chain payment, verification submission, wallet, or Testnet integration is included in Phase 3A.
