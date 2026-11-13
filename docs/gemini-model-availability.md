# Gemini model availability and compatibility

**Date:** 2026-11-12  
**Scope:** Read-only Gemini model discovery and adapter review. No generation request, ATTESTRA execution, wallet action, or blockchain transaction was performed.

## Executive result

The configured Gemini credential can access the official model-listing endpoint. The request returned HTTP 200 in approximately 1.84 seconds and returned 50 model records. No quota, permission, or authentication error was returned.

The configured model, `gemini-3.1-flash-lite`, is present as `models/gemini-3.1-flash-lite` and advertises `generateContent`. Its identifier is therefore valid for the discovered Gemini API surface. The prior 503 and timeout cannot be attributed to an invalid model name based on this evidence.

This check does **not** prove that a chat-completions generation request will succeed or that the account has generation quota. Generation was deliberately not attempted under this task.

## Model-listing result

The single authorized request was:

```text
GET https://generativelanguage.googleapis.com/v1beta/models
Header: x-goog-api-key: [redacted]
Timeout: 10 seconds
HTTP status: 200
Latency: approximately 1,838 ms
Records: 50
Error: none
Credential configured: yes
```

The response included the following relevant text-generation model IDs with `generateContent` in their supported generation methods:

- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-2.5-pro`
- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite`
- `gemini-3.1-flash-lite-preview`
- `gemini-3.1-pro-preview`
- `gemini-3.1-pro-preview-customtools`
- `gemini-3.5-flash`
- `gemini-3.5-flash-lite`
- `gemini-3.6-flash`
- `gemini-3.7-flash`
- `gemini-3.8-flash`
- `gemini-flash-latest`
- `gemini-flash-lite-latest`
- `gemini-pro-latest`

The listing also contained other model families and modalities. Those are not recommended for the current Research, Builder, and QA text workflow merely because they appeared in the listing.

The model-listing API requires using a model name returned by the listing and exposes each model's supported methods. See Google's [Gemini API models documentation](https://ai.google.dev/api/models) and [Gemini model guide](https://ai.google.dev/gemini-api/docs/models).

## Adapter compatibility review

The existing application uses one configurable `OpenAICompatibleProvider` for Research, Builder, and QA. There is no agent-specific provider or model override. The API reads:

- `ATTESTRA_LLM_API_KEY`
- `ATTESTRA_LLM_BASE_URL`
- `ATTESTRA_LLM_MODEL`
- `ATTESTRA_LLM_TIMEOUT_MS`
- `ATTESTRA_LLM_MAX_RETRIES`

With the current environment, the effective values are the Gemini OpenAI-compatible base URL, `gemini-3.1-flash-lite`, a 120-second timeout, and one bounded retry. The secret value is not recorded here.

The adapter currently:

1. Posts to `${baseUrl}/chat/completions`.
2. Sends `Authorization: Bearer [key]` and JSON content type.
3. Sends `model`, `messages`, `temperature`, `max_tokens`, and OpenAI-style JSON `response_format`.
4. Reads `choices[0].message.content`, `model`, and usage from the response.
5. Applies bounded retries for transient HTTP failures and honors `Retry-After` when provided.
6. Converts request timeouts into a provider timeout error without exposing credentials.

This is the correct high-level shape for Google's documented OpenAI-compatible endpoint, whose base URL is `https://generativelanguage.googleapis.com/v1beta/openai/` and whose chat path is `/chat/completions`. Google documents this compatibility layer separately from the native Gemini REST API; the native model-list request above used `x-goog-api-key`, while the compatibility adapter uses the bearer form documented for its OpenAI-compatible API. See [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).

The adapter's JSON-object response format is appropriate for ATTESTRA's structured agent outputs, but the model-listing call cannot validate generation-time support for every request parameter. In particular, the previous timeout occurred before an HTTP response was received, so it provides no evidence that Gemini rejected `max_tokens` or `response_format`. A single bounded generation smoke test is required before claiming end-to-end compatibility.

## Availability and recommendation

`gemini-3.1-flash-lite` is available to the key according to the listing and supports text generation. No configuration change is required to retain the current model.

The best low-cost, low-latency candidate visible in this listing for the three text agents is `gemini-3.5-flash-lite`. It supports `generateContent` and is the strongest candidate for a high-throughput workflow while retaining code-generation and structured-output suitability. This is a recommendation, not an automatic change; the current configured model remains unchanged until the candidate is tested.

If stability or output quality is more important than latency/cost, the available `gemini-2.5-flash` is a conservative fallback candidate. It must also be tested rather than assumed to be better.

## Root-cause assessment

The evidence supports these conclusions:

- **Invalid model identifier:** ruled out for the discovered API key; the exact model is listed and supports `generateContent`.
- **Invalid credentials or model-list permission:** not indicated; the official listing returned HTTP 200.
- **Quota exhaustion:** not established; model listing normally does not prove generation quota.
- **Unsupported request parameters:** not established; no generation response was received in the prior timeout.
- **Gemini service instability:** plausible because an earlier request reached a reachable endpoint but returned 503 in the application history; not proven by the model listing.
- **Application timeout/network path:** plausible for the later no-response timeout. DNS, TLS, and a non-generative HTTPS request previously succeeded, but the chat-completions path still needs one controlled generation test.

The responsible classification is therefore: **model validity and listing authorization confirmed; generation-path cause remains unconfirmed**.

## Required configuration changes

No source-code or environment change was made.

For a candidate test, change only the server-side environment value after approval:

```text
ATTESTRA_LLM_MODEL=gemini-3.5-flash-lite
```

Keep the Gemini OpenAI-compatible base URL and key server-side. Do not expose either in frontend code or browser responses. Restart the API after any environment change and record the exact selected model in the test evidence.

## Next minimal live generation test

After explicit authorization for a generation request:

1. Use the existing server-side Gemini key and the selected model, with no ATTESTRA execution creation.
2. Set retries to zero for this smoke test and use a bounded 10–15 second timeout.
3. Send one short prompt requesting a tiny JSON object, such as `{ "ok": true }`, through the existing adapter.
4. Record only HTTP status, latency, returned model, JSON parse status, and a redacted provider error if present.
5. If it fails, stop without switching providers or retrying repeatedly. Classify the response as credential, quota, unsupported model/parameter, service, or timeout/network failure.
6. Only after a successful smoke test should a human authorize a fresh browser execution.

No live generation was performed for this report, as required.

## Changes and validation

No application source changes were necessary. This report is the only new artifact from this investigation. Existing bounded retry, timeout, and provider-error handling remains in place.
