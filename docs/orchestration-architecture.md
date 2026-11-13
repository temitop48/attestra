# ATTESTRA Phase 2B orchestration architecture

Status: implemented; review required before Phase 2C.

## Scope

Phase 2B coordinates the existing Phase 2A Research, Builder, and QA agents into one bounded landing-page execution. It does not modify the Rust escrow contract, call NEAR, expose backend HTTP endpoints, perform independent verification, or settle payments.

## Execution architecture

`Orchestrator` receives a validated `ProjectExecutionRequest` and uses the existing `AgentRunner` to invoke the existing agent classes:

```text
Created
  -> Planning -> Research Agent
  -> Building -> Builder Agent
  -> QualityReview -> QA Agent
       | pass
       v
  AwaitingIndependentVerification
       |
       | fail, attempts remain
       v
     Rework -> Builder Agent -> QualityReview
       |
       | attempts exhausted or agent failure
       v
     Failed
```

The execution record stores the project ID, requirements, status, agent assignments, steps, append-only timeline events, research specification, every deliverable revision, rework requests, final deliverable reference, and structured failure information.

## State machine

Valid transitions are:

| Current | Allowed next states |
| --- | --- |
| `Created` | `Planning`, `Failed` |
| `Planning` | `Building`, `Failed` |
| `Building` | `QualityReview`, `Failed` |
| `QualityReview` | `Rework`, `AwaitingIndependentVerification`, `Failed` |
| `Rework` | `Building`, `Failed` |
| `AwaitingIndependentVerification` | none |
| `Failed` | none |

Invalid transitions throw `OrchestrationError`. Terminal states cannot be completed twice. A successful execution stops at `AwaitingIndependentVerification`; it is not verified, approved, or paid.

## Agent coordination and rework

Research runs once and its validated `ResearchSpec` is preserved for every Builder and QA attempt. The Builder receives optional structured rework context containing the next attempt number, QA findings, and recommendations. Each Builder output is validated by the Phase 2A Builder schema before QA runs. Before QA, the reusable deterministic HTML/CSS validator checks the exact Builder artifacts against ResearchSpec sections and implementation requirements. Its versioned report records pass, fail, or unknown outcomes, evidence, paths, severity, and whether a failure is blocking. QA receives that report alongside the original research specification and validated Builder output. Confirmed blocking deterministic failures are enforced by orchestration even if the model returns `passed: true`; unknown checks and non-blocking recommendations do not force rejection.

Each assessment and validation report is retained with its evaluated revision and digest. If QA fails, a `ReworkRequest` is appended and the next Builder attempt receives the previous artifacts and digest, the complete latest QA assessment, cumulative missing requirements, and the required-section preservation checklist. The default maximum is three Builder attempts; configured values are bounded to 1–3. Exhaustion produces `Failed` while preserving all revisions, validation reports, and QA assessments.

QA remains internal quality assurance. It is not the independent verifier and cannot authorize escrow settlement.

## Artifact canonicalization and digest

Each Builder revision produces a `DeliverableManifest` with a revision number, artifacts, total bytes, canonical format identifier, and SHA-256 digest.

The canonical format is `attestra-artifacts-v2`: a UTF-8 JSON object with fixed property order `{format, artifacts}`. Artifacts are sorted by path using deterministic code-point ordering, and each artifact has fixed property order `{path, mediaType, content}`. JSON escaping makes newlines, quotes, and other delimiters unambiguous. The representation excludes timestamps, execution IDs, provider metadata, and random values. The digest is SHA-256 over the canonical UTF-8 bytes. Reordering artifacts does not change the digest; changing path, media type, or content does. The final digest is recalculated from the exact final artifacts and retained for later independent verification and NEAR receipt binding.

## Execution events

The timeline records:

- `execution_created`
- `status_changed`
- `agent_assigned`
- `agent_started`
- `agent_completed`
- `agent_failed`
- `qa_failed`
- `rework_requested`
- `qa_passed`
- `deliverable_ready`
- `execution_failed`

Events include sequence, event ID, execution ID, timestamp, status, agent/attempt context where relevant, step ID, digest where relevant, and bounded metadata. Provider credentials, raw authorization headers, and raw provider payloads are not recorded.

## Execution controls and failure handling

- Every execution receives a unique ID. The orchestrator maintains a process-local set of claimed IDs to prevent overlapping or duplicate runs within one process.
- Overall execution duration is configurable and bounded to ten minutes.
- Agent calls retain the Phase 2A provider and agent execution limits.
- Builder attempts are bounded to three.
- Timeline history is bounded to 32–500 events. Once full, existing append-only events are preserved and later events are omitted; execution state remains authoritative.
- Agent/provider failures propagate into `ExecutionFailure` with stage, code, retryability, attempt, and agent execution ID where available.
- There is no distributed queue, durable lock, cancellation mechanism, or cross-process duplicate protection.

## Security boundaries

The orchestrator never receives wallet credentials or calls a blockchain. Builder artifacts remain untrusted text and are not written to disk or executed. Existing Phase 2A path, media-type, and size validation remains the artifact acceptance boundary. A future preview/publication service must use an isolated filesystem and execution sandbox with an appropriate CSP and network policy.

The final independent verifier, evidence persistence, digest receipt binding, and settlement authorization are intentionally deferred.

## Testing strategy

Deterministic mock providers cover successful execution, each agent failure stage, QA failure, successful rework, rework exhaustion, attempt limits, invalid transitions, duplicate execution IDs, canonical digest stability, revision digest changes, final digest integrity, timeout propagation, event ordering, assignment metadata, bounded history, and the absence of blockchain settlement events.

## Remaining limitations

- Real model quality and prompt-injection resistance are not established by deterministic tests.
- Process-local duplicate protection does not protect multiple worker processes.
- Deadline races cannot cancel an already-running provider request; provider-level timeout remains the underlying cancellation boundary.
- A full history buffer can omit later timeline events by design.
- No independent verification or payment integration exists in this phase.
