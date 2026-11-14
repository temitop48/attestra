import { Pool, type PoolClient } from "pg";
import type { NearReadonlyAdapter } from "@attestra/near-readonly";
import { normalizeRecord, type ExecutionStoreLike, type OnChainLinkage, type StoredExecution } from "./store.js";
import type { PersistedVerifierSubmission, VerifierSubmissionStoreLike } from "./verifier-submission-store.js";
import type { VerifierSubmission, VerifierSubmissionState } from "./verifier-submission.js";

const MAX_RECORDS = 1_000;
const txFields = ["fundingTransactionHash", "activationTransactionHash", "startTransactionHash", "verificationTransactionHash", "approvalTransactionHash", "settlementTransactionHash"] as const;
type TxField = typeof txFields[number];

export function databaseSsl(env: NodeJS.ProcessEnv): { rejectUnauthorized: boolean; ca?: string } | undefined {
  if (env.DATABASE_SSL !== "true") return undefined;
  const ca = env.DATABASE_SSL_CA?.replace(/\\n/g, "\n").trim();
  return {
    rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
    ...(ca ? { ca } : {})
  };
}

export class PostgresExecutionStore implements ExecutionStoreLike {
  private readonly records = new Map<string, StoredExecution>();
  private constructor(private readonly pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresExecutionStore> {
    const store = new PostgresExecutionStore(pool);
    const result = await pool.query<{ record: StoredExecution }>("select record from attest_execution_records order by created_at desc limit $1", [MAX_RECORDS]);
    for (const row of result.rows) store.records.set(row.record.executionId, normalizeRecord(row.record));
    const changed = store.markInterrupted();
    if (changed) await store.persistAll();
    return store;
  }

  get(executionId: string): StoredExecution | undefined { return this.records.get(executionId); }
  list(offset: number, limit: number): StoredExecution[] { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit); }
  findExecutionByTransactionHash(hash: string, excludeExecutionId?: string): string | undefined {
    for (const record of this.records.values()) {
      if (record.executionId === excludeExecutionId) continue;
      const linkage = record.onChainLinkage;
      if (linkage && [linkage.projectCreationTransactionHash, linkage.milestoneRegistrationTransactionHash, linkage.fundingTransactionHash, linkage.activationTransactionHash, linkage.startTransactionHash, linkage.verificationTransactionHash, linkage.approvalTransactionHash, linkage.settlementTransactionHash, ...(linkage.settlementTransactionHashes ?? [])].includes(hash)) return record.executionId;
    }
    return undefined;
  }

  async create(record: StoredExecution): Promise<void> {
    if (this.records.has(record.executionId)) throw new Error("Execution already exists");
    if (!record.milestoneId) {
      record.milestoneId = this.nextMilestoneId(record.projectId);
      record.milestoneIdentity = { status: "authoritative", milestoneId: record.milestoneId, source: "server_assigned", onChainLinked: false };
    } else if (!record.milestoneIdentity) record.milestoneIdentity = { status: "authoritative", milestoneId: record.milestoneId, source: "execution_record", onChainLinked: false };
    record.onChainLinkage ??= { executionId: record.executionId, network: "testnet", contractAccountId: "", offChainMilestoneId: record.milestoneIdentity.milestoneId ?? "", status: "unlinked" };
    record.onChainLinkage = { ...record.onChainLinkage, executionId: record.executionId, offChainMilestoneId: record.milestoneIdentity.milestoneId ?? "" };
    await this.pool.query("insert into attest_execution_records (execution_id, record, created_at, updated_at) values ($1, $2::jsonb, now(), now())", [record.executionId, JSON.stringify(record)]);
    this.records.set(record.executionId, record);
  }

  async update(record: StoredExecution): Promise<void> {
    if (!this.records.has(record.executionId)) throw new Error("Execution not found");
    await this.pool.query("update attest_execution_records set record = $2::jsonb, updated_at = now() where execution_id = $1", [record.executionId, JSON.stringify(record)]);
    this.records.set(record.executionId, record);
  }

  async setOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void> {
    const record = this.require(executionId);
    if (linkage.executionId !== executionId || linkage.network !== "testnet" || linkage.offChainMilestoneId !== record.milestoneIdentity?.milestoneId) throw new Error("On-chain linkage does not match the execution");
    if (record.onChainLinkage && record.onChainLinkage.status !== "unlinked") throw new Error("On-chain linkage already exists");
    if (linkage.status === "confirmed") throw new Error("Confirmed linkage requires read-only chain evidence");
    await this.update({ ...record, onChainLinkage: { ...linkage } });
  }

  async mergeOnChainLinkage(executionId: string, patch: Partial<OnChainLinkage>): Promise<void> {
    const record = this.require(executionId);
    const transactionHash = patch.projectCreationTransactionHash ?? patch.milestoneRegistrationTransactionHash ?? patch.fundingTransactionHash ?? patch.activationTransactionHash ?? patch.startTransactionHash ?? patch.verificationTransactionHash ?? patch.approvalTransactionHash ?? patch.settlementTransactionHash;
    if (transactionHash && this.findExecutionByTransactionHash(transactionHash, executionId)) throw new Error("Transaction hash is already linked to another execution");
    const current = record.onChainLinkage;
    if (!current || current.status === "unlinked") return this.setOnChainLinkage(executionId, { executionId, network: "testnet", contractAccountId: patch.contractAccountId ?? "", offChainMilestoneId: record.milestoneIdentity?.milestoneId ?? "", status: "pending", ...patch });
    if (current.status !== "pending") throw new Error("On-chain linkage is immutable after confirmation");
    if ((patch.network && patch.network !== current.network) || (patch.contractAccountId && current.contractAccountId && patch.contractAccountId !== current.contractAccountId)) throw new Error("On-chain linkage configuration conflict");
    await this.update({ ...record, onChainLinkage: { ...current, ...patch, executionId, offChainMilestoneId: current.offChainMilestoneId } });
  }

  async recordLifecycleTransaction(executionId: string, field: TxField, transactionHash: string): Promise<void> {
    const record = this.require(executionId); const linkage = record.onChainLinkage;
    if (!linkage || linkage.status !== "confirmed") throw new Error("Confirmed project and milestone linkage is required");
    if (this.findExecutionByTransactionHash(transactionHash, executionId)) throw new Error("Transaction hash is already linked to another execution");
    if (field !== "settlementTransactionHash" && linkage[field]) throw new Error("This lifecycle operation is already linked");
    const next = field === "settlementTransactionHash" ? { ...linkage, settlementTransactionHash: transactionHash, settlementTransactionHashes: [...(linkage.settlementTransactionHashes ?? []), transactionHash] } : { ...linkage, [field]: transactionHash };
    await this.update({ ...record, onChainLinkage: next });
  }

  async confirmOnChainLinkage(executionId: string, adapter: NearReadonlyAdapter): Promise<void> {
    const record = this.require(executionId); const linkage = record.onChainLinkage;
    if (!linkage || linkage.status !== "pending" || !linkage.onChainProjectId || !linkage.onChainMilestoneId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget || !linkage.projectCreationTransactionHash || !linkage.milestoneRegistrationTransactionHash) throw new Error("Pending linkage is incomplete");
    if (adapter.network !== linkage.network || adapter.contractAccountId !== linkage.contractAccountId) throw new Error("NEAR adapter does not match linkage");
    const projectId = Number(linkage.onChainProjectId); const milestoneId = Number(linkage.onChainMilestoneId);
    const [project, milestone] = await Promise.all([adapter.getProject(projectId), adapter.getMilestone(projectId, milestoneId)]);
    if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || project.owner !== linkage.ownerAccountId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget) throw new Error("Read-only chain evidence does not match linkage");
    await this.update({ ...record, onChainLinkage: { ...linkage, status: "confirmed", confirmedAt: new Date().toISOString() } });
  }

  async attachExistingOnChainLinkage(executionId: string, linkage: OnChainLinkage): Promise<void> {
    const record = this.require(executionId);
    if (!record.paymentEligible) throw new Error("Only payment-eligible executions may attach an existing milestone");
    if (linkage.executionId !== executionId || linkage.status !== "confirmed" || linkage.network !== "testnet" || !linkage.contractAccountId || !linkage.onChainProjectId || !linkage.onChainMilestoneId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget || linkage.offChainMilestoneId !== record.milestoneIdentity?.milestoneId) throw new Error("Existing chain linkage is incomplete");
    if (record.onChainLinkage && record.onChainLinkage.status !== "unlinked") throw new Error("On-chain linkage already exists");
    await this.update({ ...record, onChainLinkage: { ...linkage, requestedAt: linkage.requestedAt ?? new Date().toISOString(), confirmedAt: linkage.confirmedAt ?? new Date().toISOString() } });
  }

  async close(): Promise<void> { await this.pool.end(); }
  private require(id: string): StoredExecution { const record = this.records.get(id); if (!record) throw new Error("Execution not found"); return record; }
  private nextMilestoneId(projectId?: string): string { let max = -1; for (const record of this.records.values()) if (record.projectId === projectId) { const id = Number(record.milestoneId); if (Number.isSafeInteger(id) && id >= 0) max = Math.max(max, id); } return String(max + 1); }
  private markInterrupted(): boolean { let changed = false; for (const record of this.records.values()) { if (record.lifecycle === "running" || record.lifecycle === "queued") { record.lifecycle = "completed"; record.status = "Failed"; record.failure = { code: "PROCESS_RESTART_INTERRUPTED", message: "Execution was interrupted by an API process restart and requires a new execution.", stage: "orchestration", retryable: true }; record.updatedAt = new Date().toISOString(); changed = true; } if (record.verificationState?.status === "in_progress") { const completedAt = new Date().toISOString(); const failure = { code: "VERIFICATION_PROCESS_INTERRUPTED", message: "Verification was interrupted by an API process restart and may be retried.", retryable: true, stage: "receipt" as const }; record.verificationState = { ...record.verificationState, status: "error", completedAt, failure }; record.verificationHistory = (record.verificationHistory ?? []).map((attempt) => attempt.attemptId === record.verificationState?.attemptId ? { ...attempt, status: "error" as const, completedAt, failure } : attempt); changed = true; } } return changed; }
  private async persistAll(): Promise<void> { const client = await this.pool.connect(); try { await client.query("begin"); for (const record of this.records.values()) await client.query("update attest_execution_records set record = $2::jsonb, updated_at = now() where execution_id = $1", [record.executionId, JSON.stringify(record)]); await client.query("commit"); } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); } }
}

export class PostgresVerifierSubmissionStore implements VerifierSubmissionStoreLike {
  private readonly records = new Map<string, PersistedVerifierSubmission>();
  private constructor(private readonly pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresVerifierSubmissionStore> { const store = new PostgresVerifierSubmissionStore(pool); const result = await pool.query<{ record: PersistedVerifierSubmission }>("select record from attest_verifier_submissions"); for (const row of result.rows) store.records.set(row.record.idempotencyKey, row.record); return store; }
  get(idempotencyKey: string): PersistedVerifierSubmission | undefined { return this.records.get(idempotencyKey); }
  async reserve(idempotencyKey: string, initial: Omit<PersistedVerifierSubmission, "idempotencyKey">): Promise<{ created: boolean; submission: PersistedVerifierSubmission }> {
    const submission = { ...initial, idempotencyKey };
    const result = await this.pool.query<{ record: PersistedVerifierSubmission }>("insert into attest_verifier_submissions (idempotency_key, execution_id, record, created_at, updated_at) values ($1, $2, $3::jsonb, now(), now()) on conflict (idempotency_key) do nothing returning record", [idempotencyKey, submission.executionId, JSON.stringify(submission)]);
    if (result.rowCount) { this.records.set(idempotencyKey, submission); return { created: true, submission }; }
    const existing = this.records.get(idempotencyKey) ?? (await this.pool.query<{ record: PersistedVerifierSubmission }>("select record from attest_verifier_submissions where idempotency_key = $1", [idempotencyKey])).rows[0]?.record;
    if (!existing) throw new Error("Verifier submission reservation could not be read after conflict");
    this.records.set(idempotencyKey, existing); return { created: false, submission: existing };
  }
  async update(idempotencyKey: string, patch: Partial<Pick<PersistedVerifierSubmission, "state" | "transactionHash" | "error">>): Promise<PersistedVerifierSubmission> { const current = this.records.get(idempotencyKey) ?? (await this.pool.query<{ record: PersistedVerifierSubmission }>("select record from attest_verifier_submissions where idempotency_key = $1", [idempotencyKey])).rows[0]?.record; if (!current) throw new Error("Verifier submission reservation not found"); const next = { ...current, ...patch }; await this.pool.query("update attest_verifier_submissions set record = $2::jsonb, updated_at = now() where idempotency_key = $1", [idempotencyKey, JSON.stringify(next)]); this.records.set(idempotencyKey, next); return next; }
  async markUnknown(idempotencyKey: string, error: string): Promise<PersistedVerifierSubmission> { return this.update(idempotencyKey, { state: "unknown" satisfies VerifierSubmissionState, error }); }
  async close(): Promise<void> { await this.pool.end(); }
}

export async function createPostgresPersistence(env: NodeJS.ProcessEnv = process.env): Promise<{ executionStore: PostgresExecutionStore; submissionStore: PostgresVerifierSubmissionStore; close: () => Promise<void> }> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) throw new Error("DATABASE_URL must be a PostgreSQL connection string in production; JSON persistence is not allowed");
  const pool = new Pool({ connectionString, max: 5, ssl: databaseSsl(env), connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  try {
    await pool.query("select 1");
    const executionStore = await PostgresExecutionStore.open(pool);
    const submissionStore = await PostgresVerifierSubmissionStore.open(pool);
    return { executionStore, submissionStore, close: () => pool.end() };
  } catch (error) { await pool.end(); throw new Error(`PostgreSQL persistence is unavailable: ${error instanceof Error ? error.message : "connection failed"}`); }
}
