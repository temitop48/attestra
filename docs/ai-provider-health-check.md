# AI provider health check

Date: 2026-11-12

## Scope

One minimal live provider request was authorized and performed. No ATTESTRA execution was started, no execution record was modified, and no blockchain or wallet operation occurred.

The request used the existing local provider configuration with retries explicitly set to zero for this health check. The API key value was never printed.

## Configuration inspected

- Adapter: `OpenAICompatibleProvider`.
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`.
- Model: `gemini-3.1-flash-lite`.
- API key: configured; value withheld.
- Health-check timeout: 10 seconds.
- Automatic retries: disabled for this check.
- Prompt: short single-turn request asking for `OK`.
- Maximum output tokens: 8.

## Live result

- Request count: exactly one.
- Latency: approximately 10,011 ms.
- Result: failed.
- Error code: `PROVIDER_TIMEOUT`.
- Error message: `LLM provider request timed out`.
- HTTP status: none received.
- Provider response status: unavailable.
- Response model: unavailable.

Because no HTTP response was received, this check cannot confirm whether the endpoint accepts `gemini-3.1-flash-lite`. It also cannot classify the failure as invalid credentials, insufficient quota, billing restriction, or unsupported model. Those conditions normally require an HTTP response from the provider. The observed result is consistent with provider unavailability, network/connectivity failure, or an intermediary timeout, but does not distinguish among them.

## Readiness decision

The provider is **not ready for another real browser execution based on this check**. The last live request timed out, and no further retries were performed as required.

Do not start a fresh ATTESTRA execution until an authorized operator separately confirms provider reachability and account/model availability. That confirmation should be performed outside the execution workflow and should remain bounded; it must not trigger automatic execution creation or repeated retries.

No provider, model, endpoint, credential, execution, receipt, or blockchain state was changed.
