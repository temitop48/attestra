import { computeArtifactDigest } from "@attestra/orchestrator";
import { VERIFIER_IMPLEMENTATION_VERSION, toContractVerificationArgs, type VerificationReceipt } from "@attestra/verification";
import type { NearMilestone, NearProject, NearTransaction } from "@attestra/near-readonly";
import type { OnChainLinkage, StoredExecution, VerificationAttempt } from "./store.js";
import type { VerifierSubmissionStoreLike } from "./verifier-submission-store.js";

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
export type VerifierSubmission = { state: VerifierSubmissionState; executionId: string; receiptId: string; artifactDigest: string; transactionHash?: string; error?: string };

function publicSubmission(value: { state: VerifierSubmissionState; executionId: string; receiptId: string; artifactDigest: string; transactionHash?: string; error?: string }): VerifierSubmission {
  const { state, executionId, receiptId, artifactDigest, transactionHash, error } = value;
  return { state, executionId, receiptId, artifactDigest, ...(transactionHash ? { transactionHash } : {}), ...(error ? { error } : {}) };
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
    const reservation = this.options.submissionStore ? await this.options.submissionStore.reserve(prepared.key, { state: "pending", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest }) : { created: true, submission: undefined };
    if (!reservation.created && reservation.submission) return publicSubmission(reservation.submission);
    const operation = this.options.signer.submit(prepared.intent).then(async ({ hash }) => {
      if (!hash) throw new VerifierSubmissionError("SIGNER_INVALID_RESULT", "Verifier signer returned no transaction hash");
      const pending: VerifierSubmission = { state: "pending", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, transactionHash: hash };
      this.states.set(prepared.key, pending);
      await this.options.submissionStore?.update(prepared.key, pending);
      return pending;
    }).catch(async (error) => {
      const outcome = error && typeof error === "object" && "submissionOutcome" in error ? (error as { submissionOutcome?: string }).submissionOutcome : undefined;
      const state = outcome === "failed" ? "failed" : "unknown";
      const failure: VerifierSubmission = { state, executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, error: error instanceof Error ? error.message : "Verifier submission outcome is unknown" };
      this.states.set(prepared.key, failure);
      await this.options.submissionStore?.update(prepared.key, { state, error: failure.error ?? "Verifier submission failed" });
      throw error;
    }).finally(() => this.inFlight.delete(prepared.key));
    this.inFlight.set(prepared.key, operation);
    return operation;
  }

  async reconcile(record: StoredExecution, transactionHash: string): Promise<VerifierSubmission> {
    const prepared = await this.prepare(record, "VerificationPassed", true);
    const tx = await this.options.reader.getTransaction(transactionHash, this.options.authorizedVerifier);
    const action = tx.actions[0];
    const args = decodeIntentArgs(action?.argsBase64);
    if (!tx.success || tx.signerId !== this.options.authorizedVerifier || tx.receiverId !== this.options.reader.contractAccountId || tx.actions.length !== 1 || action?.type !== "FunctionCall" || action.methodName !== "submit_verification" || action.deposit !== this.options.verificationStorageDeposit || !args || JSON.stringify(args) !== JSON.stringify(prepared.intent.args)) return { state: "unknown", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, transactionHash, error: "Finalized transaction evidence does not match the verifier intent" };
    const project = await this.options.reader.getProject(prepared.projectId);
    const milestone = await this.options.reader.getMilestone(prepared.projectId, prepared.milestoneId);
    if (!project || !milestone || milestone.status !== "VerificationPassed" || !milestone.verification || milestone.verification.receiptId !== prepared.receipt.receiptId || milestone.verification.deliverableDigest !== prepared.receipt.artifactDigest || milestone.verification.projectId !== prepared.projectId || milestone.verification.milestoneId !== prepared.milestoneId || milestone.verification.verifier !== this.options.authorizedVerifier) return { state: "unknown", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, transactionHash, error: "Finalized chain state does not confirm this verification" };
    const finalized: VerifierSubmission = { state: "finalized", executionId: record.executionId, receiptId: prepared.receipt.receiptId, artifactDigest: prepared.receipt.artifactDigest, transactionHash };
    this.states.set(prepared.key, finalized);
    await this.options.submissionStore?.update(prepared.key, finalized);
    return finalized;
  }

  private async prepare(record: StoredExecution, expectedStatus: "InProgress" | "VerificationPassed", allowExistingVerification = false): Promise<{ key: string; receipt: VerificationReceipt; projectId: number; milestoneId: number; intent: VerifierTransactionIntent }> {
    const linkage = requireLinkage(record);
    if (linkage.contractAccountId !== this.options.reader.contractAccountId) throw new VerifierSubmissionError("CONTRACT_MISMATCH", "The configured reader does not match the authoritative contract linkage");
    if (linkage.verificationTransactionHash && !allowExistingVerification) throw new VerifierSubmissionError("DUPLICATE_SUBMISSION", "Verification is already linked to this execution");
    const projectId = numericId(linkage.onChainProjectId, "on-chain project ID");
    const milestoneId = numericId(linkage.onChainMilestoneId, "on-chain milestone ID");
    const [project, milestone] = await Promise.all([this.options.reader.getProject(projectId), this.options.reader.getMilestone(projectId, milestoneId)]);
    if (!project || !milestone || project.projectId !== projectId || milestone.projectId !== projectId || milestone.milestoneId !== milestoneId || project.owner !== linkage.ownerAccountId || milestone.recipient !== linkage.recipientAccountId || milestone.budget !== linkage.milestoneBudget || milestone.status !== expectedStatus) throw new VerifierSubmissionError("CHAIN_STATE_MISMATCH", "Finalized chain state does not match the payment-backed execution");
    const { attempt, receipt } = latestPassingAttempt(record);
    const final = record.finalDeliverable;
    if (!final || final.revision !== attempt.revision || final.digest !== attempt.artifactDigest || receipt.projectId !== String(projectId) || receipt.milestoneId !== String(milestoneId) || receipt.artifactDigest !== final.digest || await computeArtifactDigest(final.artifacts) !== final.digest) throw new VerifierSubmissionError("RECEIPT_BINDING_INVALID", "The passing receipt does not match the immutable final artifact and chain linkage");
    const key = `${record.executionId}:${receipt.receiptId}:${receipt.artifactDigest}`;
    return { key, receipt, projectId, milestoneId, intent: { receiverId: this.options.reader.contractAccountId, methodName: "submit_verification", args: toContractVerificationArgs(receipt) as VerifierTransactionIntent["args"], gas: GAS, deposit: this.options.verificationStorageDeposit, idempotencyKey: key } };
  }
}
