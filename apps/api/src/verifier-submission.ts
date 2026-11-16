import { computeArtifactDigest } from "@attestra/orchestrator";
import { createHash } from "node:crypto";
import { VERIFIER_IMPLEMENTATION_VERSION, toContractVerificationArgs, type VerificationReceipt } from "@attestra/verification";
import type { NearMilestone, NearProject, NearTransaction } from "@attestra/near-readonly";
import type { OnChainLinkage, StoredExecution, VerificationAttempt } from "./store.js";
import type { VerifierSubmissionStoreLike, VerifierSubmissionPatch } from "./verifier-submission-store.js";

export type VerifierChainReader = {
  readonly network: "testnet";
  readonly contractAccountId: string;
  getProject(projectId: number): Promise<NearProject | null>;
  getMilestone(projectId: number, milestoneId: number): Promise<NearMilestone | null>;
  getTransaction(hash: string, signerId: string): Promise<NearTransaction>;
};

export type VerifierTransactionIntent = {
  receiverId: string;
  methodName: "submit_verification";
  args: { project_id: number; milestone_id: number; deliverable_digest: string; receipt_id: string; result: "Passed" };
  gas: string;
  deposit: string;
  idempotencyKey: string;
};

export type BackendVerifierSigner = {
  readonly accountId: string;
  readonly restrictedKey?: boolean;
  submit(intent: VerifierTransactionIntent): Promise<{ hash: string }>;
};

export type VerifierSubmissionState = "pending" | "finalized" | "failed" | "unknown";
export type VerifierRecoveryState = "reserved" | "broadcast_attempted" | "transaction_known" | "finalized" | "definitive_failure" | "unknown" | "receipt_confirmed_without_hash";
export type VerifierIntentMetadata = { executionId: string; receiptId: string; artifactDigest: string; projectId: number; milestoneId: number; signerAccount: string; escrowContractAccount: string; method: "submit_verification"; args: VerifierTransactionIntent["args"]; deposit: string; intentDigest: string };
export type VerifierSubmission = { state: VerifierSubmissionState; executionId: string; receiptId: string; artifactDigest: string; transactionHash?: string; error?: string; recoveryState?: VerifierRecoveryState };

function publicSubmission(value: VerifierSubmission): VerifierSubmission {
  const { state, executionId, receiptId, artifactDigest, transactionHash, error, recoveryState } = value;
  return { state, executionId, receiptId, artifactDigest, ...(transactionHash ? { transactionHash } : {}), ...(error ? { error } : {}), ...(recoveryState ? { recoveryState } : {}) };
}

function intentDigest(intent: VerifierTransactionIntent): string {
  return createHash("sha256").update(JSON.stringify({ receiverId: intent.receiverId, methodName: intent.methodName, args: intent.args, gas: intent.gas, deposit: intent.deposit, idempotencyKey: intent.idempotencyKey })).digest("hex");
}

export class VerifierSubmissionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "VerifierSubmissionError"; }
}

const GAS = "30000000000000";
const DECIMAL_ID = /^(0|[1-9][0-9]*)$/;
const ACCOUNT_ID = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?))*$/;

function latestPassingAttempt(record: StoredExecution): { attempt: VerificationAttempt; receipt: VerificationReceipt } {
  const attempt = record.verificationHistory?.at(-1) ?? record.verificationState;
  const receipt = attempt?.receipt ?? record.verification;
  if (!attempt || attempt.status !== "verified" || !receipt || receipt.result !== "Passed") throw new VerifierSubmissionError("PASSING_RECEIPT_REQUIRED", "A backend-generated passing verification receipt is required");
  if (attempt.executionId !== record.executionId || attempt.result !== "Passed") throw new VerifierSubmissionError("RECEIPT_EXECUTION_MISMATCH", "The passing receipt is not linked to this execution");
  if (receipt.verifier.implementationVersion !== VERIFIER_IMPLEMENTATION_VERSION) throw new VerifierSubmissionError("VERIFIER_VERSION_MISMATCH", "The receipt was not produced by the active verifier implementation");
  if (receipt.checks.some((check) => check.required && check.status !== "passed")) throw new VerifierSubmissionError("MANDATORY_CHECK_NOT_PASSED", "The receipt contains a failed or skipped mandatory check");
  return { attempt, receipt };
}

function numericId(value: string | undefined, field: string): number {
  if (!value || !DECIMAL_ID.test(value)) throw new VerifierSubmissionError("CHAIN_LINKAGE_INVALID", `${field} is not a valid on-chain identifier`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new VerifierSubmissionError("CHAIN_LINKAGE_INVALID", `${field} exceeds the safe identifier range`);
  return parsed;
}

function requireLinkage(record: StoredExecution): OnChainLinkage {
  const linkage = record.onChainLinkage;
  if (!linkage || linkage.status !== "confirmed" || linkage.network !== "testnet" || !linkage.contractAccountId || !linkage.ownerAccountId || !linkage.recipientAccountId || !linkage.milestoneBudget) throw new VerifierSubmissionError("CHAIN_LINKAGE_REQUIRED", "Confirmed Testnet project, owner, recipient, and milestone linkage is required");
  return linkage;
}

function decodeIntentArgs(argsBase64: string | undefined): VerifierTransactionIntent["args"] | undefined {
  if (!argsBase64) return undefined;
  try {
    const value = JSON.parse(Buffer.from(argsBase64, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof value.project_id !== "number" || typeof value.milestone_id !== "number" || typeof value.deliverable_digest !== "string" || typeof value.receipt_id !== "string" || value.result !== "Passed") return undefined;
    return { project_id: value.project_id, milestone_id: value.milestone_id, deliverable_digest: value.deliverable_digest, receipt_id: value.receipt_id, result: "Passed" };
  } catch {
    return undefined;
  }
}

export class BackendVerifierSubmissionService {
  private readonly inFlight = new Map<string, Promise<VerifierSubmission>>();
  private readonly states = new Map<string, VerifierSubmission>();

  constructor(private readonly options: { reader: VerifierChainReader; signer?: BackendVerifierSigner; authorizedVerifier: string; verificationStorageDeposit: string; submissionStore?: VerifierSubmissionStoreLike }) {
    if (!ACCOUNT_ID.test(options.authorizedVerifier)) throw new VerifierSubmissionError("VERIFIER_CONFIG_INVALID", "The configured authorized verifier account is invalid");
    const zeroDepositRestricted = options.verificationStorageDeposit === "0" && options.signer?.restrictedKey === true;
    if (!zeroDepositRestricted && !/^[1-9][0-9]*$/.test(options.verificationStorageDeposit)) throw new VerifierSubmissionError("VERIFIER_CONFIG_INVALID", "A positive verification storage deposit is required unless a restricted zero-deposit verifier key is configured");
    if (options.reader.network !== "testnet") throw new VerifierSubmissionError("NETWORK_UNSUPPORTED", "Only NEAR Testnet is supported");
  }

  async submit(record: StoredExecution): Promise<VerifierSubmission> {
    const prepared = await this.prepare(record, "InProgress");
    const existing = this.states.get(prepared.key);
    if (existing) return existing;
    const durableExisting = this.options.submissionStore?.get(prepared.key);
    if (durableExisting) return publicSubmission(durableExisting);
    const active = this.inFlight.get(prepared.key);
    if (active) return active;
    if (!this.options.signer) throw new VerifierSubmissionError("VERIFIER_SIGNER_NOT_CONFIGURED", "A server-side verifier signer is not configured; no transaction was submitted");
    if (this.options.signer.accountId !== this.options.authorizedVerifier) throw new VerifierSubmissionError("VERIFIER_SIGNER_MISMATCH", "The configured signer is not the contract authorized verifier");
    const now = new Date().toISOString();
    const intent: VerifierIntentMetadata = { executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, projectId: prepared.projectId, milestoneId: prepared.milestoneId, signerAccount: this.options.signer.accountId, escrowContractAccount: prepared.intent.receiverId, method: prepared.intent.methodName, args: prepared.intent.args, deposit: prepared.intent.deposit, intentDigest: intentDigest(prepared.intent) };
    const reservation = this.options.submissionStore ? await this.options.submissionStore.reserve(prepared.key, { state: "pending", recoveryState: "reserved", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, intent, createdAt: now }) : { created: true, submission: undefined };
    if (!reservation.created && reservation.submission) return publicSubmission(reservation.submission);
    const operation = (async () => {
      await this.options.submissionStore?.update(prepared.key, { recoveryState: "broadcast_attempted", broadcastAttemptedAt: new Date().toISOString() });
      return this.options.signer!.submit(prepared.intent);
    })().then(async ({ hash }) => {
      if (!hash) throw new VerifierSubmissionError("SIGNER_INVALID_RESULT", "Verifier signer returned no transaction hash");
      const pending: VerifierSubmission = { state: "pending", recoveryState: "transaction_known", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, transactionHash: hash };
      await this.options.submissionStore?.update(prepared.key, pending);
      this.states.set(prepared.key, pending);
      return pending;
    }).catch(async (error) => {
      const outcome = error && typeof error === "object" && "submissionOutcome" in error ? (error as { submissionOutcome?: string }).submissionOutcome : undefined;
      const definitive = outcome === "failed";
      const state = definitive ? "failed" : "unknown";
      const recoveryState = definitive ? "definitive_failure" : "unknown";
      const failure: VerifierSubmission = { state, recoveryState, executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, error: error instanceof Error ? error.message : "Verifier submission outcome is unknown" };
      await this.options.submissionStore?.update(prepared.key, { state, recoveryState, error: failure.error ?? "Verifier submission failed" });
      this.states.set(prepared.key, failure);
      throw error;
    }).finally(() => this.inFlight.delete(prepared.key));
    this.inFlight.set(prepared.key, operation);
    return operation;
  }

  async reconcile(record: StoredExecution, transactionHash?: string): Promise<VerifierSubmission> {
    const prepared = await this.prepare(record, ["InProgress", "VerificationPassed"], true);
    const existing = this.options.submissionStore?.get(prepared.key);
    if (existing?.state === "finalized") return publicSubmission(existing);
    const base = { executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest };
    if (transactionHash) {
      const tx = await this.options.reader.getTransaction(transactionHash, this.options.authorizedVerifier);
      const action = tx.actions[0];
      const args = decodeIntentArgs(action?.argsBase64);
      const matchesIntent = tx.signerId === this.options.authorizedVerifier && tx.receiverId === this.options.reader.contractAccountId && tx.actions.length === 1 && action?.type === "FunctionCall" && action.methodName === "submit_verification" && action.deposit === this.options.verificationStorageDeposit && !!args && JSON.stringify(args) === JSON.stringify(prepared.intent.args);
      if (!matchesIntent) return this.persistReconciliation(prepared.key, { ...base, state: "unknown", recoveryState: "unknown", transactionHash, error: "Finalized transaction evidence does not match the verifier intent" });
      if (tx.finalExecutionStatus !== "FINAL") return this.persistReconciliation(prepared.key, { ...base, state: "unknown", recoveryState: "unknown", transactionHash, error: "Verifier transaction has not reached FINAL execution status" });
      if (!tx.success) return this.persistReconciliation(prepared.key, { ...base, state: "failed", recoveryState: "definitive_failure", transactionHash, error: "The known verifier transaction failed on-chain" });
    }
    const project = await this.options.reader.getProject(prepared.projectId);
    const milestone = await this.options.reader.getMilestone(prepared.projectId, prepared.milestoneId);
    if (!project || !milestone || milestone.status !== "VerificationPassed" || !milestone.verification || milestone.verification.receiptId !== prepared.receipt.receiptId || milestone.verification.deliverableDigest !== prepared.receipt.artifactDigest || milestone.verification.projectId !== prepared.projectId || milestone.verification.milestoneId !== prepared.milestoneId || milestone.verification.verifier !== this.options.authorizedVerifier || milestone.verification.result !== "Passed") return this.persistReconciliation(prepared.key, { ...base, state: "unknown", recoveryState: "unknown", ...(transactionHash ? { transactionHash } : {}), error: "Finalized chain state does not confirm this verification" });
    return this.persistReconciliation(prepared.key, { ...base, state: "finalized", recoveryState: transactionHash ? "finalized" : "receipt_confirmed_without_hash", ...(transactionHash ? { transactionHash } : {}) });
  }

  private async persistReconciliation(key: string, value: VerifierSubmission): Promise<VerifierSubmission> {
    await this.options.submissionStore?.update(key, value as VerifierSubmissionPatch);
    this.states.set(key, value);
    return value;
  }

  private async prepare(record: StoredExecution, expectedStatus: "InProgress" | "VerificationPassed" | ("InProgress" | "VerificationPassed")[], allowExistingVerification = false): Promise<{ key: string; receipt: VerificationReceipt; projectId: number; milestoneId: number; intent: VerifierTransactionIntent }> {
    const linkage = requireLinkage(record);
    if (linkage.contractAccountId !== this.options.reader.contractAccountId) throw new VerifierSubmissionError("CONTRACT_MISMATCH", "The configured reader does not match the authoritative contract linkage");
    if (linkage.verificationTransactionHash && !allowExistingVerification) throw new VerifierSubmissionError("DUPLICATE_SUBMISSION", "Verification is already linked to this execution");
    const projectId = numericId(linkage.onChainProjectId, "on-chain project ID");
    const milestoneId = numericId(linkage.onChainMilestoneId, "on-chain milestone ID");
    const [project, milestone] = await Promise.all([this.options.reader.getProject(projectId), this.options.reader.getMilestone(projectId, milestoneId)]);
    const allowedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || project.owner !== linkage.ownerAccountId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget || !allowedStatuses.includes(milestone.status as "InProgress" | "VerificationPassed")) throw new VerifierSubmissionError("CHAIN_STATE_MISMATCH", "Finalized chain state does not match the payment-backed execution");
    const { attempt, receipt } = latestPassingAttempt(record);
    const final = record.finalDeliverable;
    if (!final || final.revision !== attempt.revision || final.digest !== attempt.artifactDigest || receipt.projectId !== String(projectId) || receipt.milestoneId !== String(milestoneId) || receipt.artifactDigest !== final.digest || await computeArtifactDigest(final.artifacts) !== final.digest) throw new VerifierSubmissionError("RECEIPT_BINDING_INVALID", "The passing receipt does not match the immutable final artifact and chain linkage");
    const key = `${record.executionId}:${receipt.receiptId}:${receipt.artifactDigest}`;
    return { key, receipt, projectId, milestoneId, intent: { receiverId: this.options.reader.contractAccountId, methodName: "submit_verification", args: toContractVerificationArgs(receipt) as VerifierTransactionIntent["args"], gas: GAS, deposit: this.options.verificationStorageDeposit, idempotencyKey: key } };
  }
}
