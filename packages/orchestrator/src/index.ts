import {
  AgentRunner,
  BuilderAgent,
  QaAgent,
  ResearchAgent,
  type AgentErrorInfo,
  type AgentExecution,
  type AgentKind,
  type Artifact,
  type BuilderInput,
  type BuilderOutput,
  type DeterministicValidationReport,
  validateHtmlCssDeliverable,
  type QaFinding,
  type QaOutput,
  type ResearchInput,
  type ResearchSpec,
} from "@attestra/agents";

export type MilestonePlan = { agent: AgentKind; title: string; dependsOn: string[] };

export function createEmptyPlan(): MilestonePlan[] {
  return [];
}

export type ProjectExecutionStatus =
  | "Created"
  | "Planning"
  | "Building"
  | "QualityReview"
  | "Rework"
  | "AwaitingIndependentVerification"
  | "Failed";

export type ExecutionStepKind = "research" | "builder" | "qa";
export type ExecutionStepStatus = "pending" | "running" | "succeeded" | "failed";

export type ProjectExecutionRequest = ResearchInput & {
  executionId?: string;
  paymentEligible?: boolean;
  maxBuilderAttempts?: number;
  maxExecutionDurationMs?: number;
  maxHistoryEvents?: number;
};

export type AgentAssignment = {
  assignmentId: string;
  agentKind: ExecutionStepKind;
  agentId: string;
  attempt: number;
  assignedAt: string;
  agentExecutionId?: string;
};

export type ExecutionStep = {
  stepId: string;
  kind: ExecutionStepKind;
  attempt: number;
  status: ExecutionStepStatus;
  startedAt?: string;
  completedAt?: string;
  agentExecutionId?: string;
  digest?: string;
  error?: ExecutionFailure;
};

export type ExecutionTimelineEventType =
  | "execution_created"
  | "status_changed"
  | "agent_assigned"
  | "agent_started"
  | "agent_completed"
  | "agent_failed"
  | "qa_failed"
  | "rework_requested"
  | "qa_passed"
  | "deliverable_ready"
  | "execution_failed";

export type ExecutionTimelineEvent = {
  sequence: number;
  eventId: string;
  type: ExecutionTimelineEventType;
  executionId: string;
  occurredAt: string;
  status: ProjectExecutionStatus;
  agentKind?: ExecutionStepKind;
  attempt?: number;
  stepId?: string;
  digest?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type DeliverableManifest = {
  revision: number;
  digest: string;
  canonicalFormat: "attestra-artifacts-v2";
  artifacts: Artifact[];
  totalBytes: number;
};

export type ReworkRequest = {
  revision: number;
  attempt: number;
  rejectedRevision: number;
  nextBuilderAttempt?: number;
  terminal: boolean;
  findings: QaFinding[];
  recommendations: string[];
  missingRequirements: string[];
  previousDigest?: string;
  requiredSections?: string[];
  requestedAt: string;
};

export type QaAssessment = QaOutput & {
  revision: number;
  evaluatedAt: string;
  digest: string;
};

export type DeterministicValidationAssessment = DeterministicValidationReport & {
  executionId: string;
  revision: number;
  artifactDigest: string;
  validatedAt: string;
};

export type ExecutionFailure = {
  code: string;
  message: string;
  stage: ExecutionStepKind | "orchestration";
  attempt?: number;
  retryable: boolean;
  agentExecutionId?: string;
};

export type ProjectExecution = {
  executionId: string;
  projectId?: string;
  requirements: string;
  targetAudience?: string;
  constraints: string[];
  status: ProjectExecutionStatus;
  createdAt: string;
  updatedAt: string;
  assignedAgents: AgentAssignment[];
  steps: ExecutionStep[];
  history: ExecutionTimelineEvent[];
  research?: ResearchSpec;
  revisions: DeliverableManifest[];
  reworkRequests: ReworkRequest[];
  qaAssessments: QaAssessment[];
  validationReports: DeterministicValidationAssessment[];
  finalDeliverable?: DeliverableManifest;
  failure?: ExecutionFailure;
  paymentEligible?: boolean;
};

export type OrchestratorOptions = {
  researchAgent: ResearchAgent;
  builderAgent: BuilderAgent;
  qaAgent: QaAgent;
  runner?: AgentRunner;
  maxBuilderAttempts?: number;
  maxExecutionDurationMs?: number;
  maxHistoryEvents?: number;
  executionIdFactory?: () => string;
  clock?: () => Date;
};

export class OrchestrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

const MAX_BUILDER_ATTEMPTS = 3;
const MAX_EXECUTION_DURATION_MS = 10 * 60 * 1_000;
const MAX_HISTORY_EVENTS = 500;
const MIN_HISTORY_EVENTS = 32;
const terminalStatuses: readonly ProjectExecutionStatus[] = ["AwaitingIndependentVerification", "Failed"];
const validTransitions: Record<ProjectExecutionStatus, readonly ProjectExecutionStatus[]> = {
  Created: ["Planning", "Failed"],
  Planning: ["Building", "Failed"],
  Building: ["QualityReview", "Failed"],
  QualityReview: ["Rework", "AwaitingIndependentVerification", "Failed"],
  Rework: ["Building", "Failed"],
  AwaitingIndependentVerification: [],
  Failed: [],
};

export function canTransition(from: ProjectExecutionStatus, to: ProjectExecutionStatus): boolean {
  return validTransitions[from].includes(to);
}

export function assertValidTransition(from: ProjectExecutionStatus, to: ProjectExecutionStatus): void {
  if (!canTransition(from, to)) {
    throw new OrchestrationError("INVALID_STATE_TRANSITION", `Cannot transition execution from ${from} to ${to}`);
  }
}

export function validateProjectExecutionRequest(request: ProjectExecutionRequest): void {
  if (!request || typeof request !== "object") throw new OrchestrationError("INVALID_REQUEST", "Execution request must be an object");
  if (typeof request.requirements !== "string" || !request.requirements.trim() || request.requirements.length > 20_000) {
    throw new OrchestrationError("INVALID_REQUEST", "requirements must be non-empty and at most 20,000 characters");
  }
  if (request.projectId !== undefined && (!request.projectId.trim() || request.projectId.length > 128)) {
    throw new OrchestrationError("INVALID_REQUEST", "projectId must be a bounded non-empty string");
  }
  if (request.paymentEligible !== undefined && typeof request.paymentEligible !== "boolean") {
    throw new OrchestrationError("INVALID_REQUEST", "paymentEligible must be a boolean");
  }
  if (request.constraints !== undefined && (!Array.isArray(request.constraints) || request.constraints.length > 32 || request.constraints.some((item) => typeof item !== "string"))) {
    throw new OrchestrationError("INVALID_REQUEST", "constraints must contain at most 32 strings");
  }
  boundedOption(request.maxBuilderAttempts, 1, MAX_BUILDER_ATTEMPTS, "maxBuilderAttempts");
  boundedOption(request.maxExecutionDurationMs, 1_000, MAX_EXECUTION_DURATION_MS, "maxExecutionDurationMs");
  boundedOption(request.maxHistoryEvents, MIN_HISTORY_EVENTS, MAX_HISTORY_EVENTS, "maxHistoryEvents");
  if (request.executionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(request.executionId)) {
    throw new OrchestrationError("INVALID_REQUEST", "executionId contains invalid characters");
  }
}

export class Orchestrator {
  private readonly runner: AgentRunner;
  private readonly options: Required<Pick<OrchestratorOptions, "maxBuilderAttempts" | "maxExecutionDurationMs" | "maxHistoryEvents">>;
  private readonly executionIdFactory: () => string;
  private readonly clock: () => Date;
  private readonly claimedExecutionIds = new Set<string>();

  constructor(private readonly agents: OrchestratorOptions) {
    this.runner = agents.runner ?? new AgentRunner();
    this.options = {
      maxBuilderAttempts: boundedValue(agents.maxBuilderAttempts ?? MAX_BUILDER_ATTEMPTS, 1, MAX_BUILDER_ATTEMPTS, "maxBuilderAttempts"),
      maxExecutionDurationMs: boundedValue(agents.maxExecutionDurationMs ?? MAX_EXECUTION_DURATION_MS, 1_000, MAX_EXECUTION_DURATION_MS, "maxExecutionDurationMs"),
      maxHistoryEvents: boundedValue(agents.maxHistoryEvents ?? MAX_HISTORY_EVENTS, MIN_HISTORY_EVENTS, MAX_HISTORY_EVENTS, "maxHistoryEvents"),
    };
    this.executionIdFactory = agents.executionIdFactory ?? createExecutionId;
    this.clock = agents.clock ?? (() => new Date());
  }

  async execute(request: ProjectExecutionRequest): Promise<ProjectExecution> {
    validateProjectExecutionRequest(request);
    const executionId = request.executionId ?? this.executionIdFactory();
    if (this.claimedExecutionIds.has(executionId)) {
      throw new OrchestrationError("DUPLICATE_EXECUTION", `Execution ${executionId} is already known to this process`);
    }
    this.claimedExecutionIds.add(executionId);

    const maxAttempts = request.maxBuilderAttempts ?? this.options.maxBuilderAttempts;
    const maxDuration = request.maxExecutionDurationMs ?? this.options.maxExecutionDurationMs;
    const maxHistory = request.maxHistoryEvents ?? this.options.maxHistoryEvents;
    const createdAt = this.now();
    const execution: ProjectExecution = {
      executionId,
      projectId: request.projectId,
      requirements: request.requirements,
      targetAudience: request.targetAudience,
      constraints: [...(request.constraints ?? [])],
      paymentEligible: request.paymentEligible === true,
      status: "Created",
      createdAt,
      updatedAt: createdAt,
      assignedAgents: [],
      steps: [],
      history: [],
      revisions: [],
      reworkRequests: [],
      qaAssessments: [],
      validationReports: [],
    };
    this.emit(execution, "execution_created", maxHistory);

    const deadline = Date.now() + maxDuration;
    try {
      this.transition(execution, "Planning", maxHistory);
      const research = await this.runResearch(execution, request, deadline, maxHistory);
      if (!research) return this.fail(execution, this.latestFailure(execution, "research", 1, "RESEARCH_FAILED", "Research agent failed"), maxHistory);
      execution.research = research;
      this.transition(execution, "Building", maxHistory);

      let rework: BuilderInput["rework"];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) this.transition(execution, "Building", maxHistory);
        const deliverable = await this.runBuilder(execution, research, attempt, rework, deadline, maxHistory);
        if (!deliverable) return this.fail(execution, this.latestFailure(execution, "builder", attempt, "BUILDER_FAILED", "Builder agent failed"), maxHistory);

        const manifest = await createDeliverableManifest(attempt, deliverable.artifacts);
        execution.revisions.push(manifest);
        const validation = validateHtmlCssDeliverable({
          artifacts: deliverable.artifacts,
          requiredSections: research.sections,
          acceptanceRequirements: research.implementationRequirements,
          research,
        });
        execution.validationReports.push({
          ...validation,
          executionId,
          revision: attempt,
          artifactDigest: manifest.digest,
          validatedAt: this.now(),
        });
        const qaOutput = await this.runQa(execution, research, deliverable, validation, attempt, deadline, maxHistory);
        if (!qaOutput) return this.fail(execution, this.latestFailure(execution, "qa", attempt, "QA_FAILED_TO_EXECUTE", "QA agent failed"), maxHistory);
        const qa = applyDeterministicPolicy(qaOutput, validation);
        execution.qaAssessments.push({
          ...qa,
          revision: attempt,
          evaluatedAt: this.now(),
          digest: manifest.digest,
        });
        if (qa.passed) {
          this.emit(execution, "qa_passed", maxHistory, "qa", attempt, undefined, manifest.digest);
          this.transition(execution, "AwaitingIndependentVerification", maxHistory);
          execution.finalDeliverable = manifest;
          this.emit(execution, "deliverable_ready", maxHistory, "qa", attempt, undefined, manifest.digest);
          return this.touch(execution);
        }

        this.emit(execution, "qa_failed", maxHistory, "qa", attempt, undefined, manifest.digest, {
          findingCount: qa.findings.length,
          missingRequirementCount: qa.missingRequirements.length,
        });
        if (attempt >= maxAttempts) {
          return this.fail(execution, {
            code: "REWORK_EXHAUSTED",
            message: `QA failed after ${maxAttempts} builder attempt${maxAttempts === 1 ? "" : "s"}`,
            stage: "qa",
            attempt,
            retryable: false,
          }, maxHistory, qa);
        }
        const reworkRequest: ReworkRequest = {
          revision: attempt,
          attempt: attempt + 1,
          rejectedRevision: attempt,
          nextBuilderAttempt: attempt + 1,
          terminal: false,
          findings: qa.findings,
          recommendations: qa.recommendations,
          missingRequirements: qa.missingRequirements,
          previousDigest: manifest.digest,
          requiredSections: research.sections,
          requestedAt: this.now(),
        };
        execution.reworkRequests.push(reworkRequest);
        const unresolvedRequirements = [...new Set(execution.qaAssessments.flatMap((assessment) => assessment.missingRequirements))];
        rework = {
          attempt: attempt + 1,
          findings: qa.findings,
          recommendations: qa.recommendations,
          previousRevision: manifest.revision,
          previousDigest: manifest.digest,
          previousArtifacts: manifest.artifacts.map((artifact) => ({ ...artifact })),
          latestQa: {
            ...qa,
            findings: qa.findings.map((finding) => ({ ...finding })),
            missingRequirements: [...qa.missingRequirements],
            recommendations: [...qa.recommendations],
          },
          unresolvedRequirements,
          requiredSections: [...research.sections],
        };
        this.transition(execution, "Rework", maxHistory);
        this.emit(execution, "rework_requested", maxHistory, "qa", attempt, undefined, manifest.digest, {
          nextAttempt: attempt + 1,
          findingCount: qa.findings.length,
        });
      }
      return this.fail(execution, { code: "ORCHESTRATION_ERROR", message: "Orchestration ended unexpectedly", stage: "orchestration", retryable: false }, maxHistory);
    } catch (error) {
      const failure = normalizeFailure(error);
      return this.fail(execution, failure, maxHistory);
    }
  }

  private async runResearch(execution: ProjectExecution, request: ProjectExecutionRequest, deadline: number, maxHistory: number): Promise<ResearchSpec | undefined> {
    const assignment = this.assign(execution, "research", 1, maxHistory);
    const step = this.startStep(execution, "research", 1, maxHistory);
    const result = await this.withDeadline(deadline, () => this.runner.runResearch(this.agents.researchAgent, request));
    return this.finishAgentStep(execution, step, assignment, result, maxHistory, "research");
  }

  private async runBuilder(execution: ProjectExecution, research: ResearchSpec, attempt: number, rework: BuilderInput["rework"], deadline: number, maxHistory: number): Promise<BuilderOutput | undefined> {
    const assignment = this.assign(execution, "builder", attempt, maxHistory);
    const step = this.startStep(execution, "builder", attempt, maxHistory);
    const result = await this.withDeadline(deadline, () => this.runner.runBuilder(this.agents.builderAgent, { research, rework }));
    return this.finishAgentStep(execution, step, assignment, result, maxHistory, "builder");
  }

  private async runQa(execution: ProjectExecution, research: ResearchSpec, deliverable: BuilderOutput, validation: DeterministicValidationReport, attempt: number, deadline: number, maxHistory: number): Promise<QaOutput | undefined> {
    this.transition(execution, "QualityReview", maxHistory);
    const assignment = this.assign(execution, "qa", attempt, maxHistory);
    const step = this.startStep(execution, "qa", attempt, maxHistory);
    const result = await this.withDeadline(deadline, () => this.runner.runQa(this.agents.qaAgent, { research, deliverable, deterministicValidation: validation }));
    return this.finishAgentStep(execution, step, assignment, result, maxHistory, "qa");
  }

  private startStep(execution: ProjectExecution, kind: ExecutionStepKind, attempt: number, maxHistory: number): ExecutionStep {
    const step: ExecutionStep = { stepId: `${kind}-${attempt}`, kind, attempt, status: "running", startedAt: this.now() };
    execution.steps.push(step);
    this.emit(execution, "agent_started", maxHistory, kind, attempt, step.stepId);
    return step;
  }

  private assign(execution: ProjectExecution, kind: ExecutionStepKind, attempt: number, maxHistory: number): AgentAssignment {
    const agent = kind === "research" ? this.agents.researchAgent : kind === "builder" ? this.agents.builderAgent : this.agents.qaAgent;
    const assignment: AgentAssignment = {
      assignmentId: `${execution.executionId}-${kind}-${attempt}`,
      agentKind: kind,
      agentId: agent.id,
      attempt,
      assignedAt: this.now(),
    };
    execution.assignedAgents.push(assignment);
    this.emit(execution, "agent_assigned", maxHistory, kind, attempt);
    return assignment;
  }

  private finishAgentStep<T>(execution: ProjectExecution, step: ExecutionStep, assignment: AgentAssignment, result: AgentExecution<T>, maxHistory: number, kind: ExecutionStepKind): T | undefined {
    step.completedAt = this.now();
    step.agentExecutionId = result.metadata.executionId;
    assignment.agentExecutionId = result.metadata.executionId;
    if (result.metadata.status !== "succeeded" || result.output === undefined) {
      step.status = "failed";
      const error = result.error ?? { code: "AGENT_FAILED", message: "Agent did not produce output", retryable: false };
      step.error = { ...error, stage: kind, agentExecutionId: result.metadata.executionId };
      this.emit(execution, "agent_failed", maxHistory, kind, step.attempt, step.stepId, undefined, { errorCode: error.code });
      return undefined;
    }
    step.status = "succeeded";
    this.emit(execution, "agent_completed", maxHistory, kind, step.attempt, step.stepId);
    return result.output;
  }

  private fail(execution: ProjectExecution, failure: ExecutionFailure, maxHistory: number, qa?: QaOutput): ProjectExecution {
    if (!terminalStatuses.includes(execution.status)) {
      this.transition(execution, "Failed", maxHistory);
    }
    execution.failure = failure;
    if (qa) {
      execution.reworkRequests.push({
        revision: execution.revisions.length,
        attempt: failure.attempt ?? execution.revisions.length,
        rejectedRevision: execution.revisions.length,
        terminal: true,
        findings: qa.findings,
        recommendations: qa.recommendations,
        missingRequirements: qa.missingRequirements,
        previousDigest: execution.revisions.at(-1)?.digest,
        requiredSections: execution.research?.sections,
        requestedAt: this.now(),
      });
    }
    this.emit(execution, "execution_failed", maxHistory, failure.stage === "orchestration" ? undefined : failure.stage, failure.attempt, undefined, undefined, { errorCode: failure.code });
    return this.touch(execution);
  }

  private latestFailure(execution: ProjectExecution, kind: ExecutionStepKind, attempt: number, fallbackCode: string, fallbackMessage: string): ExecutionFailure {
    const step = [...execution.steps].reverse().find((candidate) => candidate.kind === kind && candidate.attempt === attempt);
    return step?.error ?? { code: fallbackCode, message: fallbackMessage, stage: kind, attempt, retryable: false };
  }

  private transition(execution: ProjectExecution, next: ProjectExecutionStatus, maxHistory: number): void {
    assertValidTransition(execution.status, next);
    const previous = execution.status;
    execution.status = next;
    execution.updatedAt = this.now();
    this.emit(execution, "status_changed", maxHistory, undefined, undefined, undefined, undefined, { from: previous, to: next });
  }

  private emit(execution: ProjectExecution, type: ExecutionTimelineEventType, maxHistory: number, agentKind?: ExecutionStepKind, attempt?: number, stepId?: string, digest?: string, metadata?: Record<string, string | number | boolean>): void {
    // The state remains authoritative if the bounded audit buffer is full. We
    // never delete or rewrite existing events; later events are intentionally
    // omitted rather than allowing unbounded memory growth.
    if (execution.history.length >= maxHistory) return;
    const event: ExecutionTimelineEvent = {
      sequence: execution.history.length,
      eventId: `${execution.executionId}-event-${execution.history.length}`,
      type,
      executionId: execution.executionId,
      occurredAt: this.now(),
      status: execution.status,
      agentKind,
      attempt,
      stepId,
      digest,
      metadata,
    };
    execution.history.push(event);
    execution.updatedAt = event.occurredAt;
  }

  private touch(execution: ProjectExecution): ProjectExecution {
    execution.updatedAt = this.now();
    return execution;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async withDeadline<T>(deadline: number, task: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new OrchestrationError("EXECUTION_TIMEOUT", "Project execution exceeded its time limit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OrchestrationError("EXECUTION_TIMEOUT", "Project execution exceeded its time limit")), remaining);
    });
    try {
      return await Promise.race([task(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function applyDeterministicPolicy(qa: QaOutput, report: DeterministicValidationReport): QaOutput {
  const blockingFailures = report.rules.filter((item) => item.outcome === "fail" && item.blocking);
  if (blockingFailures.length === 0) return qa;
  const deterministicFindings: QaFinding[] = blockingFailures.map((item) => ({
    severity: item.severity,
    code: `DETERMINISTIC_${item.id.toUpperCase()}`,
    message: item.message,
    ...(item.path ? { path: item.path } : {}),
    recommendation: item.evidence,
  }));
  return {
    ...qa,
    passed: false,
    findings: [...qa.findings, ...deterministicFindings],
  };
}

export function canonicalizeArtifacts(artifacts: readonly Artifact[]): string {
  const sorted = [...artifacts].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return JSON.stringify({
    format: "attestra-artifacts-v2",
    artifacts: sorted.map(({ path, mediaType, content }) => ({ path, mediaType, content })),
  });
}

export async function computeArtifactDigest(artifacts: readonly Artifact[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeArtifacts(artifacts));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new OrchestrationError("HASH_UNAVAILABLE", "SHA-256 is unavailable in this runtime");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createDeliverableManifest(revision: number, artifacts: readonly Artifact[]): Promise<DeliverableManifest> {
  if (!Number.isInteger(revision) || revision < 1) throw new OrchestrationError("INVALID_REVISION", "Revision must be positive");
  const digest = await computeArtifactDigest(artifacts);
  return {
    revision,
    digest,
    canonicalFormat: "attestra-artifacts-v2",
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
    totalBytes: new TextEncoder().encode(canonicalizeArtifacts(artifacts)).byteLength,
  };
}

function boundedValue(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new OrchestrationError("INVALID_CONFIG", `${field} must be between ${minimum} and ${maximum}`);
  return value;
}

function boundedOption(value: number | undefined, minimum: number, maximum: number, field: string): void {
  if (value !== undefined) boundedValue(value, minimum, maximum, field);
}

function createExecutionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `execution_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeFailure(error: unknown): ExecutionFailure {
  if (error instanceof OrchestrationError) {
    return { code: error.code, message: error.message, stage: "orchestration", retryable: false };
  }
  const agentError = error as AgentErrorInfo | undefined;
  if (agentError && typeof agentError.code === "string" && typeof agentError.message === "string") {
    return { code: agentError.code, message: agentError.message, stage: "orchestration", retryable: agentError.retryable === true };
  }
  return { code: "ORCHESTRATION_ERROR", message: error instanceof Error ? error.message : "Orchestration failed", stage: "orchestration", retryable: false };
}
