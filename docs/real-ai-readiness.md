# Real AI Execution Readiness

Phase 3B prepares the existing Fastify API for a first real LLM-powered FocusFlow execution. No provider call is made by this preparation work.

## Provider compatibility

The current adapter is `OpenAICompatibleProvider` in `packages/agents/src/index.ts`. It sends:

- `POST {ATTESTRA_LLM_BASE_URL}/chat/completions`
- `Authorization: Bearer <ATTESTRA_LLM_API_KEY>`
- `Content-Type: application/json`
- JSON fields: `model`, `messages`, `temperature: 0`, `max_tokens`, and `response_format: { type: "json_object" }`

The default base URL is `https://api.openai.com/v1`, and the default model is `gpt-4o-mini`. The provider reads assistant content from `choices[0].message.content` and optional usage from `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens`.

Timeouts use `AbortController` and are bounded from 1 to 120 seconds. Retries are bounded from 0 to 3, with exponential backoff, and are used only for retryable provider failures: HTTP 5xx, HTTP 429, network failures, and abort/timeouts. Authentication and other 4xx errors are not retried. Provider errors are converted to structured `AgentError` values without exposing the API key.

This format is compatible with OpenAI Chat Completions and providers that accurately implement that interface. It is not automatically compatible with providers that require different paths, authentication schemes, response envelopes, content-part formats, or JSON-schema response parameters. Some OpenAI-compatible services do not support `response_format: { type: "json_object" }`; those services require a future adapter or explicit compatibility confirmation. The current adapter should not be pointed at an arbitrary endpoint without testing its response shape.

## Environment

Use `.env.example` as the template. Required real-execution settings are:

- `ATTESTRA_LLM_API_KEY`
- `ATTESTRA_LLM_MODEL`
- `ATTESTRA_LLM_BASE_URL`
- `ATTESTRA_LLM_TIMEOUT_MS`
- `ATTESTRA_LLM_MAX_RETRIES`
- `ATTESTRA_DEMO_MODE=false`
- `API_PORT`
- `BACKEND_URL`
- `FRONTEND_ORIGIN`
- `DATABASE_URL`

Create `.env.local` or `.env` locally; never paste credentials into source, logs, test output, or chat. `.gitignore` excludes `.env`, `.env.*` except `.env.example`, credential directories, and common key files. Existing credential files are not overwritten by this workflow.

## FocusFlow request

The safe smoke workflow uses this exact requirements string:

```text
Create a modern, responsive landing page for a productivity application called FocusFlow. Include a hero section, features, benefits, testimonials, pricing, and a call to action. Use a clean professional design with accessible HTML and responsive CSS.
```

It creates project ID `1`, polls for at most 90 attempts at two seconds each, retrieves server-stored artifacts, and submits criteria requiring hero, features, benefits, testimonials, pricing, FocusFlow, responsiveness, and a call to action. Generated JavaScript is never executed, artifact contents are only inspected, and no NEAR method is called.

## Commands

Start the API with the environment loaded and real provider credentials configured:

```text
pnpm --filter @attestra/api dev
```

In a second terminal run:

```text
node scripts/focusflow-real-ai-smoke.mjs
```

The script prints health, execution ID, bounded lifecycle status, agent-step summaries, artifact metadata, receipt ID/result/digest, and the final policy version. It never prints credentials. To run a deterministic local rehearsal without a provider call, set `ATTESTRA_DEMO_MODE=true`; that result must be labeled as demo/mock output and is not evidence of real AI quality.

## Verification boundary

The API verifies the final artifact manifest persisted by the orchestrator. It recalculates the shared `attestra-artifacts-v2` digest and runs the independent deterministic verifier. Client requests cannot replace stored artifacts or submit a verification decision. The receipt is an off-chain attestation and is not submitted to NEAR in Phase 3B.

## Readiness blockers

Before a real call, the operator must confirm the provider account, model availability, endpoint compatibility, billing/rate limits, and an approved spend budget. This phase does not make that approval, does not inspect credential values, and does not claim that a real execution has succeeded. The API remains a single-process MVP with local JSON persistence and no authentication.
