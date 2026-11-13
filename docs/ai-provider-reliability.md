# AI provider reliability assessment

Date: 2026-11-12

## Provider configuration

The effective local configuration was inspected without printing credentials:

- Adapter: `OpenAICompatibleProvider`.
- Provider endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`.
- Model: `gemini-3.1-flash-lite`.
- Request path: `POST /chat/completions`.
- Timeout: `120000` ms, bounded by the adapter to a maximum of 120 seconds.
- Configured retry count: `1`.
- API key: configured, value not displayed or exposed.
- Demo mode: false in the supplied environment template/configuration.

Research, Builder, and QA all receive the same provider instance from `apps/api/src/app.ts`; no agent-specific model override is configured. Each agent supplies a distinct system prompt and request payload, while the provider model is used unless a request explicitly overrides it. The three agents execute sequentially through the orchestrator, so a Research failure prevents Builder and QA from running.

## Existing execution and root cause

Execution `exec-1e395988-63cc-4466-98e4-5a80b3801515` remains unchanged:

- Status: `Failed`.
- Lifecycle: `completed`.
- Research: assigned and started, then failed.
- Builder/QA: not assigned and not started.
- Failure: `PROVIDER_HTTP`, `LLM provider returned HTTP 503`, retryable.
- No artifact, QA result, verification receipt, or payment authorization was produced.

The application made a direct OpenAI-compatible request to the configured Google endpoint. The persisted error proves that the application received an HTTP 503 from its provider request path. There is no application gateway implementation between the API and configured provider in this repository, but the 503 alone cannot distinguish the provider’s own service from an intermediary inside the provider/network path. No retained provider response headers or server access log establish a more specific upstream source.

One confirmed configuration defect was found: `.env.local` specified `ATTESTRA_LLM_MAX_RETRIES=1`, but `apps/api/src/app.ts` did not pass that value to `OpenAICompatibleProvider`. The adapter therefore used its default of two retries. This was corrected. The provider had already bounded retries and never restarted an execution, but the effective retry policy did not match the operator configuration.

## Provider health-check result

No live health or chat-completions request was made. The configured endpoint is Gemini-compatible, and the task explicitly prohibits invoking Gemini. The only available live evidence is the recorded HTTP 503 from the failed Research attempt. Therefore provider availability, model availability, quota, billing, and endpoint compatibility remain unverified.

## Changes made

### Bounded transient retry behavior

`packages/agents/src/index.ts` now:

- Retries only bounded retryable failures: HTTP 5xx, HTTP 429, network failures, timeouts, and aborts already normalized as retryable.
- Preserves the configured maximum retry count.
- Reads integer-second and HTTP-date `Retry-After` headers.
- Uses `Retry-After` when present.
- Otherwise uses capped exponential backoff with jitter.
- Stops after the configured retry budget and returns a structured `AgentError`.
- Never creates a new orchestration execution during provider retry.

`apps/api/src/app.ts` now passes `ATTESTRA_LLM_MAX_RETRIES` into the provider. API persistence continues to record a terminal provider failure as a failed execution; it does not convert failure to success or automatically restart it.

No historical execution, receipt, artifact, payment record, or blockchain state was modified.

## Regression coverage

Added/retained tests cover:

- Successful provider response and parsed content.
- Network/transient recovery after one retry.
- HTTP 503 followed by recovery.
- Repeated HTTP 503 retry exhaustion.
- Request timeout conversion and bounded retry count.
- Orchestrator/provider failure propagation without fabricated output.
- Existing execution persistence and terminal failure history.
- No duplicate execution IDs within the orchestrator.
- Existing API behavior that persists provider configuration failures.

## Validation

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm --filter @attestra/agents test` — 42/42 passed.
- `pnpm --filter @attestra/api test` — 29/29 passed.
- `pnpm --filter @attestra/web test` — 24/24 passed.
- `pnpm build` — passed, including the Next production build and API/package builds.

## Fresh-execution readiness

It is not yet safe to start a fresh real-AI execution based on this audit alone. The code now has bounded and correctly configured resilience, but the provider returned 503 and no live health check was allowed. Before the next execution, an authorized operator must independently confirm the configured provider account, model availability, quota/billing, endpoint compatibility, and an approved spend budget. That check must be one bounded request, with no repeated manual retries.

When those checks pass, starting one fresh execution is safe from a duplicate-execution perspective: the form disables submission while the request is in flight, the API persists exactly one generated execution ID before orchestration, and provider retries remain inside that execution. The failed execution above must remain historical and must not be restarted or reused as a successful payment execution.

## Remaining blockers

1. Upstream provider availability is unresolved; the last observed provider response was HTTP 503.
2. A live health check and model/quota confirmation are still required by an authorized operator, but were intentionally not performed here due to the no-Gemini restriction.
3. The existing failed execution has no artifact or QA evidence and is not payment eligible in practice because its chain linkage is unconfirmed.
4. No blockchain transaction, verification receipt, or payment action should be attempted from this failed execution.
