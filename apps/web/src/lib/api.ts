export type ExecutionLifecycle = "queued" | "running" | "completed";
export type ExecutionStatus = "Created" | "Planning" | "Building" | "QualityReview" | "Rework" | "AwaitingIndependentVerification" | "Failed";
export type ExecutionStepKind = "research" | "builder" | "qa";
export type ExecutionStepStatus = "pending" | "running" | "succeeded" | "failed";

export type ExecutionFailure = {
  code: string;
  message: string;
  stage: ExecutionStepKind | "orchestration";
  attempt?: number;
  retryable: boolean;
};

export type ExecutionStep = {
  stepId: string;
  kind: ExecutionStepKind;
  attempt: number;
  status: ExecutionStepStatus;
  startedAt?: string;
  completedAt?: string;
  error?: ExecutionFailure;
};

export type ExecutionSummary = {
  executionId: string;
  projectId?: string;
  status: ExecutionStatus;
  lifecycle: ExecutionLifecycle;
  digest?: string;
  createdAt: string;
  updatedAt: string;
  failure?: ExecutionFailure;
};

export type ExecutionRecord = ExecutionSummary & {
  paymentEligible?: boolean;
  milestoneId?: string;
  requirements: string;
  targetAudience?: string;
  constraints: string[];
  assignedAgents: Array<{ assignmentId: string; agentKind: ExecutionStepKind; agentId: string; attempt: number; assignedAt: string }>;
  steps: ExecutionStep[];
  history: Array<{ sequence: number; type: string; occurredAt: string; status: ExecutionStatus; attempt?: number; agentKind?: ExecutionStepKind; metadata?: Record<string, string | number | boolean> }>;
  research?: { summary: string; sections: string[]; acceptanceCriteria?: string[]; designRequirements: string[]; implementationRequirements: string[]; ambiguities: string[]; risks: string[] };
  revisions: Array<{ revision: number; digest: string; totalBytes: number }>;
  reworkRequests: Array<{ revision: number; rejectedRevision: number; nextBuilderAttempt?: number; terminal: boolean; findings: Array<{ severity: string; code: string; message: string; path?: string; recommendation: string }>; missingRequirements: string[]; recommendations: string[] }>;
  qaAssessments: Array<{ revision: number; digest: string; passed: boolean; findings: Array<{ severity: string; code: string; message: string; path?: string; recommendation: string }>; missingRequirements: string[]; recommendations: string[]; evaluatedAt: string }>;
  validationReports: Array<{ executionId: string; revision: number; artifactDigest: string; validatedAt: string; version: string; rules: Array<{ id: string; outcome: "pass" | "fail" | "unknown"; severity: string; blocking: boolean; message: string; evidence: string; path?: string }>; summary: { passed: number; failed: number; unknown: number; blockingFailures: number } }>;
  finalDeliverable?: { revision: number; digest: string; totalBytes: number };
  failure?: ExecutionFailure;
};

export type ExecutionListResponse = { items: ExecutionSummary[]; offset: number; limit: number };

export type DeliverableArtifact = { path: string; mediaType: string; content: string };
export type ArtifactResponse = { executionId: string; digest: string; revision: number; artifacts: DeliverableArtifact[] };

export type VerificationDecision = "Passed" | "Failed";
export type VerificationCheck = { id: string; name: string; required: boolean; status: "passed" | "failed" | "skipped"; message: string; evidence?: string };
export type VerificationFailure = { code: string; message: string; retryable: boolean; stage: "input" | "deterministic" | "llm" | "receipt" };
export type VerificationReceipt = { receiptId: string; projectId: string; milestoneId: string; artifactDigest: string; result: VerificationDecision; checks: VerificationCheck[]; timestamp: string; policyVersion: string; verifier: { engineId: string; implementationVersion?: string; provider?: string; model?: string; llmReview: "disabled" | "optional" | "required" | "completed" }; failure?: VerificationFailure };
export type VerificationAttempt = { attemptId: string; executionId: string; status: "in_progress" | "verified" | "rejected" | "error"; revision: number; artifactDigest: string; policyVersion: string; verifierImplementationVersion?: string; requestedAt: string; completedAt?: string; result?: VerificationDecision; reVerificationReason?: string; criteriaFingerprint?: string; receipt?: VerificationReceipt; failure?: VerificationFailure };
export type VerificationState = { status: VerificationAttempt["status"] | "not_requested"; executionId: string; revision?: number; artifactDigest?: string; policyVersion?: string; verifierImplementationVersion?: string; requestedAt?: string; completedAt?: string; criteriaFingerprint?: string; result?: VerificationDecision; reVerificationReason?: string; receipt?: VerificationReceipt; failure?: VerificationFailure; latestAttempt?: VerificationAttempt; history: VerificationAttempt[]; reverification?: { available: boolean; reason: string } };

export type CreateExecutionInput = {
  projectId?: string;
  requirements: string;
  targetAudience?: string;
  constraints?: string[];
  paymentEligible?: boolean;
  maxBuilderAttempts?: number;
};

export type CreateExecutionResponse = { executionId: string; status: "Created"; lifecycle: "queued" };
export type HealthResponse = { status: "ok"; service: "api"; timestamp: string };
export type AuthChallenge = { challengeId: string; message: string; recipient: string; nonce: string; expiresAt: string };
export type WalletSession = { accountId: string; network: "testnet"; expiresAt: string };
export type NearConfig = { network: "testnet"; contractAccountId: string; authorizedVerifier?: string; projectStorageDeposit: string; milestoneStorageDeposit: string; verificationStorageDeposit?: string; approvalStorageDeposit?: string; settlementStorageDeposit?: string };
export type ChainLinkage = { executionId: string; network: "testnet"; contractAccountId: string; onChainProjectId?: string; onChainMilestoneId?: string; offChainMilestoneId: string; ownerAccountId?: string; recipientAccountId?: string; milestoneBudget?: string; projectCreationTransactionHash?: string; milestoneRegistrationTransactionHash?: string; fundingTransactionHash?: string; activationTransactionHash?: string; startTransactionHash?: string; verificationTransactionHash?: string; approvalTransactionHash?: string; settlementTransactionHash?: string; settlementTransactionHashes?: string[]; status: "unlinked" | "pending" | "confirmed" | "conflict"; requestedAt?: string; confirmedAt?: string };
export type ChainProject = { projectId: number; owner: string; totalFunded: string; availableBalance: string; reservedBalance: string; paidBalance: string; refundedBalance: string; pendingRefundBalance: string; nextMilestoneId: number; pendingPayment?: number; pendingRefund?: number; storageDeposit: string };
export type ChainVerification = { projectId: number; milestoneId: number; deliverableDigest: string; receiptId: string; result: "Passed" | "Failed"; verifier: string };
export type ChainMilestone = { projectId: number; milestoneId: number; recipient: string; budget: string; dependencies: number[]; status: "Created" | "Funded" | "InProgress" | "VerificationFailed" | "VerificationPassed" | "OwnerApproved" | "PaymentPending" | "Paid" | "Cancelled" | "Refunded"; verification?: ChainVerification; approvalReceiptId?: string };
export type ChainStateResponse = { executionId: string; confirmed: boolean; linkage?: ChainLinkage; state: { project: ChainProject; milestone: ChainMilestone } | null; reason?: string };
export type ChainOperation = "fund" | "activate" | "start" | "submit_verification" | "approve" | "settle";
export type BackendVerificationSubmission = { state: "pending" | "finalized" | "failed" | "unknown"; executionId: string; receiptId: string; artifactDigest: string; transactionHash?: string; error?: string; submissionMode?: "backend-verifier" };
export type ChainIntent = { operation: ChainOperation; receiverId: string; methodName: "fund_project" | "activate_milestone" | "start_milestone" | "submit_verification" | "approve_milestone" | "settle_milestone"; args: Record<string, unknown>; gas: string; deposit: string; projectId: number; milestoneId: number; expectedOwner?: string; expectedVerifier?: string; expectedRecipient?: string; expectedBudget?: string; receiptId?: string; artifactDigest?: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PollingTimeoutError extends Error {
  constructor(message = "Execution status polling timed out") {
    super(message);
    this.name = "PollingTimeoutError";
  }
}

const defaultApiBaseUrl = "http://localhost:4000";

export function getApiBaseUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_API_BASE_URL ?? defaultApiBaseUrl).replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && (!process.env.NEXT_PUBLIC_API_BASE_URL || /^https?:\/\/localhost(?::\d+)?$/.test(configured))) throw new Error("NEXT_PUBLIC_API_BASE_URL must be configured to the public HTTPS API origin");
  return configured;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("The ATTESTRA API is unavailable. Check that the backend is running.", 0, "API_UNAVAILABLE");
  }

  const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
  if (!response.ok) { const retryAfter = response.headers.get("retry-after"); const retryAfterMs = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Math.max(0, Date.parse(retryAfter) - Date.now()) : undefined; throw new ApiError(body?.error?.message ?? `API request failed with HTTP ${response.status}`, response.status, body?.error?.code, retryAfterMs); }
  return body as T;
}

export function checkHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/health");
}

export function getAuthChallenge(): Promise<AuthChallenge> { return requestJson<AuthChallenge>("/api/v1/auth/challenge"); }
export function authenticateWallet(input: { challengeId: string; signedMessage: { accountId: string; publicKey: string; signature: string } }): Promise<WalletSession> { return requestJson<WalletSession>("/api/v1/auth/near", { method: "POST", body: JSON.stringify(input) }); }
export function getWalletSession(): Promise<WalletSession> { return requestJson<WalletSession>("/api/v1/auth/me"); }
export function disconnectWallet(): Promise<{ authenticated: false }> { return requestJson<{ authenticated: false }>("/api/v1/auth/logout", { method: "POST" }); }
export function getNearConfig(): Promise<NearConfig> { return requestJson<NearConfig>("/api/v1/near/config"); }
export function recordProjectTransaction(executionId: string, transactionHash: string): Promise<{ confirmed: boolean; linkage: ChainLinkage; state: { project: unknown } }> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/project`, { method: "POST", body: JSON.stringify({ transactionHash }) }); }
export function recordMilestoneTransaction(executionId: string, transactionHash: string): Promise<{ confirmed: boolean; linkage: ChainLinkage; state: { milestone: unknown } }> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/milestone`, { method: "POST", body: JSON.stringify({ transactionHash }) }); }
export function attachExistingChain(executionId: string, projectId: string, milestoneId: string): Promise<{ confirmed: boolean; linkage: ChainLinkage; state: { project: ChainProject; milestone: ChainMilestone } }> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/attach`, { method: "POST", body: JSON.stringify({ projectId, milestoneId }) }); }
export function getChainLinkage(executionId: string): Promise<{ executionId: string; linkage: ChainLinkage; confirmed: boolean }> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain`); }
export function getChainState(executionId: string): Promise<ChainStateResponse> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/state`); }
export function requestChainIntent(executionId: string, operation: ChainOperation, amount?: string): Promise<ChainIntent> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/intent`, { method: "POST", body: JSON.stringify({ operation, ...(amount ? { amount } : {}) }) }); }
export function reconcileChainOperation(executionId: string, operation: ChainOperation, transactionHash: string, amount?: string): Promise<{ confirmed: boolean; operation: ChainOperation; transactionHash: string; paymentStatus?: string; linkage: ChainLinkage; state: { project: ChainProject; milestone: ChainMilestone } }> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/reconcile`, { method: "POST", body: JSON.stringify({ operation, transactionHash, ...(amount ? { amount } : {}) }) }); }
export function submitBackendVerification(executionId: string): Promise<BackendVerificationSubmission> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/submit-verification`, { method: "POST" }); }
export function reconcileBackendVerification(executionId: string, transactionHash: string): Promise<BackendVerificationSubmission> { return requestJson(`/api/v1/executions/${encodeURIComponent(executionId)}/chain/submit-verification/reconcile`, { method: "POST", body: JSON.stringify({ transactionHash }) }); }

export function createExecution(input: CreateExecutionInput): Promise<CreateExecutionResponse> {
  return requestJson<CreateExecutionResponse>("/api/v1/executions", { method: "POST", body: JSON.stringify(input) });
}

export function getExecution(executionId: string): Promise<ExecutionRecord> {
  return requestJson<ExecutionRecord>(`/api/v1/executions/${encodeURIComponent(executionId)}`);
}

export function listExecutions(offset = 0, limit = 20): Promise<ExecutionListResponse> {
  return requestJson<ExecutionListResponse>(`/api/v1/executions?offset=${offset}&limit=${limit}`);
}

export function getArtifacts(executionId: string): Promise<ArtifactResponse> {
  return requestJson<ArtifactResponse>(`/api/v1/executions/${encodeURIComponent(executionId)}/artifacts`);
}

export function getVerification(executionId: string, signal?: AbortSignal): Promise<VerificationState> {
  return requestJson<VerificationState>(`/api/v1/executions/${encodeURIComponent(executionId)}/verification`, { signal });
}

export function requestVerification(executionId: string, options: { reason?: string; signal?: AbortSignal } | AbortSignal = {}): Promise<VerificationReceipt> {
  const normalized = options instanceof AbortSignal ? { signal: options } : options;
  return requestJson<VerificationReceipt>(`/api/v1/executions/${encodeURIComponent(executionId)}/verify`, { method: "POST", body: JSON.stringify(normalized.reason ? { reverificationReason: normalized.reason } : {}), signal: normalized.signal });
}

export type PollExecutionOptions = {
  maxAttempts?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (execution: ExecutionRecord) => void;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  fetchExecution?: (executionId: string) => Promise<ExecutionRecord>;
};

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Polling aborted", "AbortError"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Polling aborted", "AbortError")); }, { once: true });
  });
}

export async function pollExecution(executionId: string, options: PollExecutionOptions = {}): Promise<ExecutionRecord> {
  const maxAttempts = options.maxAttempts ?? 60;
  const intervalMs = options.intervalMs ?? 2_000;
  const fetchStatus = options.fetchExecution ?? getExecution;
  const wait = options.sleep ?? sleep;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException("Polling aborted", "AbortError");
    let execution: ExecutionRecord;
    try { execution = await fetchStatus(executionId); } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 429 || attempt >= maxAttempts - 1) throw cause;
      const exponentialDelay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 4)));
      const jitter = Math.floor(Math.random() * 250);
      await wait(cause.retryAfterMs ?? exponentialDelay + jitter, options.signal);
      continue;
    }
    options.onUpdate?.(execution);
    if (execution.lifecycle === "completed") return execution;
    if (attempt < maxAttempts - 1) await wait(intervalMs, options.signal);
  }
  throw new PollingTimeoutError();
}
