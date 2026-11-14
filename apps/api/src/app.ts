import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ARTIFACT_LIMITS, AgentError, BuilderAgent, DeterministicMockProvider, OpenAICompatibleProvider, QaAgent, ResearchAgent, type LlmProvider } from "@attestra/agents";
import { Orchestrator, computeArtifactDigest, validateProjectExecutionRequest, type ProjectExecution, type ProjectExecutionRequest } from "@attestra/orchestrator";
import { VERIFIER_IMPLEMENTATION_VERSION, VerificationEngine, VerificationError, toContractVerificationArgs, type VerificationCriteria, type VerificationPolicy, type VerificationReceipt } from "@attestra/verification";
import { healthResponse } from "@attestra/shared";
import { NearReadError, NearReadonlyAdapter, type NearMilestone, type NearProject } from "@attestra/near-readonly";
import { randomUUID } from "node:crypto";
import { ExecutionStore, type ExecutionStoreLike, type PersistedVerification, type StoredExecution, type VerificationAttempt } from "./store.js";
import { newAuthChallenge, parseCookie, verifySignedNearMessage, type AuthChallenge, type SignedNearMessage } from "./auth.js";
import { BackendVerifierSubmissionService, type BackendVerifierSigner } from "./verifier-submission.js";
import { VerifierSubmissionStore, type VerifierSubmissionStoreLike } from "./verifier-submission-store.js";
import { dirname, resolve } from "node:path";
import { resolveDatabasePath } from "./persistence.js";

export type ApiOptions = { databasePath?: string; provider?: LlmProvider; demoMode?: boolean; frontendOrigin?: string; store?: ExecutionStoreLike; verificationWriteToken?: string; allowLocalVerificationWrites?: boolean; nearAdapter?: NearReadonlyAdapter; verifierSigner?: BackendVerifierSigner; verifierSignerConfigurationError?: string; verifierSubmissionStore?: VerifierSubmissionStoreLike };
const MAX_BODY_BYTES = 40_000;
const MAX_ARTIFACT_RESPONSE_BYTES = 300_000;
const MAX_PAGE_LIMIT = 50;
const MAX_REVERIFICATION_REASON = 500;
const AUTH_COOKIE = "attestra_session";
const SESSION_TTL_MS = 8 * 60 * 60_000;
const VERIFICATION_POLICY: VerificationPolicy = { version: "verification-policy-v1", llmReview: "disabled", maxArtifactBytes: ARTIFACT_LIMITS.maxArtifactBytes, maxTotalArtifactBytes: ARTIFACT_LIMITS.maxTotalArtifactBytes, maxDurationMs: 30_000 };
const rateBuckets = new Map<string, { started: number; count: number }>();
const now = () => new Date().toISOString();
const requestIp = (request: FastifyRequest) => request.ip || "unknown";
function rateLimitClass(request: FastifyRequest): { name: "status" | "auth" | "general"; limit: number } { const path = request.url.split("?", 1)[0] ?? request.url; if (request.method === "GET" && (path === "/api/v1/executions" || /^\/api\/v1\/executions\/[^/]+(?:\/events|\/chain|\/chain\/state|\/verification|\/artifacts)?$/.test(path))) return { name: "status", limit: 180 }; if (path.startsWith("/api/v1/auth/")) return { name: "auth", limit: 20 }; return { name: "general", limit: 60 }; }
function rateLimit(request: FastifyRequest): { allowed: boolean; retryAfterSeconds: number } { const category = rateLimitClass(request); const key = `${category.name}:${requestIp(request)}`; const current = Date.now(); const bucket = rateBuckets.get(key); if (!bucket || current - bucket.started >= 60_000) { rateBuckets.set(key, { started: current, count: 1 }); return { allowed: true, retryAfterSeconds: 0 }; } bucket.count += 1; if (bucket.count <= category.limit) return { allowed: true, retryAfterSeconds: 0 }; return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (current - bucket.started)) / 1_000)) }; }
function errorBody(code: string, message: string) { return { error: { code, message } }; }
function bodyObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object"); return value as Record<string, unknown>; }
function readProvider(options: ApiOptions): LlmProvider {
  if (options.provider) return options.provider;
  const demo = options.demoMode ?? process.env.ATTESTRA_DEMO_MODE === "true";
  if (demo) return new DeterministicMockProvider({ responses: [
    JSON.stringify({ summary: "Demo landing page research", sections: ["hero", "features"], designRequirements: ["clear hierarchy"], implementationRequirements: ["static HTML and CSS"], ambiguities: [], risks: [] }),
    JSON.stringify({ summary: "Demo static landing page", artifacts: [{ path: "index.html", mediaType: "text/html", content: '<!doctype html><html lang="en"><head><title>ATTESTRA</title><link rel="stylesheet" href="styles.css"></head><body><header id="hero"><h1>ATTESTRA</h1></header><main><section id="features">Features</section><button aria-label="Start">Start</button></main></body></html>' }, { path: "styles.css", mediaType: "text/css", content: "body{font-family:sans-serif}@media(max-width:600px){body{font-size:1rem}}" }] }),
    JSON.stringify({ passed: true, findings: [], missingRequirements: [], recommendations: [] }),
  ] });
  if (!process.env.ATTESTRA_LLM_API_KEY) throw new AgentError("PROVIDER_CONFIG", "ATTESTRA_LLM_API_KEY is required unless ATTESTRA_DEMO_MODE=true");
  return new OpenAICompatibleProvider({ apiKey: process.env.ATTESTRA_LLM_API_KEY, model: process.env.ATTESTRA_LLM_MODEL ?? "gpt-4o-mini", baseUrl: process.env.ATTESTRA_LLM_BASE_URL, timeoutMs: process.env.ATTESTRA_LLM_TIMEOUT_MS ? Number(process.env.ATTESTRA_LLM_TIMEOUT_MS) : undefined, maxRetries: process.env.ATTESTRA_LLM_MAX_RETRIES ? Number(process.env.ATTESTRA_LLM_MAX_RETRIES) : undefined });
}
function initialRecord(request: ProjectExecutionRequest, executionId: string, createdByAccountId?: string): StoredExecution { const createdAt = now(); return { executionId, createdByAccountId, projectId: request.projectId, requirements: request.requirements, targetAudience: request.targetAudience, constraints: [...(request.constraints ?? [])], paymentEligible: request.paymentEligible === true, status: "Created", createdAt, updatedAt: createdAt, assignedAgents: [], steps: [], history: [{ sequence: 0, eventId: `${executionId}-event-0`, type: "execution_created", executionId, occurredAt: createdAt, status: "Created" }], revisions: [], reworkRequests: [], qaAssessments: [], validationReports: [], lifecycle: "queued", onChainLinkage: { executionId, network: "testnet", contractAccountId: "", offChainMilestoneId: "", status: "unlinked" } }; }
function executionRequest(value: unknown, executionId: string): ProjectExecutionRequest { const request = { ...bodyObject(value), executionId } as ProjectExecutionRequest; validateProjectExecutionRequest(request); return request; }
function appendFailure(record: StoredExecution, code: string, message: string): StoredExecution { const occurredAt = now(); record.status = "Failed"; record.lifecycle = "completed"; record.failure = { code, message, stage: "orchestration", retryable: true }; record.updatedAt = occurredAt; if (record.history.length < 500) record.history.push({ sequence: record.history.length, eventId: `${record.executionId}-event-${record.history.length}`, type: "execution_failed", executionId: record.executionId, occurredAt, status: "Failed", metadata: { errorCode: code } }); return record; }
function loopbackAddress(ip: string): boolean { const normalized = ip.replace(/^::ffff:/, ""); return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost"; }
function verificationWriteAuthorized(request: FastifyRequest, options: ApiOptions): boolean { const configured = options.verificationWriteToken ?? process.env.ATTESTRA_VERIFICATION_TOKEN; const supplied = request.headers["x-attestra-verification-token"]; if (configured) return typeof supplied === "string" && supplied === configured; return options.allowLocalVerificationWrites !== false && process.env.NODE_ENV !== "production" && loopbackAddress(requestIp(request)); }
function authenticatedAccount(request: FastifyRequest, sessions: Map<string, { accountId: string; expiresAt: number }>): string | undefined { const token = parseCookie(request.headers.cookie, AUTH_COOKIE); const session = token ? sessions.get(token) : undefined; if (!session || session.expiresAt <= Date.now()) { if (token) sessions.delete(token); return undefined; } return session.accountId; }
function requireAuthenticated(request: FastifyRequest, reply: { code: (code: number) => { send: (body: unknown) => unknown } }, sessions: Map<string, { accountId: string; expiresAt: number }>): string | undefined { const accountId = authenticatedAccount(request, sessions); if (!accountId) { reply.code(401).send(errorBody("AUTHENTICATION_REQUIRED", "Connect and authenticate a NEAR wallet before this operation")); return undefined; } return accountId; }
function signedMessageBody(value: unknown): SignedNearMessage { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("signedMessage is required"); const item = value as Record<string, unknown>; if (typeof item.accountId !== "string" || typeof item.publicKey !== "string" || typeof item.signature !== "string") throw new Error("Invalid signed wallet message"); return { accountId: item.accountId, publicKey: item.publicKey, signature: item.signature }; }
function decodeU64Success(value: unknown): number { if (typeof value !== "string") throw new Error("Transaction did not return a project or milestone ID"); const decoded = Buffer.from(value, "base64").toString("utf8"); if (!/^\d+$/.test(decoded)) throw new Error("Contract returned an invalid numeric ID"); const id = Number(decoded); if (!Number.isSafeInteger(id)) throw new Error("Contract ID exceeds safe integer range"); return id; }
function decodeFunctionArgs(argsBase64: string): Record<string, unknown> { const value = JSON.parse(Buffer.from(argsBase64, "base64").toString("utf8")) as unknown; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Transaction arguments are invalid"); return value as Record<string, unknown>; }
function chainConfig(): { contractAccountId: string; network: "testnet"; projectStorageDeposit: string; milestoneStorageDeposit: string; authorizedVerifier?: string; verificationStorageDeposit?: string; approvalStorageDeposit?: string; settlementStorageDeposit?: string } { const contractAccountId = process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; const projectStorageDeposit = process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO; const milestoneStorageDeposit = process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO; if (!contractAccountId || !projectStorageDeposit || !milestoneStorageDeposit || !/^(0|[1-9][0-9]*)$/.test(projectStorageDeposit) || !/^(0|[1-9][0-9]*)$/.test(milestoneStorageDeposit)) throw new Error("NEAR project and milestone storage deposits are not configured"); const deposit = (name: string) => { const value = process.env[name]; return value && /^(0|[1-9][0-9]*)$/.test(value) ? value : undefined; }; return { contractAccountId, network: "testnet", projectStorageDeposit, milestoneStorageDeposit, authorizedVerifier: process.env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID, verificationStorageDeposit: deposit("NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO"), approvalStorageDeposit: deposit("NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO"), settlementStorageDeposit: deposit("NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO") }; }
function successfulFunctionCall(transaction: Awaited<ReturnType<NearReadonlyAdapter["getTransaction"]>>, methodName: string): Record<string, unknown> { if (!transaction.success || transaction.receiverId !== chainConfig().contractAccountId || transaction.actions.length !== 1 || transaction.actions[0]?.type !== "FunctionCall" || transaction.actions[0].methodName !== methodName || !transaction.actions[0].argsBase64) throw new Error("Finalized transaction does not match the expected contract call"); return { ...transaction, args: decodeFunctionArgs(transaction.actions[0].argsBase64) } as unknown as Record<string, unknown>; }
type ChainOperation = "fund" | "activate" | "start" | "submit_verification" | "approve" | "settle";
const LIFECYCLE_GAS = "30000000000000";
const ONE_YOCTO = "1";
function positiveYocto(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error("Funding amount must be a positive yoctoNEAR integer"); return value; }
function chainOperation(value: unknown): ChainOperation { if (value !== "fund" && value !== "activate" && value !== "start" && value !== "submit_verification" && value !== "approve" && value !== "settle") throw new Error("Unsupported chain operation"); return value; }
async function linkedChainState(record: StoredExecution, adapter: NearReadonlyAdapter): Promise<{ linkage: NonNullable<StoredExecution["onChainLinkage"]>; project: NearProject; milestone: NearMilestone }> {
  const linkage = record.onChainLinkage;
  if (!linkage || linkage.status !== "confirmed" || !linkage.onChainProjectId || !linkage.onChainMilestoneId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget) throw new Error("Confirmed project, owner, recipient, and milestone linkage is required");
  if (adapter.network !== linkage.network || adapter.contractAccountId !== linkage.contractAccountId) throw new Error("NEAR adapter does not match the confirmed linkage");
  const projectId = safeChainId(linkage.onChainProjectId); const milestoneId = safeChainId(linkage.onChainMilestoneId);
  const [project, milestone] = await Promise.all([adapter.getProject(projectId), adapter.getMilestone(projectId, milestoneId)]);
  if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || project.owner !== linkage.ownerAccountId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget) throw new Error("Finalized chain state does not match the trusted linkage");
  return { linkage, project, milestone };
}
function requiredDeposit(value: string | undefined, name: string): string { if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} is not configured as a positive yoctoNEAR amount`); return value; }
function chainIntent(operation: ChainOperation, linkage: NonNullable<StoredExecution["onChainLinkage"]>, projectId: number, milestoneId: number, amount?: string, receipt?: VerificationReceipt, config?: ReturnType<typeof chainConfig>): Record<string, unknown> {
  if (operation === "fund") return { operation, receiverId: linkage.contractAccountId, methodName: "fund_project", args: { project_id: projectId }, gas: LIFECYCLE_GAS, deposit: positiveYocto(amount) };
  if (operation === "activate") return { operation, receiverId: linkage.contractAccountId, methodName: "activate_milestone", args: { project_id: projectId, milestone_id: milestoneId }, gas: LIFECYCLE_GAS, deposit: ONE_YOCTO };
  if (operation === "start") return { operation, receiverId: linkage.contractAccountId, methodName: "start_milestone", args: { project_id: projectId, milestone_id: milestoneId }, gas: LIFECYCLE_GAS, deposit: ONE_YOCTO };
  if (operation === "submit_verification") { if (!receipt || !config) throw new Error("A passing verification receipt is required"); return { operation, receiverId: linkage.contractAccountId, methodName: "submit_verification", args: toContractVerificationArgs(receipt), gas: LIFECYCLE_GAS, deposit: requiredDeposit(config.verificationStorageDeposit, "Verification storage deposit") }; }
  if (operation === "approve") { if (!receipt || !config) throw new Error("A passing verification receipt is required"); return { operation, receiverId: linkage.contractAccountId, methodName: "approve_milestone", args: { project_id: projectId, milestone_id: milestoneId, receipt_id: receipt.receiptId }, gas: LIFECYCLE_GAS, deposit: requiredDeposit(config.approvalStorageDeposit, "Approval storage deposit") }; }
  if (!config) throw new Error("NEAR configuration is unavailable");
  return { operation, receiverId: linkage.contractAccountId, methodName: "settle_milestone", args: { project_id: projectId, milestone_id: milestoneId }, gas: LIFECYCLE_GAS, deposit: requiredDeposit(config.settlementStorageDeposit, "Settlement storage deposit") };
}
async function latestPassingReceipt(record: StoredExecution, projectId: number, milestoneId: number): Promise<VerificationReceipt> {
  const attempt = record.verificationHistory?.at(-1) ?? record.verificationState;
  const receipt = attempt?.receipt ?? record.verification;
  const final = record.finalDeliverable;
  if (!attempt || attempt.status !== "verified" || !receipt || receipt.result !== "Passed" || !final) throw new Error("A persisted passing independent verification receipt is required");
  if (await computeArtifactDigest(final.artifacts) !== final.digest) throw new Error("Stored final artifact digest does not match its canonical contents");
  if (attempt.executionId !== record.executionId || attempt.revision !== final.revision || attempt.artifactDigest !== final.digest || receipt.projectId !== String(projectId) || receipt.milestoneId !== String(milestoneId) || receipt.artifactDigest !== final.digest || receipt.policyVersion !== VERIFICATION_POLICY.version || receipt.verifier.implementationVersion !== VERIFIER_IMPLEMENTATION_VERSION) throw new Error("Verification receipt does not match the linked execution, artifact, project, or milestone");
  if (receipt.checks.some((check) => check.required && check.status !== "passed")) throw new Error("Verification receipt contains a failed mandatory check");
  return receipt;
}
export function createNearAdapterFromEnvironment(): NearReadonlyAdapter | undefined { const contractAccountId = process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; if (!contractAccountId) return undefined; return new NearReadonlyAdapter({ network: process.env.NEAR_NETWORK, rpcUrl: process.env.NEAR_RPC_URL, contractAccountId }); }
function verificationCriteria(body: Record<string, unknown>): VerificationCriteria {
  const value = body.criteria;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VerificationError("VERIFICATION_CRITERIA_REQUIRED", "Explicit verification criteria are required", false);
  const criteria = value as Partial<VerificationCriteria>;
  if (!Array.isArray(criteria.requiredSections) || !Array.isArray(criteria.acceptanceCriteria) || criteria.acceptanceCriteria.length === 0) throw new VerificationError("INVALID_VERIFICATION_CRITERIA", "Verification criteria are invalid", false);
  return { requiredSections: criteria.requiredSections.filter((item): item is string => typeof item === "string"), acceptanceCriteria: criteria.acceptanceCriteria.filter((item): item is string => typeof item === "string"), requireAccessibility: criteria.requireAccessibility !== false };
}
function authoritativeVerificationCriteria(record: StoredExecution, body: Record<string, unknown>): VerificationCriteria {
  const savedSections = (record.research?.sections ?? []).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (savedSections.length === 0) throw new VerificationError("VERIFICATION_CRITERIA_NOT_SAVED", "No structured acceptance requirements are saved for this execution", false);
  const savedRequirements = [...(record.research?.acceptanceCriteria ?? []), ...(record.research?.implementationRequirements ?? []), ...(record.constraints ?? [])].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const requested = body.criteria === undefined ? undefined : verificationCriteria(body);
  const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return { requiredSections: unique([...savedSections, ...(requested?.requiredSections ?? [])]), acceptanceCriteria: unique([...savedRequirements, ...(requested?.acceptanceCriteria ?? [])]), requireAccessibility: true };
}
function canonicalMilestoneId(record: StoredExecution): string {
  if (record.onChainLinkage?.status === "confirmed" && record.onChainLinkage.onChainMilestoneId) return record.onChainLinkage.onChainMilestoneId;
  if (record.paymentEligible) throw new VerificationError("CHAIN_LINKAGE_REQUIRED", "Payment-eligible execution requires confirmed on-chain project and milestone linkage", false);
  if (record.milestoneIdentity?.status !== "authoritative" || !record.milestoneIdentity.milestoneId || record.milestoneIdentity.onChainLinked !== false) throw new VerificationError("MILESTONE_ID_UNRESOLVED", "Execution has no unambiguous server-controlled milestone identity", false);
  return record.milestoneIdentity.milestoneId;
}
function safeChainId(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new NearReadError("INVALID_CONFIG", "Confirmed linkage contains an invalid chain identifier");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new NearReadError("INVALID_CONFIG", "Confirmed linkage identifier exceeds JavaScript safe integer range");
  return parsed;
}
function assertMilestoneRequestMatches(record: StoredExecution, body: Record<string, unknown>): string {
  const canonical = canonicalMilestoneId(record);
  if (body.milestoneId !== undefined && (typeof body.milestoneId !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.milestoneId) || body.milestoneId !== canonical)) throw new VerificationError("MILESTONE_ID_CONFLICT", "Client milestoneId conflicts with the server-controlled execution milestone", false);
  return canonical;
}
function reverificationReason(body: Record<string, unknown>): string | undefined {
  if (body.reverificationReason === undefined) return undefined;
  if (typeof body.reverificationReason !== "string") throw new VerificationError("INVALID_REVERIFICATION_REASON", "reverificationReason must be a string", false);
  const reason = body.reverificationReason.trim();
  if (!reason || reason.length > MAX_REVERIFICATION_REASON) throw new VerificationError("INVALID_REVERIFICATION_REASON", `reverificationReason must be between 1 and ${MAX_REVERIFICATION_REASON} characters`, false);
  return reason;
}
async function verificationResponse(record: StoredExecution): Promise<Record<string, unknown>> {
  const history = record.verificationHistory ?? [];
  const latest = history.at(-1);
  const changed = Boolean(latest && (latest.policyVersion !== VERIFICATION_POLICY.version || latest.verifierImplementationVersion !== VERIFIER_IMPLEMENTATION_VERSION));
  let eligibilityReason: string | undefined;
  if (latest) {
    try { await verificationEligibility(record); } catch (error) { eligibilityReason = error instanceof VerificationError ? error.message : "Execution is not eligible for verification."; }
  }
  const retryableInterrupted = latest?.status === "error" && latest.failure?.code === "VERIFICATION_PROCESS_INTERRUPTED";
  const reverification = latest ? { available: !eligibilityReason && (changed || retryableInterrupted), reason: eligibilityReason ?? (changed ? "A server-controlled verifier or policy version changed." : retryableInterrupted ? "The previous verification was interrupted and is recoverable." : "A new verifier or policy version is required.") } : undefined;
  if (record.verificationState) return { ...record.verificationState, milestoneId: record.milestoneId, milestoneIdentity: record.milestoneIdentity, latestAttempt: latest, history, reverification };
  if (record.verification) return { status: record.verification.result === "Passed" ? "verified" : "rejected", executionId: record.executionId, milestoneId: record.milestoneId, milestoneIdentity: record.milestoneIdentity, revision: record.revisions.find((revision) => revision.digest === record.verification?.artifactDigest)?.revision ?? record.revisions.length, artifactDigest: record.verification.artifactDigest, policyVersion: record.verification.policyVersion, requestedAt: record.verification.timestamp, completedAt: record.verification.timestamp, receipt: record.verification, latestAttempt: latest, history, reverification };
  return { status: "not_requested", executionId: record.executionId, milestoneId: record.milestoneId, milestoneIdentity: record.milestoneIdentity, history };
}
async function verificationEligibility(record: StoredExecution): Promise<{ revision: number; artifactDigest: string }> {
  if (record.lifecycle !== "completed" || record.status !== "AwaitingIndependentVerification") throw new VerificationError("NOT_ELIGIBLE", "Agent execution has not completed successfully", false);
  canonicalMilestoneId(record);
  const deliverable = record.finalDeliverable;
  if (!deliverable || !Array.isArray(deliverable.artifacts) || deliverable.artifacts.length === 0) throw new VerificationError("ARTIFACTS_UNAVAILABLE", "Final artifacts are not available", false);
  const digest = await computeArtifactDigest(deliverable.artifacts);
  if (digest !== deliverable.digest) throw new VerificationError("ARTIFACT_DIGEST_MISMATCH", "Stored final artifact digest does not match its canonical contents", false);
  const qa = record.qaAssessments.filter((assessment) => assessment.revision === deliverable.revision && assessment.digest === digest).sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
  if (!qa?.passed) throw new VerificationError("QA_NOT_APPROVED", "The final revision does not have a successful QA approval", false);
  const reports = record.validationReports.filter((report) => report.revision === deliverable.revision && report.artifactDigest === digest);
  if (reports.length === 0) throw new VerificationError("VALIDATION_NOT_AVAILABLE", "No deterministic validation report exists for the final artifact", false);
  if (reports.some((report) => report.summary.blockingFailures > 0 || report.rules.some((rule) => rule.blocking && rule.outcome === "fail"))) throw new VerificationError("BLOCKING_VALIDATION_FAILURE", "The final artifact has unresolved blocking deterministic validation failures", false);
  return { revision: deliverable.revision, artifactDigest: digest };
}
async function executeVerification(record: StoredExecution, body: Record<string, unknown>, criteria: VerificationCriteria): Promise<{ receipt: NonNullable<StoredExecution["verification"]>; revision: number; digest: string; criteriaFingerprint: string; implementationVersion: string }> {
  if (body.policy !== undefined) throw new VerificationError("POLICY_OVERRIDE_FORBIDDEN", "Verifier policy is controlled by the API", false);
  const eligible = await verificationEligibility(record);
  if (!record.finalDeliverable) throw new VerificationError("ARTIFACTS_UNAVAILABLE", "Final artifacts are not available", false);
  const projectId = record.onChainLinkage?.status === "confirmed" && record.onChainLinkage.onChainProjectId ? record.onChainLinkage.onChainProjectId : typeof record.projectId === "string" && /^\d+$/.test(record.projectId) ? record.projectId : "0";
  const milestoneId = assertMilestoneRequestMatches(record, body);
  const engine = new VerificationEngine({ policy: VERIFICATION_POLICY, implementationVersion: VERIFIER_IMPLEMENTATION_VERSION });
  const receipt = await engine.verify({ projectId, milestoneId, deliverable: record.finalDeliverable, expectedArtifactDigest: eligible.artifactDigest, criteria });
  return { receipt, revision: eligible.revision, digest: eligible.artifactDigest, criteriaFingerprint: JSON.stringify(criteria), implementationVersion: engine.implementationVersion };
}

export function buildApp(options: ApiOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });
  const databasePath = options.databasePath ?? resolveDatabasePath();
  const store = options.store ?? ExecutionStore.openSync(databasePath);
  const verifierSubmissionStore = options.verifierSubmissionStore ?? VerifierSubmissionStore.openSync(resolve(dirname(resolve(databasePath)), "verification-submissions.json"));
  let nearAdapter = options.nearAdapter;
  let nearConfigError: NearReadError | undefined;
  if (!nearAdapter) { try { nearAdapter = createNearAdapterFromEnvironment(); } catch (error) { nearConfigError = error instanceof NearReadError ? error : new NearReadError("INVALID_CONFIG", "NEAR configuration is invalid"); } }
  let backendVerifierService: BackendVerifierSubmissionService | undefined;
  const getBackendVerifierService = (): BackendVerifierSubmissionService => {
    if (backendVerifierService) return backendVerifierService;
    if (!options.verifierSigner || !nearAdapter) throw new Error("Backend verifier signing is not configured");
    const config = chainConfig();
    if (!config.authorizedVerifier || !config.verificationStorageDeposit) throw new Error("Backend verifier account and storage deposit are not configured");
    backendVerifierService = new BackendVerifierSubmissionService({ reader: nearAdapter, signer: options.verifierSigner, authorizedVerifier: config.authorizedVerifier, verificationStorageDeposit: config.verificationStorageDeposit, submissionStore: verifierSubmissionStore });
    return backendVerifierService;
  };
  const verificationInFlight = new Map<string, Promise<NonNullable<StoredExecution["verification"]>>>();
  const authChallenges = new Map<string, AuthChallenge>();
  const sessions = new Map<string, { accountId: string; expiresAt: number }>();
  app.addHook("onRequest", async (request, reply) => { const origin = options.frontendOrigin ?? process.env.FRONTEND_ORIGIN ?? "http://localhost:3000"; if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send(errorBody("CORS_ORIGIN_DENIED", "Origin is not allowed")); reply.header("access-control-allow-origin", origin).header("access-control-allow-credentials", "true").header("access-control-allow-methods", "GET,POST,OPTIONS").header("access-control-allow-headers", "content-type,x-attestra-verification-token"); const limit = rateLimit(request); if (!limit.allowed) return reply.header("retry-after", String(limit.retryAfterSeconds)).code(429).send(errorBody("RATE_LIMITED", "Too many requests")); });
  app.options("/*", async (_request, reply) => reply.code(204).send());
  app.get("/health", async () => healthResponse());
  app.get("/api/v1/auth/challenge", async (_request, reply) => { const challenge = newAuthChallenge(process.env.NEAR_AUTH_RECIPIENT ?? "attestra.app"); authChallenges.set(challenge.challengeId, challenge); return { challengeId: challenge.challengeId, message: challenge.message, recipient: challenge.recipient, nonce: challenge.nonce, expiresAt: new Date(challenge.expiresAt).toISOString() }; });
  app.post("/api/v1/auth/near", async (request, reply) => { try { const body = bodyObject(request.body ?? {}); const challengeId = typeof body.challengeId === "string" ? body.challengeId : ""; const challenge = authChallenges.get(challengeId); if (!challenge) return reply.code(401).send(errorBody("AUTH_CHALLENGE_INVALID", "Authentication challenge is invalid or expired")); const signed = signedMessageBody(body.signedMessage); verifySignedNearMessage(challenge, signed); if (!nearAdapter) return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", "NEAR Testnet adapter is unavailable; configure NEAR_ESCROW_CONTRACT_ACCOUNT, NEAR_NETWORK, and NEAR_RPC_URL for the API process")); const key = await nearAdapter.getAccessKey(signed.accountId, signed.publicKey); if (key.permission !== "FullAccess") return reply.code(403).send(errorBody("WALLET_KEY_NOT_AUTHORIZED", "The signed key is not a finalized FullAccess key for this account")); authChallenges.delete(challengeId); const token = randomUUID(); sessions.set(token, { accountId: signed.accountId, expiresAt: Date.now() + SESSION_TTL_MS }); const cookieMode = process.env.NODE_ENV === "production" ? "SameSite=None; Secure" : "SameSite=Lax"; reply.header("set-cookie", `${AUTH_COOKIE}=${token}; HttpOnly; Path=/; ${cookieMode}; Max-Age=${SESSION_TTL_MS / 1000}`); return { accountId: signed.accountId, network: "testnet", expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }; } catch (error) { return reply.code(401).send(errorBody("AUTHENTICATION_FAILED", error instanceof Error ? error.message : "Wallet authentication failed")); } });
  app.get("/api/v1/auth/me", async (request, reply) => { const accountId = authenticatedAccount(request, sessions); return accountId ? { authenticated: true, accountId, network: "testnet" } : reply.code(401).send(errorBody("AUTHENTICATION_REQUIRED", "No authenticated wallet session")); });
  app.post("/api/v1/auth/logout", async (request, reply) => { const token = parseCookie(request.headers.cookie, AUTH_COOKIE); if (token) sessions.delete(token); const cookieMode = process.env.NODE_ENV === "production" ? "SameSite=None; Secure" : "SameSite=Lax"; reply.header("set-cookie", `${AUTH_COOKIE}=; HttpOnly; Path=/; ${cookieMode}; Max-Age=0`); return { authenticated: false }; });
  app.get("/api/v1/near/config", async (_request, reply) => { try { const config = chainConfig(); return { network: config.network, contractAccountId: config.contractAccountId, authorizedVerifier: config.authorizedVerifier, projectStorageDeposit: config.projectStorageDeposit, milestoneStorageDeposit: config.milestoneStorageDeposit, verificationStorageDeposit: config.verificationStorageDeposit, approvalStorageDeposit: config.approvalStorageDeposit, settlementStorageDeposit: config.settlementStorageDeposit }; } catch (error) { return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", error instanceof Error ? error.message : "NEAR configuration is incomplete")); } });
  app.get("/api/v1/near/status", async (_request, reply) => {
    if (nearConfigError) return reply.code(503).send(errorBody(nearConfigError.code, nearConfigError.message));
    if (!nearAdapter) return { configured: false, readOnly: true, network: process.env.NEAR_NETWORK ?? "testnet", contractAccountId: process.env.NEAR_ESCROW_CONTRACT_ACCOUNT ?? null, reason: "NEAR contract account is not configured" };
    try { const [status, account] = await Promise.all([nearAdapter.status(), nearAdapter.accountState()]); return { configured: true, readOnly: true, network: status.network, rpcUrl: status.rpcUrl, contractAccountId: nearAdapter.contractAccountId, chainId: status.chainId, latestBlockHeight: status.latestBlockHeight, account }; } catch (error) { const nearError = error instanceof NearReadError ? error : new NearReadError("RPC_ERROR", "NEAR status query failed"); return reply.code(503).send(errorBody(nearError.code, nearError.message)); }
  });
  app.get("/api/v1/near/verifier-status", async () => ({ configured: Boolean(options.verifierSigner), signerAccountId: options.verifierSigner?.accountId ?? null, configurationError: options.verifierSignerConfigurationError ?? null, submissionLedger: "persistent-local-single-writer" }));
  app.post("/api/v1/executions", async (request, reply) => {
    if (process.env.NODE_ENV !== "test" && !(options.demoMode && process.env.NODE_ENV !== "production") && !requireAuthenticated(request, reply, sessions)) return;
    let input: ProjectExecutionRequest; const executionId = `exec-${randomUUID()}`;
    try { input = executionRequest(request.body, executionId); } catch (error) { return reply.code(400).send(errorBody("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request")); }
    const record = initialRecord(input, executionId, authenticatedAccount(request, sessions) ?? undefined); await store.create(record);
    void (async () => { record.lifecycle = "running"; await store.update(record); try { const provider = readProvider(options); const orchestrator = new Orchestrator({ researchAgent: new ResearchAgent(provider), builderAgent: new BuilderAgent(provider), qaAgent: new QaAgent(provider) }); const result = await orchestrator.execute(input); Object.assign(record, result, { lifecycle: "completed" }); await store.update(record); } catch (error) { await store.update(appendFailure(record, error instanceof Error && "code" in error ? String(error.code) : "EXECUTION_START_FAILED", error instanceof Error ? error.message : "Execution failed")); } })().catch(() => undefined);
    return reply.code(202).send({ executionId, status: "Created", lifecycle: "queued" });
  });
  app.get("/api/v1/executions", async (request, reply) => { const query = request.query as { offset?: string; limit?: string }; const offset = Number(query.offset ?? 0); const limit = Number(query.limit ?? 20); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) return reply.code(400).send(errorBody("INVALID_PAGINATION", "offset and limit must be positive integers")); return { items: store.list(offset, Math.min(MAX_PAGE_LIMIT, limit)).map(summary), offset, limit: Math.min(MAX_PAGE_LIMIT, limit) }; });
  app.get("/api/v1/executions/:executionId", async (request, reply) => { const record = store.get((request.params as { executionId: string }).executionId); return record ? record : reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); });
  app.get("/api/v1/executions/:executionId/events", async (request, reply) => { const record = store.get((request.params as { executionId: string }).executionId); return record ? { executionId: record.executionId, events: record.history } : reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); });
  app.get("/api/v1/executions/:executionId/artifacts", async (request, reply) => { const record = store.get((request.params as { executionId: string }).executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); if (!record.finalDeliverable) return reply.code(409).send(errorBody("ARTIFACTS_UNAVAILABLE", "Execution has no final deliverable")); const bytes = record.finalDeliverable.artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.content), 0); if (bytes > MAX_ARTIFACT_RESPONSE_BYTES) return reply.code(413).send(errorBody("ARTIFACT_RESPONSE_TOO_LARGE", "Artifact response exceeds the API limit")); return { executionId: record.executionId, digest: record.finalDeliverable.digest, revision: record.finalDeliverable.revision, artifacts: record.finalDeliverable.artifacts }; });
  app.get("/api/v1/executions/:executionId/chain", async (request, reply) => { const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); return { executionId, linkage: record.onChainLinkage ?? { executionId, network: "testnet", contractAccountId: "", offChainMilestoneId: record.milestoneIdentity?.milestoneId ?? "", status: "unlinked" }, confirmed: record.onChainLinkage?.status === "confirmed" }; });
  app.get("/api/v1/executions/:executionId/chain/state", async (request, reply) => {
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); const linkage = record.onChainLinkage;
    if (!linkage || linkage.status !== "confirmed") return { executionId, confirmed: false, state: null, reason: "Execution has no confirmed on-chain linkage" };
    if (!nearAdapter) return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", "A read-only NEAR adapter is not configured"));
    if (nearAdapter.contractAccountId !== linkage.contractAccountId || nearAdapter.network !== linkage.network) return reply.code(409).send(errorBody("CHAIN_CONFIGURATION_MISMATCH", "Configured NEAR network or contract account does not match the linkage"));
    let projectId: number; let milestoneId: number; try { projectId = safeChainId(linkage.onChainProjectId); milestoneId = safeChainId(linkage.onChainMilestoneId); } catch (error) { const nearError = error instanceof NearReadError ? error : new NearReadError("INVALID_CONFIG", "Invalid confirmed linkage"); return reply.code(409).send(errorBody(nearError.code, nearError.message)); }
    try { const [project, milestone] = await Promise.all([nearAdapter.getProject(projectId), nearAdapter.getMilestone(projectId, milestoneId)]); if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget) return reply.code(502).send(errorBody("CHAIN_LINKAGE_MISMATCH", "Read-only chain state does not match the confirmed linkage")); return { executionId, confirmed: true, linkage, state: { project, milestone } }; } catch (error) { const nearError = error instanceof NearReadError ? error : new NearReadError("RPC_ERROR", "NEAR state query failed"); return reply.code(503).send(errorBody(nearError.code, nearError.message)); }
  });
  app.post("/api/v1/executions/:executionId/chain/attach", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (!record.paymentEligible) return reply.code(409).send(errorBody("PAYMENT_ELIGIBILITY_REQUIRED", "Only payment-eligible executions may attach an existing milestone"));
    if (!nearAdapter) return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", "A read-only NEAR adapter is not configured"));
    try {
      const body = bodyObject(request.body ?? {}); const projectId = safeChainId(typeof body.projectId === "string" ? body.projectId : undefined); const milestoneId = safeChainId(typeof body.milestoneId === "string" ? body.milestoneId : undefined); const config = chainConfig();
      if (nearAdapter.network !== config.network || nearAdapter.contractAccountId !== config.contractAccountId) throw new Error("NEAR adapter does not match the configured testnet contract");
      const [project, milestone] = await Promise.all([nearAdapter.getProject(projectId), nearAdapter.getMilestone(projectId, milestoneId)]);
      if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId) throw new Error("The requested project or milestone does not exist");
      if (project.owner !== accountId) throw new Error("Authenticated wallet is not the project owner");
      if (milestone.status !== "InProgress") throw new Error("Only an InProgress milestone may be attached for payment-backed execution");
      await store.attachExistingOnChainLinkage(executionId, { executionId, network: "testnet", contractAccountId: config.contractAccountId, onChainProjectId: String(projectId), onChainMilestoneId: String(milestoneId), offChainMilestoneId: record.milestoneIdentity?.milestoneId ?? "", ownerAccountId: project.owner, recipientAccountId: milestone.recipient, milestoneBudget: milestone.budget, status: "confirmed" });
      return { executionId, confirmed: true, linkage: store.get(executionId)?.onChainLinkage, state: { project, milestone } };
    } catch (error) { return reply.code(409).send(errorBody("CHAIN_ATTACHMENT_INVALID", error instanceof Error ? error.message : "Existing chain state could not be attached")); }
  });
  app.post("/api/v1/executions/:executionId/chain/intent", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (!nearAdapter) return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", "A read-only NEAR adapter is not configured"));
    try {
      const body = bodyObject(request.body ?? {}); const operation = chainOperation(body.operation); const linked = await linkedChainState(record, nearAdapter); const config = chainConfig();
      const projectId = linked.project.projectId; const milestoneId = linked.milestone.milestoneId;
      if (operation === "submit_verification") { if (!config.authorizedVerifier || accountId !== config.authorizedVerifier) throw new Error("Authenticated wallet is not the authorized verifier"); if (linked.milestone.status !== "InProgress") throw new Error("Milestone must be InProgress before verification submission"); if (linked.linkage.verificationTransactionHash) throw new Error("Verification is already linked"); const receipt = await latestPassingReceipt(record, projectId, milestoneId); return { ...chainIntent(operation, linked.linkage, projectId, milestoneId, undefined, receipt, config), projectId, milestoneId, expectedVerifier: config.authorizedVerifier, receiptId: receipt.receiptId, artifactDigest: receipt.artifactDigest, expectedRecipient: linked.milestone.recipient, expectedBudget: linked.milestone.budget }; }
      if (linked.project.owner !== accountId) throw new Error("Authenticated wallet is not the project owner");
      if (operation === "fund") return { ...chainIntent(operation, linked.linkage, projectId, milestoneId, positiveYocto(body.amount)), projectId, milestoneId, expectedOwner: accountId };
      if (operation === "activate") { if (linked.milestone.status !== "Created") throw new Error("Milestone must be Created before activation"); if (BigInt(linked.project.availableBalance) < BigInt(linked.milestone.budget)) throw new Error("Project does not have enough available funds"); }
      if (operation === "start" && linked.milestone.status !== "Funded") throw new Error("Milestone must be Funded before it can start");
      if (operation === "approve") { const receipt = await latestPassingReceipt(record, projectId, milestoneId); if (linked.milestone.status !== "VerificationPassed" || !linked.milestone.verification || linked.milestone.verification.result !== "Passed" || linked.milestone.verification.receiptId !== receipt.receiptId || linked.milestone.verification.deliverableDigest !== receipt.artifactDigest || linked.milestone.verification.verifier !== config.authorizedVerifier) throw new Error("Finalized on-chain verification does not match the passing receipt"); if (linked.linkage.approvalTransactionHash) throw new Error("Approval is already linked"); return { ...chainIntent(operation, linked.linkage, projectId, milestoneId, undefined, receipt, config), projectId, milestoneId, expectedOwner: accountId, receiptId: receipt.receiptId }; }
      if (operation === "settle") { if (linked.milestone.status !== "OwnerApproved") throw new Error("Milestone must be OwnerApproved before settlement"); if (linked.project.pendingPayment !== undefined) throw new Error("A payment is already pending"); if (linked.milestone.approvalReceiptId !== (await latestPassingReceipt(record, projectId, milestoneId)).receiptId) throw new Error("On-chain approval does not match the passing receipt"); return { ...chainIntent(operation, linked.linkage, projectId, milestoneId, undefined, undefined, config), projectId, milestoneId, expectedOwner: accountId, expectedRecipient: linked.milestone.recipient, expectedBudget: linked.milestone.budget };
      }
      return { ...chainIntent(operation, linked.linkage, projectId, milestoneId), projectId, milestoneId, expectedOwner: accountId, expectedRecipient: linked.milestone.recipient, expectedBudget: linked.milestone.budget };
    } catch (error) { return reply.code(409).send(errorBody("CHAIN_INTENT_INVALID", error instanceof Error ? error.message : "Chain operation is not currently allowed")); }
  });
  app.post("/api/v1/executions/:executionId/chain/submit-verification", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (record.onChainLinkage?.ownerAccountId !== accountId) return reply.code(403).send(errorBody("OWNER_AUTHORIZATION_REQUIRED", "Only the linked project owner may request backend verification submission"));
    try { if (!nearAdapter || !options.verifierSigner) throw new Error("Backend verifier signing is not configured"); const result = await getBackendVerifierService().submit(record); return { ...result, executionId, submissionMode: "backend-verifier" }; } catch (error) { const message = error instanceof Error ? error.message : "Backend verifier submission failed"; return reply.code(message === "Backend verifier signing is not configured" ? 503 : 409).send(errorBody("BACKEND_VERIFIER_SUBMISSION_FAILED", message)); }
  });
  app.post("/api/v1/executions/:executionId/chain/submit-verification/reconcile", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (record.onChainLinkage?.ownerAccountId !== accountId) return reply.code(403).send(errorBody("OWNER_AUTHORIZATION_REQUIRED", "Only the linked project owner may reconcile backend verification"));
    try { const body = bodyObject(request.body ?? {}); if (typeof body.transactionHash !== "string" || !body.transactionHash) throw new Error("transactionHash is required"); if (!nearAdapter || !options.verifierSigner) throw new Error("Backend verifier signing is not configured"); const result = await getBackendVerifierService().reconcile(record, body.transactionHash); if (result.state === "finalized") await store.recordLifecycleTransaction(executionId, "verificationTransactionHash", result.transactionHash!); return { ...result, executionId, submissionMode: "backend-verifier" }; } catch (error) { const message = error instanceof Error ? error.message : "Backend verifier reconciliation failed"; return reply.code(message === "Backend verifier signing is not configured" ? 503 : 409).send(errorBody("BACKEND_VERIFIER_RECONCILIATION_FAILED", message)); }
  });
  app.post("/api/v1/executions/:executionId/chain/reconcile", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (!nearAdapter) return reply.code(503).send(errorBody("NEAR_NOT_CONFIGURED", "A read-only NEAR adapter is not configured"));
    try {
      const body = bodyObject(request.body ?? {}); const operation = chainOperation(body.operation); if (typeof body.transactionHash !== "string" || !body.transactionHash) throw new Error("transactionHash is required");
      const linked = await linkedChainState(record, nearAdapter); const config = chainConfig(); const projectId = linked.project.projectId; const milestoneId = linked.milestone.milestoneId; const verifierOperation = operation === "submit_verification";
      if (verifierOperation) { if (!config.authorizedVerifier || accountId !== config.authorizedVerifier) throw new Error("Authenticated wallet is not the authorized verifier"); } else if (linked.project.owner !== accountId) throw new Error("Transaction signer is not the project owner");
      const methodName = operation === "fund" ? "fund_project" : operation === "activate" ? "activate_milestone" : operation === "start" ? "start_milestone" : operation === "submit_verification" ? "submit_verification" : operation === "approve" ? "approve_milestone" : "settle_milestone";
      const evidence = successfulFunctionCall(await nearAdapter.getTransaction(body.transactionHash, accountId), methodName); const transaction = evidence as unknown as Awaited<ReturnType<NearReadonlyAdapter["getTransaction"]>>; if (transaction.signerId !== accountId) throw new Error("Transaction signer does not match the authenticated wallet");
      const action = transaction.actions[0]; const args = evidence.args as Record<string, unknown>; const receipt = operation === "submit_verification" || operation === "approve" || operation === "settle" ? await latestPassingReceipt(record, projectId, milestoneId) : undefined;
      const expectedDeposit = operation === "fund" ? positiveYocto(body.amount) : operation === "activate" || operation === "start" ? ONE_YOCTO : operation === "submit_verification" ? requiredDeposit(config.verificationStorageDeposit, "Verification storage deposit") : operation === "approve" ? requiredDeposit(config.approvalStorageDeposit, "Approval storage deposit") : requiredDeposit(config.settlementStorageDeposit, "Settlement storage deposit");
      if (action?.deposit !== expectedDeposit) throw new Error("Attached deposit does not match the server-issued intent");
      if (args.project_id !== projectId || (operation !== "fund" && args.milestone_id !== milestoneId)) throw new Error("Transaction arguments do not match the server-issued intent");
      if (operation === "submit_verification") { if (args.deliverable_digest !== receipt?.artifactDigest || args.receipt_id !== receipt?.receiptId || args.result !== "Passed") throw new Error("Verification transaction does not match the passing receipt"); }
      if (operation === "approve" && args.receipt_id !== receipt?.receiptId) throw new Error("Approval transaction does not match the finalized verification");
      const finalState = await linkedChainState(record, nearAdapter);
      if (operation === "activate" && (finalState.milestone.status !== "Funded" || BigInt(finalState.project.reservedBalance) < BigInt(finalState.milestone.budget))) throw new Error("Finalized state does not show an activated funded milestone");
      if (operation === "start" && finalState.milestone.status !== "InProgress") throw new Error("Finalized state does not show an in-progress milestone");
      if (operation === "submit_verification" && (finalState.milestone.status !== "VerificationPassed" || !finalState.milestone.verification || finalState.milestone.verification.receiptId !== receipt?.receiptId || finalState.milestone.verification.deliverableDigest !== receipt?.artifactDigest || finalState.milestone.verification.verifier !== config.authorizedVerifier)) throw new Error("Finalized state does not show the submitted passing verification");
      if (operation === "approve" && (finalState.milestone.status !== "OwnerApproved" || finalState.milestone.approvalReceiptId !== receipt?.receiptId)) throw new Error("Finalized state does not show owner approval for the passing receipt");
      if (operation === "settle" && finalState.milestone.status !== "PaymentPending" && finalState.milestone.status !== "Paid") throw new Error("Finalized state does not show a pending or completed payment");
      const field = operation === "fund" ? "fundingTransactionHash" : operation === "activate" ? "activationTransactionHash" : operation === "start" ? "startTransactionHash" : operation === "submit_verification" ? "verificationTransactionHash" : operation === "approve" ? "approvalTransactionHash" : "settlementTransactionHash";
      const saved = store.get(executionId)?.onChainLinkage;
      if (!(operation === "settle" && saved?.settlementTransactionHashes?.includes(transaction.hash))) await store.recordLifecycleTransaction(executionId, field, transaction.hash);
      return { executionId, confirmed: true, operation, transactionHash: transaction.hash, paymentStatus: operation === "settle" ? finalState.milestone.status : undefined, linkage: store.get(executionId)?.onChainLinkage, state: { project: finalState.project, milestone: finalState.milestone } };
    } catch (error) { return reply.code(409).send(errorBody("CHAIN_EVIDENCE_INVALID", error instanceof Error ? error.message : "Finalized lifecycle evidence is invalid")); }
  });
  app.post("/api/v1/executions/:executionId/chain/project", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    if (record.onChainLinkage?.status === "confirmed" || record.onChainLinkage?.onChainProjectId) return reply.code(409).send(errorBody("CHAIN_LINKAGE_EXISTS", "This execution already has an on-chain project linkage"));
    try { const body = bodyObject(request.body ?? {}); if (typeof body.transactionHash !== "string" || !body.transactionHash) throw new Error("transactionHash is required"); if (!nearAdapter) throw new Error("NEAR read-only adapter is not configured"); const tx = await nearAdapter.getTransaction(body.transactionHash, accountId); const evidence = successfulFunctionCall(tx, "create_project"); if (tx.signerId !== accountId) throw new Error("Project transaction signer does not match the authenticated wallet"); const projectId = decodeU64Success((tx.status as Record<string, unknown>).SuccessValue); const project = await nearAdapter.getProject(projectId); if (!project || project.owner !== accountId || project.projectId !== projectId) throw new Error("Finalized project state does not match the authenticated owner"); await store.mergeOnChainLinkage(executionId, { contractAccountId: nearAdapter.contractAccountId, onChainProjectId: String(projectId), ownerAccountId: project.owner, projectCreationTransactionHash: tx.hash, status: "pending", requestedAt: now() }); return { executionId, confirmed: false, linkage: store.get(executionId)?.onChainLinkage, state: { project } }; } catch (error) { return reply.code(409).send(errorBody("CHAIN_EVIDENCE_INVALID", error instanceof Error ? error.message : "Project transaction evidence is invalid")); }
  });
  app.post("/api/v1/executions/:executionId/chain/milestone", async (request, reply) => {
    const accountId = requireAuthenticated(request, reply, sessions); if (!accountId) return;
    const executionId = (request.params as { executionId: string }).executionId; const record = store.get(executionId); const linkage = record?.onChainLinkage; if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); if (!linkage?.onChainProjectId || linkage.status !== "pending") return reply.code(409).send(errorBody("PROJECT_LINKAGE_REQUIRED", "Confirm the project transaction before registering a milestone"));
    try { const body = bodyObject(request.body ?? {}); if (typeof body.transactionHash !== "string" || !body.transactionHash) throw new Error("transactionHash is required"); if (!nearAdapter) throw new Error("NEAR read-only adapter is not configured"); const tx = await nearAdapter.getTransaction(body.transactionHash, accountId); const evidence = successfulFunctionCall(tx, "register_milestone"); if (tx.signerId !== accountId) throw new Error("Milestone transaction signer does not match the authenticated wallet"); const args = evidence.args as Record<string, unknown>; if (args.project_id !== Number(linkage.onChainProjectId) || typeof args.recipient !== "string" || typeof args.budget !== "string" || !/^\d+$/.test(args.budget) || !Array.isArray(args.dependencies) || args.dependencies.length !== 0) throw new Error("Milestone transaction arguments do not match the expected first milestone flow"); const milestoneId = decodeU64Success((tx.status as Record<string, unknown>).SuccessValue); const milestone = await nearAdapter.getMilestone(Number(linkage.onChainProjectId), milestoneId); if (!milestone || milestone.recipient !== args.recipient || milestone.budget !== args.budget || milestone.milestoneId !== milestoneId) throw new Error("Finalized milestone state does not match the signed transaction"); await store.mergeOnChainLinkage(executionId, { onChainMilestoneId: String(milestoneId), milestoneRegistrationTransactionHash: tx.hash, recipientAccountId: milestone.recipient, milestoneBudget: milestone.budget, status: "pending", confirmedAt: now() }); await store.confirmOnChainLinkage(executionId, nearAdapter); return { executionId, confirmed: true, linkage: store.get(executionId)?.onChainLinkage, state: { milestone } }; } catch (error) { return reply.code(409).send(errorBody("CHAIN_EVIDENCE_INVALID", error instanceof Error ? error.message : "Milestone transaction evidence is invalid")); }
  });
  app.post("/api/v1/executions/:executionId/verify", async (request, reply) => {
    const executionId = (request.params as { executionId: string }).executionId;
    const record = store.get(executionId);
    if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found"));
    const sessionAccountId = authenticatedAccount(request, sessions);
    const browserAuthorized = Boolean(sessionAccountId && (record.createdByAccountId === sessionAccountId || record.onChainLinkage?.ownerAccountId === sessionAccountId));
    if (!verificationWriteAuthorized(request, options) && !browserAuthorized) return reply.code(403).send(errorBody("VERIFICATION_WRITE_UNAUTHORIZED", "Verification writes require the execution owner session or an explicitly configured operator authorization"));
    let body: Record<string, unknown>;
    try { body = bodyObject(request.body ?? {}); } catch (error) { return reply.code(400).send(errorBody("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request")); }
    if (body.policy !== undefined) return reply.code(400).send(errorBody("POLICY_OVERRIDE_FORBIDDEN", "Verifier policy is controlled by the API"));
    if (body.verifierImplementationVersion !== undefined) return reply.code(400).send(errorBody("VERIFIER_CONFIGURATION_FORBIDDEN", "Verifier implementation version is controlled by the API"));
    let reason: string | undefined;
    try { reason = reverificationReason(body); } catch (error) { const code = error instanceof VerificationError ? error.code : "INVALID_REVERIFICATION_REASON"; return reply.code(400).send(errorBody(code, error instanceof Error ? error.message : "Re-verification reason is invalid")); }
    try { assertMilestoneRequestMatches(record, body); } catch (error) { const code = error instanceof VerificationError ? error.code : "MILESTONE_ID_UNRESOLVED"; return reply.code(409).send(errorBody(code, error instanceof Error ? error.message : "Milestone identity is unavailable")); }
    const currentDigest = record.finalDeliverable?.digest;
    const currentRevision = record.finalDeliverable?.revision;
    const existing = record.verificationState;
    const latest = record.verificationHistory?.at(-1) ?? (existing?.receipt ? existing : undefined);
    if (existing?.status === "in_progress") return reply.code(409).send(errorBody("VERIFICATION_IN_PROGRESS", "Verification is already in progress for this execution"));
    if (!record.verificationState && !record.verification) {
      // A failed eligibility check is not a completed verification attempt. Re-run the normal eligibility gate below.
    } else if (latest?.receipt && latest.artifactDigest === currentDigest && latest.revision === currentRevision && latest.policyVersion === VERIFICATION_POLICY.version && latest.verifierImplementationVersion === VERIFIER_IMPLEMENTATION_VERSION && !reason) return reply.code(200).send(latest.receipt);
    if (latest && (record.verificationState || record.verification)) {
      if (!reason) return reply.code(400).send(errorBody("REVERIFICATION_REASON_REQUIRED", "An explicit reason is required to request re-verification"));
      const versionChanged = latest.policyVersion !== VERIFICATION_POLICY.version || latest.verifierImplementationVersion !== VERIFIER_IMPLEMENTATION_VERSION;
      const recoverableInterrupted = latest.status === "error" && latest.failure?.code === "VERIFICATION_PROCESS_INTERRUPTED";
      if (!versionChanged && !recoverableInterrupted) return reply.code(409).send(errorBody("REVERIFICATION_NOT_ELIGIBLE", "A new re-verification requires a changed server-controlled policy or verifier implementation"));
    }
    let criteria: VerificationCriteria; let criteriaFingerprint: string;
    try { criteria = authoritativeVerificationCriteria(record, body); criteriaFingerprint = JSON.stringify(criteria); } catch (error) { const code = error instanceof VerificationError ? error.code : "INVALID_VERIFICATION_CRITERIA"; return reply.code(400).send(errorBody(code, error instanceof Error ? error.message : "Verification criteria are invalid")); }
    const active = verificationInFlight.get(executionId);
    if (active) return reply.code(409).send(errorBody("VERIFICATION_IN_PROGRESS", "Verification is already in progress for this execution"));
    const operation = (async () => {
      let state: PersistedVerification = { attemptId: randomUUID(), status: "in_progress", executionId, revision: currentRevision ?? 0, artifactDigest: currentDigest ?? "", policyVersion: VERIFICATION_POLICY.version, verifierImplementationVersion: VERIFIER_IMPLEMENTATION_VERSION, requestedAt: now(), reVerificationReason: reason, criteriaFingerprint };
      try {
        const eligible = await verificationEligibility(record);
        state = { ...state, revision: eligible.revision, artifactDigest: eligible.artifactDigest };
        record.verificationState = state; record.verificationHistory = [...(record.verificationHistory ?? []), state]; record.verificationRequestedAt = state.requestedAt; await store.update(record);
        const result = await executeVerification(record, body, criteria);
        record.verification = result.receipt;
        const completed: VerificationAttempt = { ...state, status: result.receipt.result === "Passed" ? "verified" : "rejected", completedAt: now(), revision: result.revision, artifactDigest: result.digest, result: result.receipt.result, receipt: result.receipt, criteriaFingerprint: result.criteriaFingerprint, verifierImplementationVersion: result.implementationVersion };
        record.verificationState = completed; record.verificationHistory = (record.verificationHistory ?? []).map((attempt) => attempt.attemptId === completed.attemptId ? completed : attempt);
        await store.update(record);
        return result.receipt;
      } catch (error) {
        const failure = error instanceof VerificationError ? { code: error.code, message: error.message, retryable: error.retryable, stage: error.code.startsWith("LLM") ? "llm" as const : "receipt" as const } : { code: "VERIFICATION_ERROR", message: error instanceof Error ? error.message : "Verification failed", retryable: true, stage: "receipt" as const };
        const failed: VerificationAttempt = { ...state, status: "error", completedAt: now(), failure };
        record.verificationState = failed; record.verificationHistory = (record.verificationHistory ?? []).map((attempt) => attempt.attemptId === failed.attemptId ? failed : attempt);
        await store.update(record);
        throw error;
      }
    })();
    verificationInFlight.set(executionId, operation);
    try { const receipt = await operation; return reply.code(201).send(receipt); } catch (error) { const code = error instanceof VerificationError ? error.code : error instanceof AgentError ? error.code : "VERIFICATION_FAILED"; return reply.code(code === "LLM_UNAVAILABLE" || code === "PROVIDER_CONFIG" ? 503 : code === "VERIFICATION_ERROR" ? 500 : 409).send(errorBody(code, error instanceof Error ? error.message : "Verification failed")); } finally { if (verificationInFlight.get(executionId) === operation) verificationInFlight.delete(executionId); }
  });
  app.get("/api/v1/executions/:executionId/verification/attempts/:attemptId", async (request, reply) => { const params = request.params as { executionId: string; attemptId: string }; const record = store.get(params.executionId); if (!record) return reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); const attempt = record.verificationHistory?.find((item) => item.attemptId === params.attemptId); return attempt ? attempt : reply.code(404).send(errorBody("NOT_FOUND", "Verification attempt not found")); });
  app.get("/api/v1/executions/:executionId/verification", async (request, reply) => { const record = store.get((request.params as { executionId: string }).executionId); return record ? verificationResponse(record) : reply.code(404).send(errorBody("NOT_FOUND", "Execution not found")); });
  return app;
}
function summary(record: StoredExecution): Record<string, unknown> { return { executionId: record.executionId, projectId: record.projectId, status: record.status, lifecycle: record.lifecycle, digest: record.finalDeliverable?.digest, createdAt: record.createdAt, updatedAt: record.updatedAt, failure: record.failure }; }
