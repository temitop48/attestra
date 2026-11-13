import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProjectExecution } from "@attestra/orchestrator";
import type { NearReadonlyAdapter } from "@attestra/near-readonly";
import type { VerificationDecision, VerificationFailure, VerificationReceipt } from "@attestra/verification";

export type ExecutionLifecycle = "queued" | "running" | "completed";
export type PersistedVerificationStatus = "in_progress" | "verified" | "rejected" | "error";
export type MilestoneIdentity = { status: "authoritative" | "unresolved" | "conflict"; milestoneId?: string; source: "server_assigned" | "execution_record" | "historical_receipt" | "unresolved" | "conflicting_records"; onChainLinked: false };
export type VerificationAttempt = { attemptId: string; executionId: string; status: PersistedVerificationStatus; revision: number; artifactDigest: string; policyVersion: string; verifierImplementationVersion?: string; requestedAt: string; completedAt?: string; result?: VerificationDecision; reVerificationReason?: string; criteriaFingerprint?: string; receipt?: VerificationReceipt; failure?: VerificationFailure };
export type PersistedVerification = VerificationAttempt;
export type OnChainLinkageStatus = "unlinked" | "pending" | "confirmed" | "conflict";
export type OnChainLinkage = {
  executionId: string;
  network: "testnet";
  contractAccountId: string;
  onChainProjectId?: string;
  onChainMilestoneId?: string;
  offChainMilestoneId: string;
  recipientAccountId?: string;
  ownerAccountId?: string;
  milestoneBudget?: string;
  projectCreationTransactionHash?: string;
  milestoneRegistrationTransactionHash?: string;
  fundingTransactionHash?: string;
  activationTransactionHash?: string;
  startTransactionHash?: string;
  verificationTransactionHash?: string;
  approvalTransactionHash?: string;
  settlementTransactionHash?: string;
  settlementTransactionHashes?: string[];
  status: OnChainLinkageStatus;
  requestedAt?: string;
  confirmedAt?: string;
};
export type StoredExecution = ProjectExecution & { lifecycle: ExecutionLifecycle; createdByAccountId?: string; verification?: VerificationReceipt; verificationState?: PersistedVerification; verificationHistory?: VerificationAttempt[]; verificationRequestedAt?: string; milestoneId?: string; milestoneIdentity?: MilestoneIdentity; onChainLinkage?: OnChainLinkage };
export interface ExecutionStoreLike {
  create(record: StoredExecution): Promise<void>;
  get(executionId: string): StoredExecution | undefined;
  findExecutionByTransactionHash(hash: string, excludeExecutionId?: string): string | undefined;
  list(offset: number, limit: number): StoredExecution[];
  update(record: StoredExecution): Promise<void>;
  setOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void>;
  mergeOnChainLinkage(executionId: string, patch: Partial<OnChainLinkage>): Promise<void>;
  recordLifecycleTransaction(executionId: string, field: "fundingTransactionHash" | "activationTransactionHash" | "startTransactionHash" | "verificationTransactionHash" | "approvalTransactionHash" | "settlementTransactionHash", transactionHash: string): Promise<void>;
  confirmOnChainLinkage(executionId: string, adapter: NearReadonlyAdapter): Promise<void>;
  attachExistingOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void>;
}
type StoreFile = { version: 1; executions: StoredExecution[] };
const MAX_RECORDS = 1_000;

export class ExecutionStore implements ExecutionStoreLike {
  private readonly records = new Map<string, StoredExecution>();
  private writeChain: Promise<void> = Promise.resolve();
  private constructor(filePath: string) { this.filePath = resolve(filePath); }
  private readonly filePath: string;

  static async open(filePath: string): Promise<ExecutionStore> { const store = new ExecutionStore(filePath); await store.load(); return store; }
  static openSync(filePath: string): ExecutionStore { const store = new ExecutionStore(filePath); if (existsSync(filePath)) { const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoreFile; if (parsed.version !== 1 || !Array.isArray(parsed.executions)) throw new Error("Unsupported execution store format"); for (const record of parsed.executions.slice(-MAX_RECORDS)) store.records.set(record.executionId, normalizeRecord(record)); } if (store.markInterrupted()) void store.persist().catch(() => undefined); return store; }
  private async load(): Promise<void> {
    try { const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoreFile; if (parsed.version !== 1 || !Array.isArray(parsed.executions)) throw new Error("Unsupported execution store format"); for (const record of parsed.executions.slice(-MAX_RECORDS)) this.records.set(record.executionId, normalizeRecord(record)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const changed = this.markInterrupted();
    if (changed) await this.persist();
  }
  private markInterrupted(): boolean { let changed = false; for (const record of this.records.values()) { if (record.lifecycle === "running" || record.lifecycle === "queued") { record.lifecycle = "completed"; record.status = "Failed"; record.failure = { code: "PROCESS_RESTART_INTERRUPTED", message: "Execution was interrupted by an API process restart and requires a new execution.", stage: "orchestration", retryable: true }; record.updatedAt = new Date().toISOString(); changed = true; } if (record.verificationState?.status === "in_progress") { const completedAt = new Date().toISOString(); const failure = { code: "VERIFICATION_PROCESS_INTERRUPTED", message: "Verification was interrupted by an API process restart and may be retried.", retryable: true, stage: "receipt" as const }; record.verificationState = { ...record.verificationState, status: "error", completedAt, failure }; record.verificationHistory = (record.verificationHistory ?? []).map((attempt) => attempt.attemptId === record.verificationState?.attemptId ? { ...attempt, status: "error" as const, completedAt, failure } : attempt); changed = true; } } return changed; }
  async create(record: StoredExecution): Promise<void> { if (this.records.has(record.executionId)) throw new Error("Execution already exists"); if (!record.milestoneId) { record.milestoneId = this.nextMilestoneId(record.projectId); record.milestoneIdentity = { status: "authoritative", milestoneId: record.milestoneId, source: "server_assigned", onChainLinked: false }; } else if (!record.milestoneIdentity) record.milestoneIdentity = { status: "authoritative", milestoneId: record.milestoneId, source: "execution_record", onChainLinked: false }; record.onChainLinkage = record.onChainLinkage ? { ...record.onChainLinkage, executionId: record.executionId, offChainMilestoneId: record.milestoneIdentity.milestoneId ?? "" } : { executionId: record.executionId, network: "testnet", contractAccountId: "", offChainMilestoneId: record.milestoneIdentity.milestoneId ?? "", status: "unlinked" }; if (this.records.size >= MAX_RECORDS) this.records.delete(this.records.keys().next().value as string); this.records.set(record.executionId, record); await this.persist(); }
  get(executionId: string): StoredExecution | undefined { return this.records.get(executionId); }
  findExecutionByTransactionHash(hash: string, excludeExecutionId?: string): string | undefined { for (const record of this.records.values()) { if (record.executionId === excludeExecutionId) continue; const linkage = record.onChainLinkage; if (linkage?.projectCreationTransactionHash === hash || linkage?.milestoneRegistrationTransactionHash === hash || linkage?.fundingTransactionHash === hash || linkage?.activationTransactionHash === hash || linkage?.startTransactionHash === hash || linkage?.verificationTransactionHash === hash || linkage?.approvalTransactionHash === hash || linkage?.settlementTransactionHash === hash || linkage?.settlementTransactionHashes?.includes(hash)) return record.executionId; } return undefined; }
  list(offset: number, limit: number): StoredExecution[] { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit); }
  async update(record: StoredExecution): Promise<void> { if (!this.records.has(record.executionId)) throw new Error("Execution not found"); this.records.set(record.executionId, record); await this.persist(); }
  async setOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void> {
    const record = this.records.get(executionId);
    if (!record) throw new Error("Execution not found");
    if (linkage.executionId !== executionId || linkage.network !== "testnet" || linkage.offChainMilestoneId !== record.milestoneIdentity?.milestoneId) throw new Error("On-chain linkage does not match the execution");
    if (record.onChainLinkage && record.onChainLinkage.status !== "unlinked") throw new Error("On-chain linkage already exists");
    if (linkage.status === "confirmed") throw new Error("Confirmed linkage requires read-only chain evidence");
    record.onChainLinkage = { ...linkage };
    await this.persist();
  }
  async mergeOnChainLinkage(executionId: string, patch: Partial<OnChainLinkage>): Promise<void> {
    const record = this.records.get(executionId);
    if (!record) throw new Error("Execution not found");
    const transactionHash = patch.projectCreationTransactionHash ?? patch.milestoneRegistrationTransactionHash ?? patch.fundingTransactionHash ?? patch.activationTransactionHash ?? patch.startTransactionHash ?? patch.verificationTransactionHash ?? patch.approvalTransactionHash ?? patch.settlementTransactionHash;
    if (transactionHash) {
      const existingExecutionId = this.findExecutionByTransactionHash(transactionHash, executionId);
      if (existingExecutionId) throw new Error("Transaction hash is already linked to another execution");
    }
    const current = record.onChainLinkage;
    if (!current || current.status === "unlinked") { await this.setOnChainLinkage(executionId, { executionId, network: "testnet", contractAccountId: patch.contractAccountId ?? "", offChainMilestoneId: record.milestoneIdentity?.milestoneId ?? "", status: "pending", ...patch }); return; }
    if (current.status !== "pending") throw new Error("On-chain linkage is immutable after confirmation");
    if (patch.network && patch.network !== current.network || patch.contractAccountId && current.contractAccountId && patch.contractAccountId !== current.contractAccountId) throw new Error("On-chain linkage configuration conflict");
    record.onChainLinkage = { ...current, ...patch, executionId, offChainMilestoneId: current.offChainMilestoneId };
    await this.persist();
  }
  async recordLifecycleTransaction(executionId: string, field: "fundingTransactionHash" | "activationTransactionHash" | "startTransactionHash" | "verificationTransactionHash" | "approvalTransactionHash" | "settlementTransactionHash", transactionHash: string): Promise<void> {
    const record = this.records.get(executionId);
    if (!record) throw new Error("Execution not found");
    if (!record.onChainLinkage || record.onChainLinkage.status !== "confirmed") throw new Error("Confirmed project and milestone linkage is required");
    const existingExecutionId = this.findExecutionByTransactionHash(transactionHash, executionId);
    if (existingExecutionId) throw new Error("Transaction hash is already linked to another execution");
    if (field !== "settlementTransactionHash" && record.onChainLinkage[field]) throw new Error("This lifecycle operation is already linked");
    if (field === "settlementTransactionHash") {
      const hashes = [...(record.onChainLinkage.settlementTransactionHashes ?? []), transactionHash];
      record.onChainLinkage = { ...record.onChainLinkage, settlementTransactionHash: transactionHash, settlementTransactionHashes: hashes };
    } else record.onChainLinkage = { ...record.onChainLinkage, [field]: transactionHash };
    await this.persist();
  }
  async confirmOnChainLinkage(executionId: string, adapter: NearReadonlyAdapter): Promise<void> {
    const record = this.records.get(executionId); const linkage = record?.onChainLinkage;
    if (!record) throw new Error("Execution not found");
    if (!linkage || linkage.status !== "pending" || !linkage.onChainProjectId || !linkage.onChainMilestoneId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget || !linkage.projectCreationTransactionHash || !linkage.milestoneRegistrationTransactionHash) throw new Error("Pending linkage is incomplete");
    if (adapter.network !== linkage.network || adapter.contractAccountId !== linkage.contractAccountId) throw new Error("NEAR adapter does not match linkage");
    const projectId = Number(linkage.onChainProjectId); const milestoneId = Number(linkage.onChainMilestoneId);
    if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(milestoneId) || projectId < 0 || milestoneId < 0) throw new Error("Linkage contains an invalid chain identifier");
    const [project, milestone] = await Promise.all([adapter.getProject(projectId), adapter.getMilestone(projectId, milestoneId)]);
    if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || project.owner !== linkage.ownerAccountId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget) throw new Error("Read-only chain evidence does not match linkage");
    record.onChainLinkage = { ...linkage, status: "confirmed", confirmedAt: new Date().toISOString() };
    await this.persist();
  }
  async attachExistingOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void> {
    const record = this.records.get(executionId);
    if (!record) throw new Error("Execution not found");
    if (!record.paymentEligible) throw new Error("Only payment-eligible executions may attach an existing milestone");
    if (linkage.executionId !== executionId || linkage.status !== "confirmed" || linkage.network !== "testnet" || !linkage.contractAccountId || !linkage.onChainProjectId || !linkage.onChainMilestoneId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget) throw new Error("Existing chain linkage is incomplete");
    if (linkage.offChainMilestoneId !== record.milestoneIdentity?.milestoneId) throw new Error("On-chain linkage does not match the execution");
    if (record.onChainLinkage && record.onChainLinkage.status !== "unlinked") throw new Error("On-chain linkage already exists");
    record.onChainLinkage = { ...linkage, requestedAt: linkage.requestedAt ?? new Date().toISOString(), confirmedAt: linkage.confirmedAt ?? new Date().toISOString() };
    await this.persist();
  }
  private nextMilestoneId(projectId?: string): string { let max = -1; for (const record of this.records.values()) { if (record.projectId !== projectId) continue; const id = Number(record.milestoneId); if (Number.isSafeInteger(id) && id >= 0) max = Math.max(max, id); } return String(max + 1); }
  private async persist(): Promise<void> { const operation = async () => { await mkdir(dirname(this.filePath), { recursive: true }); const temporaryPath = join(dirname(this.filePath), `.${this.filePath.split("/").pop() ?? "executions"}.tmp`); await writeFile(temporaryPath, JSON.stringify({ version: 1, executions: [...this.records.values()] } satisfies StoreFile), { encoding: "utf8", mode: 0o600 }); await rename(temporaryPath, this.filePath); }; this.writeChain = this.writeChain.then(operation); return this.writeChain; }
}

export function normalizeRecord(record: StoredExecution): StoredExecution {
  const legacy = record as StoredExecution & { qaAssessments?: ProjectExecution["qaAssessments"]; reworkRequests?: StoredExecution["reworkRequests"] };
  const revisions = legacy.revisions ?? [];
  const rawState = legacy.verificationState ?? (legacy.verification ? { attemptId: `legacy-${legacy.verification.receiptId}`, status: legacy.verification.result === "Passed" ? "verified" : "rejected", executionId: legacy.executionId, revision: revisions.find((revision) => revision.digest === legacy.verification?.artifactDigest)?.revision ?? revisions.length, artifactDigest: legacy.verification.artifactDigest, policyVersion: legacy.verification.policyVersion, requestedAt: legacy.verification.timestamp, completedAt: legacy.verification.timestamp, result: legacy.verification.result, receipt: legacy.verification } satisfies PersistedVerification : undefined);
  const verificationState = rawState ? { ...rawState, attemptId: rawState.attemptId ?? `legacy-${rawState.receipt?.receiptId ?? legacy.executionId}` } : undefined;
  const verificationHistory = Array.isArray(legacy.verificationHistory) ? legacy.verificationHistory.map((attempt, index) => ({ ...attempt, attemptId: attempt.attemptId ?? `legacy-${attempt.receipt?.receiptId ?? legacy.executionId}-${index}` })) : verificationState ? [{ ...verificationState }] : [];
  const persistedMilestoneIds = [legacy.milestoneId, legacy.verification?.milestoneId, ...verificationHistory.map((attempt) => attempt.receipt?.milestoneId)].filter((value): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value));
  const uniqueMilestoneIds = [...new Set(persistedMilestoneIds)];
  const milestoneIdentity: MilestoneIdentity = legacy.milestoneIdentity ?? (uniqueMilestoneIds.length > 1
    ? { status: "conflict", source: "conflicting_records", onChainLinked: false }
    : uniqueMilestoneIds.length === 1
      ? { status: "authoritative", milestoneId: uniqueMilestoneIds[0], source: legacy.milestoneId ? "execution_record" : "historical_receipt", onChainLinked: false }
      : { status: "unresolved", source: "unresolved", onChainLinked: false });
  return {
    ...legacy,
    ...(verificationState ? { verificationState } : {}),
    verificationHistory,
    ...(milestoneIdentity.status === "authoritative" && milestoneIdentity.milestoneId ? { milestoneId: milestoneIdentity.milestoneId } : {}),
    milestoneIdentity,
    onChainLinkage: legacy.onChainLinkage ?? { executionId: legacy.executionId, network: "testnet", contractAccountId: "", offChainMilestoneId: milestoneIdentity.milestoneId ?? "", status: "unlinked" },
    qaAssessments: Array.isArray(legacy.qaAssessments) ? legacy.qaAssessments : [],
    validationReports: Array.isArray(legacy.validationReports) ? legacy.validationReports : [],
    reworkRequests: (legacy.reworkRequests ?? []).map((request) => ({
      ...request,
      rejectedRevision: request.rejectedRevision ?? request.revision,
      nextBuilderAttempt: request.nextBuilderAttempt ?? (request.terminal ? undefined : request.attempt),
      terminal: request.terminal ?? (legacy.failure?.code === "REWORK_EXHAUSTED" && request.revision === revisions.length),
      missingRequirements: request.missingRequirements ?? [],
    })),
  };
}
