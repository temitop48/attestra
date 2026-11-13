# ATTESTRA Phase 2A agent architecture

Status: foundational implementation complete; review required before Phase 2B.

## Scope and boundaries

Phase 2A adds the execution foundation in `@attestra/agents`. It does not deploy to NEAR, create wallets, modify the escrow contract, implement payment orchestration, or act as the independent verifier.

The API, frontend, orchestrator, verification package, and Rust contract remain separate boundaries. Agents return typed data and do not receive filesystem, wallet, or secret access.

## Agent responsibilities

| Agent | Identity | Responsibility |
| --- | --- | --- |
| Research | `research-agent-v1` | Convert project requirements into sections, design requirements, implementation requirements, ambiguities, and risks. |
| Builder | `builder-agent-v1` | Convert a validated research specification into a static landing-page artifact manifest containing HTML, CSS, and optional browser JavaScript. |
| QA | `qa-agent-v1` | Compare the validated deliverable with the research specification and return findings and revision recommendations. It is internal QA, not the final independent verifier. |

Each execution has a unique execution ID, status, start/completion timestamps, duration, provider/model metadata, optional token usage, and structured error information.

## Execution flow

```text
typed input
  -> input validation
  -> agent-specific system prompt
  -> provider request
  -> bounded response parsing
  -> output schema validation
  -> execution metadata and typed result
```

`AgentRunner` exposes typed entry points for the three agents. The shared execution function enforces a 120-second agent limit and converts provider or validation failures into an explicit failed execution. Failed executions never return accepted output.

## LLM provider configuration

`OpenAICompatibleProvider` uses the standard `fetch` API and the chat-completions-compatible endpoint:

- `ATTESTRA_LLM_API_KEY` — required at runtime; never committed.
- `ATTESTRA_LLM_BASE_URL` — optional, defaults to `https://api.openai.com/v1`.
- `ATTESTRA_LLM_MODEL` — optional, defaults to `gpt-4o-mini`.
- `ATTESTRA_LLM_TIMEOUT_MS` — optional, bounded to 1–120 seconds.
- `ATTESTRA_LLM_MAX_RETRIES` — optional, bounded to 0–3 retries.

The provider requests JSON responses, handles non-success HTTP responses, converts aborts to timeout errors, retries only bounded retryable failures, and records usage fields when returned by the provider. No API key is present in source or test fixtures.

`DeterministicMockProvider` is intentionally test-only infrastructure. It returns supplied fixtures or controlled errors; it is not presented as real AI execution.

## Input and output schemas

Research input contains requirements plus optional project ID, audience, and constraints. Its output is a `ResearchSpec` with:

- summary;
- required landing-page sections;
- design requirements;
- implementation requirements;
- ambiguities;
- risks.

Builder input is a validated `ResearchSpec`. Its output is a `BuilderOutput` containing a summary and an artifact manifest. Each artifact includes a relative path, content, and one of `text/html`, `text/css`, or `text/javascript`.

QA input contains the research specification and a validated builder output. Its output includes pass/fail, severity-rated findings, missing requirements, and recommendations.

The three system prompts now state their complete top-level JSON schemas, field types, required arrays, bounded artifact rules, and no-wrapper/no-markdown response requirements. Prompt guidance improves adherence but does not replace strict parser validation. When parseable JSON fails an agent schema, the failed execution includes bounded diagnostics containing the agent kind, provider/model metadata, top-level property names, and required-field presence/types. Raw prompts, responses, artifacts, and credentials are excluded; finish reasons are not included because they are not exposed by the current `LlmResponse` interface.

## Artifact security boundary

The Builder Agent only returns strings. It does not write files, execute generated code, spawn processes, access environment variables, or control a wallet. The host application must treat artifacts as untrusted text.

Validation enforces:

- no absolute paths, backslashes, empty path components, `.` components, or `..` traversal;
- unique paths;
- matching file extensions and media types;
- `index.html` and `styles.css` as minimum landing-page files;
- no more than 10 artifacts;
- a 100 KB per-file limit;
- a 250 KB total artifact limit;
- a 500 KB provider response limit.

No execution sandbox is claimed by this package because generated code is never executed here. Any preview or publication service must add an isolated sandbox, CSP, network policy, and separate filesystem workspace before consuming artifacts.

## Testing strategy

Deterministic tests cover input rejection, output schema rejection, successful Research/Builder/QA execution, artifact traversal and size rejection, provider failures, provider timeout conversion, bounded retries, execution status, metadata, and runner dispatch. Mock promise-free provider tests do not prove live model quality or network availability.

The QA agent is not an independent verifier. A later verification phase must define evidence, authorized identity, digest handling, and an independent verification boundary before any escrow settlement integration.

## Remaining limitations

- Model quality, prompt injection, hallucination, and malicious generated content require additional evaluation and sandboxing.
- The OpenAI-compatible adapter assumes the configured endpoint honors the requested chat-completions JSON format.
- Provider token usage is optional and depends on provider response fields.
- No durable execution queue, cancellation, persistence, rate limiting, or distributed locking exists yet.
- The API does not expose these agents yet; integration belongs to a later orchestration phase.
- No wallet or NEAR connection is required or used in Phase 2A.
