import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeArtifactDigest } from "@attestra/orchestrator";
import type { Artifact } from "@attestra/agents";
import type { NearMilestone, NearProject, NearTransaction } from "@attestra/near-readonly";
import { VERIFIER_IMPLEMENTATION_VERSION, type VerificationReceipt } from "@attestra/verification";
import { BackendVerifierSubmissionService, VerifierSubmissionError, type VerifierChainReader } from "../src/verifier-submission.js";
import type { StoredExecution } from "../src/store.js";
import { VerifierSubmissionStore, type PersistedVerifierSubmission, type VerifierSubmissionStoreLike } from "../src/verifier-submission-store.js";

const artifacts: Artifact[] = [
  { path: "index.html", mediaType: "text/html", content: "<html><body>FocusFlow</body></html>" },
  { path: "styles.css", mediaType: "text/css", content: "body { color: black; }" },
  { path: "script.js", mediaType: "text/javascript", content: "document.body.textContent = 'FocusFlow';" },
];
const linkage = {
  executionId: "exec-1", network: "testnet" as const, contractAccountId: "escrow.attestra-owner.testnet",
  onChainProjectId: "0", onChainMilestoneId: "0", offChainMilestoneId: "internal-4", ownerAccountId: "owner.testnet",
  recipientAccountId: "recipient.testnet", milestoneBudget: "10000000000000000000000", status: "confirmed" as const,
};

async function fixture(): Promise<{ record: StoredExecution; receipt: VerificationReceipt; digest: string }> {
  const digest = await computeArtifactDigest(artifacts);
  const receipt: VerificationReceipt = {
    receiptId: "attest-v4-test", projectId: "0", milestoneId: "0", artifactDigest: digest, result: "Passed",
    checks: [{ id: "artifact_digest", name: "Artifact digest", required: true, status: "passed", message: "ok" }],
    timestamp: new Date(0).toISOString(), policyVersion: "verification-policy-v1",
    verifier: { engineId: "attestra-independent-verifier-v3", implementationVersion: VERIFIER_IMPLEMENTATION_VERSION, llmReview: "disabled" },
  };
  const record = {
    executionId: "exec-1", requirements: "FocusFlow", constraints: [], status: "AwaitingIndependentVerification" as const,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [], qaAssessments: [], validationReports: [],
    finalDeliverable: { revision: 2, digest, canonicalFormat: "attestra-artifacts-v2" as const, artifacts, totalBytes: artifacts.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) },
    lifecycle: "completed" as const, verificationState: { attemptId: "attempt-1", executionId: "exec-1", status: "verified" as const, revision: 2, artifactDigest: digest, policyVersion: "verification-policy-v1", verifierImplementationVersion: VERIFIER_IMPLEMENTATION_VERSION, requestedAt: new Date(0).toISOString(), result: "Passed" as const, receipt },
    verificationHistory: [], onChainLinkage: { ...linkage },
  } as StoredExecution;
  return { record, receipt, digest };
}

function chainReader(overrides: Partial<VerifierChainReader> = {}): VerifierChainReader {
  const project: NearProject = { projectId: 0, owner: "owner.testnet", totalFunded: "20000000000000000000000", availableBalance: "10000000000000000000000", reservedBalance: "10000000000000000000000", paidBalance: "0", refundedBalance: "0", pendingRefundBalance: "0", nextMilestoneId: 1, storageDeposit: "1" };
  const milestone: NearMilestone = { projectId: 0, milestoneId: 0, recipient: "recipient.testnet", budget: "10000000000000000000000", dependencies: [], status: "InProgress" };
  return { network: "testnet", contractAccountId: "escrow.attestra-owner.testnet", getProject: vi.fn(async () => project), getMilestone: vi.fn(async () => milestone), getTransaction: vi.fn(), ...overrides };
}

function service(reader: VerifierChainReader, signer?: { accountId: string; submit: ReturnType<typeof vi.fn> }, submissionStore?: VerifierSubmissionStore) {
  return new BackendVerifierSubmissionService({ reader, signer, authorizedVerifier: "verifier.attestra-owner.testnet", verificationStorageDeposit: "1", submissionStore });
}

function verifiedReader(record: StoredExecution, digest: string, receiptId: string, overrides: Partial<VerifierChainReader> = {}): VerifierChainReader {
  return chainReader({
    getMilestone: vi.fn(async () => ({ projectId: 0, milestoneId: 0, recipient: "recipient.testnet", budget: "10000000000000000000000", dependencies: [], status: "VerificationPassed" as const, verification: { projectId: 0, milestoneId: 0, deliverableDigest: digest, receiptId, result: "Passed" as const, verifier: "verifier.attestra-owner.testnet" } })),
    ...overrides,
  });
}

describe("backend verifier submission boundary", () => {
  it("validates a passing v4 receipt but refuses to submit without a server signer", async () => {
    const { record } = await fixture();
    await expect(service(chainReader()).submit(record)).rejects.toMatchObject({ code: "VERIFIER_SIGNER_NOT_CONFIGURED" });
  });

  it("rejects a receipt from another verifier version", async () => {
    const { record } = await fixture();
    record.verificationState!.receipt!.verifier.implementationVersion = "attestra-independent-verifier-v3";
    await expect(service(chainReader()).submit(record)).rejects.toMatchObject({ code: "VERIFIER_VERSION_MISMATCH" });
  });

  it("uses the latest passing attempt after an earlier rejection", async () => {
    const { record, receipt } = await fixture();
    const rejected = { ...record.verificationState!, attemptId: "attempt-rejected", status: "rejected" as const, result: "Failed" as const, receipt: { ...receipt, receiptId: "rejected-receipt", result: "Failed" as const } };
    record.verificationHistory = [rejected, record.verificationState!];
    const submit = vi.fn(async () => ({ hash: "tx-latest-passing" }));
    const result = await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }).submit(record);
    expect(result).toMatchObject({ state: "pending", receiptId: receipt.receiptId });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("never submits a rejected or superseded receipt", async () => {
    const { record, receipt } = await fixture();
    const rejected = { ...record.verificationState!, attemptId: "attempt-rejected", status: "rejected" as const, result: "Failed" as const, receipt: { ...receipt, receiptId: "rejected-receipt", result: "Failed" as const } };
    record.verificationState = rejected;
    record.verificationHistory = [rejected];
    record.verification = rejected.receipt;
    const submit = vi.fn(async () => ({ hash: "should-not-submit" }));
    await expect(service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }).submit(record)).rejects.toMatchObject({ code: "PASSING_RECEIPT_REQUIRED" });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["project", (record: StoredExecution) => { record.onChainLinkage!.onChainProjectId = "1"; }],
    ["milestone", (record: StoredExecution) => { record.verificationState!.receipt!.milestoneId = "1"; }],
    ["owner", (record: StoredExecution) => { record.onChainLinkage!.ownerAccountId = "other.testnet"; }],
    ["recipient", (record: StoredExecution) => { record.onChainLinkage!.recipientAccountId = "other.testnet"; }],
    ["budget", (record: StoredExecution) => { record.onChainLinkage!.milestoneBudget = "1"; }],
  ])("rejects a mismatched %s binding", async (_field, mutate) => {
    const { record } = await fixture();
    mutate(record);
    await expect(service(chainReader()).submit(record)).rejects.toBeInstanceOf(VerifierSubmissionError);
  });

  it("deduplicates concurrent signer calls with one idempotency key", async () => {
    const { record } = await fixture();
    const submit = vi.fn(async () => ({ hash: "tx-1" }));
    const verifier = service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit });
    const [first, second] = await Promise.all([verifier.submit(record), verifier.submit(record)]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "pending", transactionHash: "tx-1" });
  });

  it("preserves a pending submission across an API restart", async () => {
    const { record } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const firstStore = VerifierSubmissionStore.openSync(path);
    const firstSubmit = vi.fn(async () => ({ hash: "tx-persisted" }));
    const first = await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit: firstSubmit }, firstStore).submit(record);
    expect(first).toMatchObject({ state: "pending", transactionHash: "tx-persisted" });

    const restartedStore = VerifierSubmissionStore.openSync(path);
    const secondSubmit = vi.fn(async () => ({ hash: "tx-duplicate" }));
    const second = await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit: secondSubmit }, restartedStore).submit(record);
    expect(second).toEqual(first);
    expect(secondSubmit).not.toHaveBeenCalled();
  });

  it("durably preserves a reserved intent if the process stops before signer invocation", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const key = `${record.executionId}:${receipt.receiptId}:${digest}`;
    await store.reserve(key, { state: "pending", recoveryState: "reserved", executionId: record.executionId, receiptId: receipt.receiptId, artifactDigest: digest, createdAt: new Date(0).toISOString() });
    const submit = vi.fn(async () => ({ hash: "must-not-submit" }));
    const result = await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, store).submit(record);
    expect(result).toMatchObject({ state: "pending", recoveryState: "reserved" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not rebroadcast a persisted broadcast attempt with no hash after restart", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const key = `${record.executionId}:${receipt.receiptId}:${digest}`;
    await store.reserve(key, { state: "pending", recoveryState: "broadcast_attempted", executionId: record.executionId, receiptId: receipt.receiptId, artifactDigest: digest, createdAt: new Date(0).toISOString(), broadcastAttemptedAt: new Date(1).toISOString() });
    const submit = vi.fn(async () => ({ hash: "duplicate" }));
    const result = await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, VerifierSubmissionStore.openSync(path)).submit(record);
    expect(result).toMatchObject({ state: "pending", recoveryState: "broadcast_attempted" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("marks an ambiguous signer timeout unknown and does not retry it", async () => {
    const { record } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const submit = vi.fn(async () => { throw new Error("network timeout"); });
    const verifier = service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, store);
    await expect(verifier.submit(record)).rejects.toThrow("network timeout");
    expect(store.get("exec-1:attest-v4-test:" + (await fixture()).digest)?.recoveryState).toBe("unknown");
    await expect(verifier.submit(record)).resolves.toMatchObject({ state: "unknown", recoveryState: "unknown" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not expose an unpersisted hash after durable persistence fails", async () => {
    const { record, receipt, digest } = await fixture();
    let persisted: PersistedVerifierSubmission | undefined;
    let failHashPersistence = true;
    const store: VerifierSubmissionStoreLike = {
      get: () => persisted,
      reserve: async (idempotencyKey, initial) => { if (persisted) return { created: false, submission: persisted }; persisted = { ...initial, idempotencyKey }; return { created: true, submission: persisted }; },
      update: async (_idempotencyKey, patch) => { if (failHashPersistence && (patch.recoveryState === "transaction_known" || patch.recoveryState === "unknown")) throw new Error("database unavailable"); persisted = { ...persisted!, ...patch }; return persisted; },
      markUnknown: async (idempotencyKey, error) => { persisted = { ...persisted!, idempotencyKey, state: "unknown", recoveryState: "unknown", error }; return persisted; },
    };
    const submit = vi.fn(async () => ({ hash: "tx-not-persisted" }));
    const verifier = service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, store);
    await expect(verifier.submit(record)).rejects.toThrow("database unavailable");
    failHashPersistence = false;
    await expect(verifier.submit(record)).resolves.toMatchObject({ state: "pending", recoveryState: "broadcast_attempted" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(persisted?.transactionHash).toBeUndefined();
  });

  it("requires the signer account to equal the contract authorized verifier", async () => {
    const { record } = await fixture();
    await expect(service(chainReader(), { accountId: "owner.testnet", submit: vi.fn() }).submit(record)).rejects.toMatchObject({ code: "VERIFIER_SIGNER_MISMATCH" });
  });

  it("only marks a transaction finalized when receipt arguments and chain state match", async () => {
    const { record, receipt, digest } = await fixture();
    const args = Buffer.from(JSON.stringify({ project_id: 0, milestone_id: 0, deliverable_digest: digest, receipt_id: receipt.receiptId, result: "Passed" })).toString("base64");
    const tx: NearTransaction = { hash: "tx-1", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "FINAL", status: {}, success: true, actions: [{ type: "FunctionCall", methodName: "submit_verification", argsBase64: args, deposit: "1" }] };
    const reader = chainReader({ getTransaction: vi.fn(async () => tx), getMilestone: vi.fn(async () => ({ projectId: 0, milestoneId: 0, recipient: "recipient.testnet", budget: "10000000000000000000000", dependencies: [], status: "VerificationPassed" as const, verification: { projectId: 0, milestoneId: 0, deliverableDigest: digest, receiptId: receipt.receiptId, result: "Passed" as const, verifier: "verifier.attestra-owner.testnet" } })) });
    const result = await service(reader).reconcile(record, "tx-1");
    expect(result.state).toBe("finalized");
  });

  it("persists successful known-hash reconciliation", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const submit = vi.fn(async () => ({ hash: "tx-known" }));
    const reader = verifiedReader(record, digest, receipt.receiptId, { getTransaction: vi.fn(async () => ({ hash: "tx-known", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "FINAL", status: {}, success: true, actions: [{ type: "FunctionCall", methodName: "submit_verification", argsBase64: Buffer.from(JSON.stringify({ project_id: 0, milestone_id: 0, deliverable_digest: digest, receipt_id: receipt.receiptId, result: "Passed" })).toString("base64"), deposit: "1" }] })) });
    await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, store).submit(record);
    await expect(service(reader, undefined, store).reconcile(record, "tx-known")).resolves.toMatchObject({ state: "finalized", recoveryState: "finalized", transactionHash: "tx-known" });
    expect(store.get("exec-1:attest-v4-test:" + digest)).toMatchObject({ state: "finalized", recoveryState: "finalized", transactionHash: "tx-known" });
  });

  it("persists a known-hash on-chain failure as definitive failure", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const tx = { hash: "tx-failed", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "FINAL", status: {}, success: false, actions: [{ type: "FunctionCall" as const, methodName: "submit_verification" as const, argsBase64: Buffer.from(JSON.stringify({ project_id: 0, milestone_id: 0, deliverable_digest: digest, receipt_id: receipt.receiptId, result: "Passed" })).toString("base64"), deposit: "1" }] };
    const reader = chainReader({ getTransaction: vi.fn(async () => tx) });
    await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit: vi.fn(async () => ({ hash: "tx-failed" })) }, store).submit(record);
    await expect(service(verifiedReader(record, digest, receipt.receiptId, { getTransaction: vi.fn(async () => tx) }), undefined, store).reconcile(record, "tx-failed")).resolves.toMatchObject({ state: "failed", recoveryState: "definitive_failure" });
  });

  it("finalizes matching on-chain receipt state without fabricating a hash", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit: vi.fn(async () => ({ hash: "never-used" })) }, store).submit(record);
    const result = await service(verifiedReader(record, digest, receipt.receiptId), undefined, store).reconcile(record);
    expect(result).toMatchObject({ state: "finalized", recoveryState: "receipt_confirmed_without_hash" });
    expect(result.transactionHash).toBeUndefined();
  });

  it("persists unknown reconciliation and remains safe on repeated attempts", async () => {
    const { record, receipt, digest } = await fixture();
    const path = join(mkdtempSync(join(tmpdir(), "attestra-verifier-")), "submissions.json");
    const store = VerifierSubmissionStore.openSync(path);
    const submit = vi.fn(async () => ({ hash: "tx-unknown" }));
    const reader = verifiedReader(record, digest, receipt.receiptId, { getTransaction: vi.fn(async () => ({ hash: "tx-unknown", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "FINAL", status: {}, success: true, actions: [] })) });
    await service(chainReader(), { accountId: "verifier.attestra-owner.testnet", submit }, store).submit(record);
    await expect(service(reader, undefined, store).reconcile(record, "tx-unknown")).resolves.toMatchObject({ state: "unknown", recoveryState: "unknown" });
    await expect(service(reader, undefined, store).reconcile(record, "tx-unknown")).resolves.toMatchObject({ state: "unknown", recoveryState: "unknown" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("returns unknown for a successful transaction with tampered arguments", async () => {
    const { record, receipt, digest } = await fixture();
    const tx: NearTransaction = { hash: "tx-2", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "FINAL", status: {}, success: true, actions: [{ type: "FunctionCall", methodName: "submit_verification", argsBase64: Buffer.from(JSON.stringify({ project_id: 9, milestone_id: 0, deliverable_digest: receipt.artifactDigest, receipt_id: receipt.receiptId, result: "Passed" })).toString("base64"), deposit: "1" }] };
    const result = await service(chainReader({ getTransaction: vi.fn(async () => tx), getMilestone: vi.fn(async () => ({ projectId: 0, milestoneId: 0, recipient: "recipient.testnet", budget: "10000000000000000000000", dependencies: [], status: "VerificationPassed" as const, verification: { projectId: 0, milestoneId: 0, deliverableDigest: digest, receiptId: receipt.receiptId, result: "Passed" as const, verifier: "verifier.attestra-owner.testnet" } })) })).reconcile(record, "tx-2");
    expect(result.state).toBe("unknown");
  });

  it("rejects a known transaction that is not at FINAL execution status", async () => {
    const { record, receipt, digest } = await fixture();
    const tx: NearTransaction = { hash: "tx-not-final", signerId: "verifier.attestra-owner.testnet", receiverId: "escrow.attestra-owner.testnet", finalExecutionStatus: "EXECUTED", status: {}, success: true, actions: [{ type: "FunctionCall", methodName: "submit_verification", argsBase64: Buffer.from(JSON.stringify({ project_id: 0, milestone_id: 0, deliverable_digest: digest, receipt_id: receipt.receiptId, result: "Passed" })).toString("base64"), deposit: "1" }] };
    const result = await service(chainReader({ getTransaction: vi.fn(async () => tx), getMilestone: vi.fn(async () => ({ projectId: 0, milestoneId: 0, recipient: "recipient.testnet", budget: "10000000000000000000000", dependencies: [], status: "VerificationPassed" as const, verification: { projectId: 0, milestoneId: 0, deliverableDigest: digest, receiptId: receipt.receiptId, result: "Passed" as const, verifier: "verifier.attestra-owner.testnet" } })) })).reconcile(record, "tx-not-final");
    expect(result).toMatchObject({ state: "unknown", recoveryState: "unknown" });
  });
});
