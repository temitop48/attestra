# AI provider connectivity diagnosis

Date: 2026-11-12

## Executive result

The configured provider host is reachable from WSL at the transport level, but the authorized provider health request previously timed out at the application request level. No generative request was made during this diagnosis, no execution was started, and no credentials were printed.

The original endpoint does not need an architectural adapter rewrite to support another OpenAI-compatible provider. Endpoint, model, API key, timeout, and retry count are already environment-configurable. A future alternative must be explicitly operator-approved and verified; the application does not automatically switch providers.

## Configuration

Values were inspected without displaying the API key:

- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`
- Model: `gemini-3.1-flash-lite`
- Configured timeout: `120000` ms
- Configured retries: `1`
- Adapter request path: `POST {base URL}/chat/completions`
- API key: configured, value withheld

No HTTP, HTTPS, or `NO_PROXY` environment variables were configured in the diagnostic shell.

## Connectivity diagnostics

### DNS

Node DNS resolution succeeded in approximately 368 ms. The host returned multiple IPv4 and IPv6 addresses, including IPv4 address `172.217.114.4` and additional Google-host addresses. The initial `getent ahosts` check produced no lines, but Node’s resolver succeeded; this indicates a resolver-tool difference rather than confirmed DNS failure.

### TLS

A bounded `openssl s_client` check completed successfully:

- TLS: 1.3
- Cipher: `TLS_AES_256_GCM_SHA384`
- Certificate verification: OK
- SNI: `generativelanguage.googleapis.com`

The certificate presented a Google shared-host CN, but verification succeeded. There is no evidence of a local TLS trust failure.

### HTTPS reachability

A bounded non-generative HTTPS GET to the configured base URL completed and returned:

- HTTP status: `404`
- Content length: `0`
- Google response headers were present.

An HTTP 404 from the base path is expected evidence that the host and HTTPS route are reachable; it is not a valid chat-completions health result.

## Distinguishing the timeout

The prior authorized provider check used the adapter’s chat-completions POST path with a 10-second health-check timeout and received `PROVIDER_TIMEOUT` without an HTTP response. The later DNS, TLS, and base-URL GET diagnostics succeeded. Therefore the timeout was not a basic DNS or TLS connection failure.

The remaining possibilities are bounded to the POST/application path: provider-side request handling or unavailability, a network/intermediary issue affecting the POST, model/account routing, or a request that did not receive a response within the configured timeout. Because no HTTP response was returned, this evidence cannot distinguish unsupported model, invalid credentials, quota, or billing restrictions. Those cases require a provider response and were not probed here.

No live generative request was made in this diagnosis, as required.

## Provider abstraction review

`ResearchAgent`, `BuilderAgent`, and `QaAgent` each receive the same `LlmProvider` instance through the existing orchestrator. The agents do not contain provider-specific code and were not rewritten.

`OpenAICompatibleProvider` already supports environment-only provider changes:

- `ATTESTRA_LLM_BASE_URL`
- `ATTESTRA_LLM_MODEL`
- `ATTESTRA_LLM_API_KEY`
- `ATTESTRA_LLM_TIMEOUT_MS`
- `ATTESTRA_LLM_MAX_RETRIES`

The API now passes the configured retry count into the adapter. Retry handling remains bounded, uses `Retry-After` when supplied, and applies capped backoff with jitter. Secrets remain server-side; the frontend receives none of these values.

No source change was required for alternative-provider support in this diagnosis. Do not enter an unverified model name or endpoint into the environment and do not enable automatic provider fallback.

## Mocked/tested behavior

The existing mocked provider suite covers:

- Successful provider responses.
- Network and connection timeout conversion.
- HTTP 503 recovery.
- Bounded retry exhaustion.
- Configurable OpenAI-compatible provider construction.
- Orchestrator failure propagation without fabricated output.
- Duplicate execution-ID protection.
- Persistence of failed execution history.

No live AI request was used for these checks.

## Recommended next action

Do not start another real browser execution yet. The next authorized operator action should be a single bounded provider application check after confirming provider account, billing/quota, and model availability in the provider console. If that check returns a concrete HTTP error, classify it from the response without retrying blindly. If it succeeds, use the existing environment variables to configure the explicitly approved endpoint/model and then run exactly one fresh execution.

The failed execution and all historical records remain unchanged. No blockchain operation is involved in this connectivity diagnosis.
