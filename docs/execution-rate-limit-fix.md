# Execution rate-limit investigation and fix

Date: 2026-11-12

## Finding

The reported browser message was a monitoring/API-rate-limit symptom, not evidence that a second execution was created or that the execution was still running.

The existing record for `exec-1e395988-63cc-4466-98e4-5a80b3801515` was inspected directly from `apps/api/.data/executions.json`:

- Created: `2026-11-12T16:04:34.205Z`.
- Terminal update: `2026-11-12T16:05:18.847Z`.
- Status: `Failed`.
- Lifecycle: `completed`.
- Agent work: Research was assigned and started; Builder and QA were never assigned or started.
- Failure: `PROVIDER_HTTP`, `LLM provider returned HTTP 503`, retryable, at the Research stage.
- Provider agent execution: `40da3cdf-6bc8-474e-8b31-6272eef0d431`.
- Revisions, QA assessments, and validation reports: none.
- Payment eligibility: still recorded as true, but chain linkage remains `unlinked`; no payment authorization is possible.

The execution ID and record were not changed. No new execution was started. No verification receipt or blockchain transaction was created.

## Root cause of the browser error

The API had one global per-IP bucket of 60 requests per minute for every endpoint. The live monitor polls `GET /api/v1/executions/:executionId` every two seconds, which is approximately 30 requests per minute by itself. Health checks, execution-history reads, wallet/session reads, and other panels shared the same bucket. Once the combined traffic exceeded 60 requests in the minute, Fastify returned HTTP 429 with `RATE_LIMITED` and the message `Too many requests`.

The frontend treated that 429 as a terminal load error. It did not read `Retry-After`, perform bounded backoff, or distinguish a temporary status-read limit from a missing execution. The poll loop itself was sequential, so there was no evidence of overlapping requests from `pollExecution`; the main issue was the shared global bucket and missing 429 handling.

No retained API access log files were present in the repository, so the exact historical 429 request cannot be reconstructed from server logs. The source path responsible is the global `onRequest` rate-limit hook, and the monitor’s status endpoint is `GET /api/v1/executions/:executionId`. The persisted execution record independently proves that the eventual execution failure was an upstream provider HTTP 503, not a Fastify rate-limit failure.

## Source changes

### API rate limiting

`apps/api/src/app.ts` now classifies requests into separate buckets:

- Read-only execution/status reads: 180 requests per minute per IP, including execution status, events, chain state, verification, artifacts, and execution history reads.
- Authentication endpoints: 20 requests per minute per IP.
- Other/general requests: the existing 60 requests per minute per IP.

The protection remains enabled. A 429 now includes a `Retry-After` header with the remaining wait in seconds. No global limit was disabled and no payment or authentication route was made unauthenticated.

### Frontend polling

`apps/web/src/lib/api.ts` now:

- Preserves `Retry-After` in `ApiError.retryAfterMs`.
- Parses both integer-second and HTTP-date forms.
- Retries a bounded number of rate-limited status polls.
- Uses the server delay when supplied, otherwise bounded exponential backoff with jitter.
- Continues to use one sequential request at a time.
- Stops immediately when the execution lifecycle is terminal.

The existing form already disables the Start button during submission, so a failed status read cannot create a duplicate execution. No automatic execution retry was added.

## Regression tests added

- API status reads use a separate bounded bucket and emit `Retry-After` on 429.
- Frontend status polling honors a four-second `Retry-After` value.
- Polling remains non-overlapping and stops after the first terminal execution state.
- Existing API authentication tests continue to cover invalid signatures, replayed challenges, session creation, and authenticated session reads.
- Existing frontend tests continue to cover explicit execution creation and status polling behavior.

## Validation

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm --filter @attestra/api test` — 29/29 passed.
- `pnpm --filter @attestra/web test` — 24/24 passed.
- `pnpm build` — passed, including Next production build and API/package builds.

## Browser retesting instructions

1. Restart the API and web development processes so both the rate-limit response and polling bundle are current.
2. Open `http://localhost:3000/workspace` and hard-refresh once.
3. Do not click Start Autonomous Execution for the recovered failed execution. It is preserved as a historical failed record.
4. In Recent executions, select `exec-1e395988-63cc-4466-98e4-5a80b3801515` if it is listed. The monitor should show the terminal Research/provider failure rather than Waiting or an endless polling state.
5. Confirm the browser Network panel shows status reads to `GET /api/v1/executions/<id>` no more frequently than the configured polling interval and no overlapping request storm.
6. For a future authorized test run, start exactly one execution only after confirming the form button returns to its normal state. If a status read receives 429, the monitor should wait/retry rather than immediately display `Could not load execution`.
7. If the provider returns HTTP 503 again, the monitor should eventually show the persisted `PROVIDER_HTTP` execution failure. Do not click Start again as an automatic recovery; inspect the provider configuration/availability separately.
8. Do not attach, verify, approve, settle, or otherwise authorize payment for this failed unlinked execution. No blockchain action is required for this rate-limit retest.

## Remaining blockers

The provider availability problem remains for the recovered execution: its Research attempt failed with HTTP 503 and cannot be converted into a successful execution by polling changes. A legitimate future execution will require a healthy configured LLM provider. The rate-limit monitoring defect is fixed without changing execution history, payment gates, wallet authorization, or blockchain state.
