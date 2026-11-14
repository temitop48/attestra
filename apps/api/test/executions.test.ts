import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ExecutionStore } from "../src/store.js";
import { NearReadonlyAdapter } from "@attestra/near-readonly";
import { nep413Digest } from "../src/auth.js";
import { computeArtifactDigest } from "@attestra/orchestrator";

const paths: string[] = [];
function databasePath(): string { const directory = mkdtempSync(join(tmpdir(), "attestra-api-")); paths.push(directory); return join(directory, "executions.json"); }
async function waitForCompletion(app: Awaited<ReturnType<typeof buildApp>>, executionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) { const response = await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}`, remoteAddress: `127.0.0.${(attempt % 200) + 2}` }); const body = response.json(); if (body.lifecycle === "completed") return body; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Execution did not complete in time");
}
function project() { return { projectId: "101", requirements: "Create an ATTESTRA landing page with hero and features sections", targetAudience: "builders", constraints: ["static HTML and CSS"] }; }
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(value: Uint8Array): string { const digits = [0]; for (const byte of value) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = (digits[i] ?? 0) * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } } let result = ""; for (const byte of value) { if (byte !== 0) break; result += "1"; } for (let i = digits.length - 1; i >= 0; i -= 1) result += alphabet[digits[i] ?? 0]; return result; }
async function authenticate(app: Awaited<ReturnType<typeof buildApp>>, accountId = "owner.testnet"): Promise<string> { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); const publicBytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)); const publicKeyString = `ed25519:${base58(publicBytes)}`; const challenge = await app.inject({ method: "GET", url: "/api/v1/auth/challenge" }); const body = challenge.json(); const signature = sign(null, nep413Digest(body.message, body.recipient, Buffer.from(body.nonce, "base64url")), privateKey).toString("base64"); const response = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: body.challengeId, signedMessage: { accountId, publicKey: publicKeyString, signature } } }); const cookie = response.headers["set-cookie"]; return Array.isArray(cookie) ? cookie[0]! : cookie!; }

afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("execution API", () => {
  it("protects execution reads, preserves owner access, and supports a separate operator read token", async () => {
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async (_url, request) => request.method === "query" && (request.params as Record<string, unknown>).request_type === "view_access_key" ? { result: { permission: "FullAccess" } } : { result: { chain_id: "testnet" } } });
    const store = ExecutionStore.openSync(databasePath());
    const app = buildApp({ store, nearAdapter: adapter, demoMode: true, executionReadToken: "operator-read-token", allowLocalExecutionReads: false });
    try {
      const ownerCookie = (await authenticate(app, "owner.testnet")).split(";", 1)[0]!;
      const created = await app.inject({ method: "POST", url: "/api/v1/executions", headers: { cookie: ownerCookie }, payload: project() });
      const executionId = created.json().executionId as string;
      expect((await app.inject({ method: "GET", url: "/api/v1/executions" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}` })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/v1/executions", headers: { cookie: ownerCookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}`, headers: { cookie: ownerCookie } })).statusCode).toBe(200);
      const intruderCookie = (await authenticate(app, "intruder.testnet")).split(";", 1)[0]!;
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}`, headers: { cookie: intruderCookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}`, headers: { "x-attestra-execution-read-token": "wrong-token" } })).statusCode).toBe(401);
      const operatorHeaders = { "x-attestra-execution-read-token": "operator-read-token" };
      expect((await app.inject({ method: "GET", url: "/api/v1/executions", headers: operatorHeaders })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}/events`, headers: operatorHeaders }))).toMatchObject({ statusCode: 200 });
      expect((await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}/verification`, headers: operatorHeaders }))).toMatchObject({ statusCode: 200 });
    } finally { await app.close(); }
  });

  it("exposes read-only NEAR status and preserves unlinked executions", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: true });
    const status = await app.inject({ method: "GET", url: "/api/v1/near/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ configured: false, readOnly: true, network: "testnet" });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const chain = await app.inject({ method: "GET", url: `/api/v1/executions/${created.json().executionId}/chain` });
    expect(chain.statusCode).toBe(200);
    expect(chain.json()).toMatchObject({ confirmed: false, linkage: { status: "unlinked", network: "testnet" } });
    await app.close();
  });

  it("reads confirmed chain state and fails closed on recipient or budget mismatch", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path);
    const encoded = (value: unknown) => [...new TextEncoder().encode(JSON.stringify(value))];
    const projectView = { project_id: 7, owner: "owner.testnet", total_funded: "900719925474099300000000", available_balance: "0", reserved_balance: "900719925474099300000000", paid_balance: "0", refunded_balance: "0", pending_refund_balance: "0", next_milestone_id: 1, pending_payment: null, pending_refund: null, storage_deposit: "1" };
    const milestoneView = { project_id: 7, milestone_id: 0, recipient: "recipient.testnet", budget: "900719925474099300000000", dependencies: [], status: "InProgress", verification: null, approval_receipt_id: null };
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async (_url, request) => request.method === "status" ? { result: { chain_id: "testnet", sync_info: { latest_block_height: 10 } } } : { result: { result: encoded(request.params.method_name === "get_project" ? projectView : milestoneView) } } });
    const app = buildApp({ store, demoMode: true, nearAdapter: adapter });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() }); const executionId = created.json().executionId;
    const record = store.get(executionId)!; await store.setOnChainLinkage(executionId, { executionId, network: "testnet", contractAccountId: "escrow.testnet", onChainProjectId: "7", onChainMilestoneId: "0", offChainMilestoneId: record.milestoneId!, ownerAccountId: "owner.testnet", recipientAccountId: "recipient.testnet", milestoneBudget: "900719925474099300000000", projectCreationTransactionHash: "tx-project", milestoneRegistrationTransactionHash: "tx-milestone", fundingTransactionHash: "tx-funding", status: "pending" });
    await store.confirmOnChainLinkage(executionId, adapter);
    const state = await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}/chain/state` });
    expect(state.statusCode).toBe(200); expect(state.json()).toMatchObject({ confirmed: true, state: { project: { totalFunded: "900719925474099300000000" }, milestone: { budget: "900719925474099300000000" } } });
    const mismatchAdapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async (_url, request) => request.method === "status" ? { result: { chain_id: "testnet" } } : { result: { result: encoded(request.params.method_name === "get_project" ? projectView : { ...milestoneView, budget: "1" }) } } });
    const mismatchApp = buildApp({ store, nearAdapter: mismatchAdapter });
    const mismatch = await mismatchApp.inject({ method: "GET", url: `/api/v1/executions/${executionId}/chain/state` });
    expect(mismatch.statusCode).toBe(502); expect(mismatch.json().error.code).toBe("CHAIN_LINKAGE_MISMATCH");
    await mismatchApp.close(); await app.close();
  });

  it("issues safe lifecycle intents and reconciles finalized fund, activate, and start transactions", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const budget = "10000000000000000000000"; const funded = "20000000000000000000000";
    let milestoneStatus = "Created"; let projectView = { project_id: 7, owner: "owner.testnet", total_funded: "0", available_balance: "0", reserved_balance: "0", paid_balance: "0", refunded_balance: "0", pending_refund_balance: "0", next_milestone_id: 1, pending_payment: null, pending_refund: null, storage_deposit: "1" };
    let milestoneVerification: Record<string, unknown> | null = null; let approvalReceiptId: string | null = null;
    const milestoneView = () => ({ project_id: 7, milestone_id: 0, recipient: "recipient.testnet", budget, dependencies: [], status: milestoneStatus, verification: milestoneVerification, approval_receipt_id: approvalReceiptId });
    const txByHash = new Map<string, unknown>(); const encoded = (value: unknown) => [...new TextEncoder().encode(JSON.stringify(value))];
    const tx = (hash: string, methodName: string, args: Record<string, unknown>, deposit: string, options: { signer?: string; receiver?: string; finalStatus?: string } = {}) => ({ result: { transaction: { hash, signer_id: options.signer ?? "owner.testnet", receiver_id: options.receiver ?? "escrow.testnet", actions: [{ FunctionCall: { method_name: methodName, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit } }] }, final_execution_status: options.finalStatus ?? "FINAL", status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessReceiptId: "receipt" } } }], transaction_outcome: { block_hash: "block" } } });
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async (_url, request) => {
      if (request.method === "status") return { result: { chain_id: "testnet" } };
      if (request.method === "tx") return txByHash.get((request.params as unknown[])[0] as string);
      const params = request.params as Record<string, unknown>;
      if (params.request_type === "view_access_key") return { result: { permission: "FullAccess" } };
      return { result: { result: encoded(params.method_name === "get_project" ? projectView : milestoneView()) } };
    } });
    const previous = { contract: process.env.NEAR_ESCROW_CONTRACT_ACCOUNT, network: process.env.NEAR_NETWORK, projectDeposit: process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO, milestoneDeposit: process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO, verifier: process.env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID, verificationDeposit: process.env.NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO, approvalDeposit: process.env.NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO, settlementDeposit: process.env.NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO };
    process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = "escrow.testnet"; process.env.NEAR_NETWORK = "testnet"; process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO = "1"; process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO = "1"; process.env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID = "verifier.testnet"; process.env.NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO = "1"; process.env.NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO = "1"; process.env.NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO = "1";
    const app = buildApp({ store, nearAdapter: adapter, demoMode: true }); const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() }); const executionId = created.json().executionId; const record = store.get(executionId)!;
    await store.setOnChainLinkage(executionId, { executionId, network: "testnet", contractAccountId: "escrow.testnet", onChainProjectId: "7", onChainMilestoneId: "0", offChainMilestoneId: record.milestoneId!, ownerAccountId: "owner.testnet", recipientAccountId: "recipient.testnet", milestoneBudget: budget, projectCreationTransactionHash: "tx-project", milestoneRegistrationTransactionHash: "tx-milestone", status: "pending" }); await store.confirmOnChainLinkage(executionId, adapter);
    const cookie = await authenticate(app); const headers = { cookie }; const inject = (options: Parameters<typeof app.inject>[0]) => app.inject({ ...options, remoteAddress: "127.0.0.77" });
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "fund", amount: "0" } })).statusCode).toBe(409);
    const fundIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "fund", amount: funded } }); expect(fundIntent.statusCode).toBe(200); expect(fundIntent.json()).toMatchObject({ methodName: "fund_project", deposit: funded, args: { project_id: 7 } });
    txByHash.set("tx-fund", tx("tx-fund", "fund_project", { project_id: 7 }, funded)); projectView = { ...projectView, total_funded: funded, available_balance: funded }; const fund = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "fund", amount: funded, transactionHash: "tx-fund" } }); expect(fund.statusCode).toBe(200);
    const activationIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "activate" } }); expect(activationIntent.json()).toMatchObject({ methodName: "activate_milestone", deposit: "1", args: { project_id: 7, milestone_id: 0 } });
    txByHash.set("tx-activate", tx("tx-activate", "activate_milestone", { project_id: 7, milestone_id: 0 }, "1")); milestoneStatus = "Funded"; projectView = { ...projectView, available_balance: "10000000000000000000000", reserved_balance: budget }; const activation = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "activate", transactionHash: "tx-activate" } }); expect(activation.statusCode).toBe(200); expect(activation.json().state.milestone.status).toBe("Funded");
    const startIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "start" } }); expect(startIntent.json()).toMatchObject({ methodName: "start_milestone", deposit: "1" });
    txByHash.set("tx-start", tx("tx-start", "start_milestone", { project_id: 7, milestone_id: 0 }, "1")); milestoneStatus = "InProgress"; const started = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "start", transactionHash: "tx-start" } }); expect(started.statusCode).toBe(200); expect(started.json().state.milestone.status).toBe("InProgress");
    const artifacts = [{ path: "index.html", mediaType: "text/html" as const, content: "<html></html>" }]; const digest = await computeArtifactDigest(artifacts); const receipt = { receiptId: "receipt-pass", projectId: "7", milestoneId: "0", artifactDigest: digest, result: "Passed" as const, checks: [{ id: "deterministic", name: "All mandatory checks", required: true, status: "passed" as const, message: "passed" }], timestamp: new Date().toISOString(), policyVersion: "verification-policy-v1" as const, verifier: { engineId: "attestra-independent-verifier-v4", implementationVersion: "attestra-independent-verifier-v4", llmReview: "disabled" as const } };
    const updatedRecord = store.get(executionId)!; await store.update({ ...updatedRecord, status: "AwaitingIndependentVerification", lifecycle: "completed", finalDeliverable: { revision: 1, digest, canonicalFormat: "attestra-artifacts-v2", artifacts, totalBytes: 13 }, verification: receipt, verificationState: { attemptId: "attempt-pass", executionId, status: "verified", revision: 1, artifactDigest: digest, policyVersion: "verification-policy-v1", verifierImplementationVersion: "attestra-independent-verifier-v4", requestedAt: receipt.timestamp, completedAt: receipt.timestamp, result: "Passed", receipt }, verificationHistory: [{ attemptId: "attempt-pass", executionId, status: "verified", revision: 1, artifactDigest: digest, policyVersion: "verification-policy-v1", verifierImplementationVersion: "attestra-independent-verifier-v4", requestedAt: receipt.timestamp, completedAt: receipt.timestamp, result: "Passed", receipt }] });
    const verifierHeaders = { cookie: await authenticate(app, "verifier.testnet") }; expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "submit_verification" } })).statusCode).toBe(409); const verifierIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers: verifierHeaders, payload: { operation: "submit_verification" } }); expect(verifierIntent.statusCode).toBe(200); expect(verifierIntent.json()).toMatchObject({ methodName: "submit_verification", deposit: "1", args: { project_id: 7, milestone_id: 0, deliverable_digest: digest, receipt_id: "receipt-pass", result: "Passed" } });
    txByHash.set("tx-verification", tx("tx-verification", "submit_verification", { project_id: 7, milestone_id: 0, deliverable_digest: digest, receipt_id: "receipt-pass", result: "Passed" }, "1", { signer: "verifier.testnet" })); milestoneStatus = "VerificationPassed"; milestoneVerification = { project_id: 7, milestone_id: 0, deliverable_digest: digest, receipt_id: "receipt-pass", result: "Passed", verifier: "verifier.testnet" }; const verified = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers: verifierHeaders, payload: { operation: "submit_verification", transactionHash: "tx-verification" } }); expect(verified.statusCode, JSON.stringify(verified.json())).toBe(200);
    const approvalIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "approve" } }); expect(approvalIntent.statusCode).toBe(200); expect(approvalIntent.json()).toMatchObject({ methodName: "approve_milestone", deposit: "1", args: { receipt_id: "receipt-pass" } }); txByHash.set("tx-approval", tx("tx-approval", "approve_milestone", { project_id: 7, milestone_id: 0, receipt_id: "receipt-pass" }, "1")); milestoneStatus = "OwnerApproved"; approvalReceiptId = "receipt-pass"; const approved = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "approve", transactionHash: "tx-approval" } }); expect(approved.statusCode).toBe(200);
    const settlementIntent = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "settle" } }); expect(settlementIntent.statusCode).toBe(200); expect(settlementIntent.json()).toMatchObject({ methodName: "settle_milestone", deposit: "1" }); txByHash.set("tx-settle", tx("tx-settle", "settle_milestone", { project_id: 7, milestone_id: 0 }, "1")); projectView = { ...projectView, pending_payment: 0 }; milestoneStatus = "PaymentPending"; const settled = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "settle", transactionHash: "tx-settle" } }); expect(settled.statusCode).toBe(200); expect(settled.json().paymentStatus).toBe("PaymentPending"); projectView = { ...projectView, pending_payment: null, reserved_balance: "0", paid_balance: budget }; milestoneStatus = "Paid"; const paid = await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "settle", transactionHash: "tx-settle" } }); expect(paid.statusCode).toBe(200); expect(paid.json().state.milestone.status).toBe("Paid");
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/intent`, headers, payload: { operation: "start" } })).statusCode).toBe(409);
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "fund", amount: funded, transactionHash: "tx-fund" } })).statusCode).toBe(409);
    const wrongSigner = tx("tx-wrong-signer", "start_milestone", { project_id: 7, milestone_id: 0 }, "1") as { result: { transaction: { signer_id: string } } }; wrongSigner.result.transaction.signer_id = "intruder.testnet"; txByHash.set("tx-wrong-signer", wrongSigner);
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "start", transactionHash: "tx-wrong-signer" } })).statusCode).toBe(409);
    const wrongContract = tx("tx-wrong-contract", "start_milestone", { project_id: 7, milestone_id: 0 }, "1") as { result: { transaction: { receiver_id: string } } }; wrongContract.result.transaction.receiver_id = "other.testnet"; txByHash.set("tx-wrong-contract", wrongContract);
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "start", transactionHash: "tx-wrong-contract" } })).statusCode).toBe(409);
    const failed = tx("tx-failed", "start_milestone", { project_id: 7, milestone_id: 0 }, "1") as { result: { final_execution_status: string } }; failed.result.final_execution_status = "FAILURE"; txByHash.set("tx-failed", failed);
    expect((await inject({ method: "POST", url: `/api/v1/executions/${executionId}/chain/reconcile`, headers, payload: { operation: "start", transactionHash: "tx-failed" } })).statusCode).toBe(409);
    expect(store.get(executionId)?.onChainLinkage).toMatchObject({ fundingTransactionHash: "tx-fund", activationTransactionHash: "tx-activate", startTransactionHash: "tx-start" }); await app.close();
    if (previous.contract === undefined) delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; else process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = previous.contract; if (previous.network === undefined) delete process.env.NEAR_NETWORK; else process.env.NEAR_NETWORK = previous.network; if (previous.projectDeposit === undefined) delete process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO; else process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO = previous.projectDeposit; if (previous.milestoneDeposit === undefined) delete process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO; else process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO = previous.milestoneDeposit; if (previous.verifier === undefined) delete process.env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID; else process.env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID = previous.verifier; if (previous.verificationDeposit === undefined) delete process.env.NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO; else process.env.NEAR_VERIFICATION_STORAGE_DEPOSIT_YOCTO = previous.verificationDeposit; if (previous.approvalDeposit === undefined) delete process.env.NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO; else process.env.NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO = previous.approvalDeposit; if (previous.settlementDeposit === undefined) delete process.env.NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO; else process.env.NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO = previous.settlementDeposit;
  });

  it("reports health and creates a successful demo execution", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: true });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    expect(created.statusCode).toBe(202);
    const execution = await waitForCompletion(app, created.json().executionId);
    expect(execution.status).toBe("AwaitingIndependentVerification");
    expect(execution.milestoneId).toBe("0");
    expect(execution.milestoneIdentity).toMatchObject({ status: "authoritative", source: "server_assigned", onChainLinked: false });
    expect(execution.finalDeliverable.digest).toHaveLength(64);
    expect(execution.qaAssessments).toHaveLength(1);
    expect(execution.qaAssessments[0]).toMatchObject({ revision: 1, passed: true });
    expect(execution.validationReports).toHaveLength(1);
    expect(execution.validationReports[0]).toMatchObject({ revision: 1, artifactDigest: execution.revisions[0]?.digest, version: "html-validation-v1" });
    await app.close();
  });

  it("rejects invalid requests and supports paginated listing", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: true });
    const invalid = await app.inject({ method: "POST", url: "/api/v1/executions", payload: { requirements: "" } });
    expect(invalid.statusCode).toBe(400);
    await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const listed = await app.inject({ method: "GET", url: "/api/v1/executions?offset=0&limit=1" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    await app.close();
  });

  it("persists artifacts, events, verification, and prevents duplicate verification", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const events = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/events` });
    expect(events.json().events.some((event: { type: string }) => event.type === "deliverable_ready")).toBe(true);
    const artifacts = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/artifacts` });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().digest).toBe(execution.finalDeliverable.digest);
    const conflictingMilestone = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { milestoneId: "7", criteria: { requiredSections: ["hero", "features"], acceptanceCriteria: ["ATTESTRA", "responsive"], requireAccessibility: true } } });
    expect(conflictingMilestone.statusCode).toBe(409);
    expect(conflictingMilestone.json().error.code).toBe("MILESTONE_ID_CONFLICT");
    const verify = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { milestoneId: "0", criteria: { requiredSections: ["hero", "features"], acceptanceCriteria: ["ATTESTRA", "responsive"], requireAccessibility: true } } });
    expect(verify.statusCode).toBe(201);
    expect(verify.json().result).toBe("Passed");
    const duplicate = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().receiptId).toBe(verify.json().receiptId);
    const fetched = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/verification` });
    expect(fetched.json().artifactDigest).toBe(execution.finalDeliverable.digest);
    expect(fetched.json().history).toHaveLength(1);
    expect(fetched.json().history[0].verifierImplementationVersion).toBe("attestra-independent-verifier-v4");
    await app.close();
    const restarted = buildApp({ databasePath: path, demoMode: true });
    expect((await restarted.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}` })).statusCode).toBe(200);
    await restarted.close();
  });

  it("fails closed for unauthorized writes and never starts verification on GET", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: true, allowLocalVerificationWrites: false });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const executionId = created.json().executionId;
    const status = await app.inject({ method: "GET", url: `/api/v1/executions/${executionId}/verification` });
    expect(status.json()).toMatchObject({ status: "not_requested" });
    const write = await app.inject({ method: "POST", url: `/api/v1/executions/${executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(write.statusCode).toBe(403);
    await app.close();
  });

  it("rejects policy overrides and ineligible or unsafe final records", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const record = store.get(execution.executionId)!;
    const override = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { policy: { llmReview: "optional" }, criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(override.statusCode).toBe(400);
    record.qaAssessments[0]!.passed = false; await store.update(record);
    const rejectedQa = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(rejectedQa.statusCode).toBe(409);
    expect(rejectedQa.json().error.code).toBe("QA_NOT_APPROVED");
    record.qaAssessments[0]!.passed = true; record.finalDeliverable!.artifacts[0]!.content += " changed"; await store.update(record);
    const mismatch = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    await app.close();
  });

  it("persists rejected receipts, handles concurrent requests, and blocks deterministic failures", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const first = app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["not-present-in-artifact"] } } });
    const second = app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["not-present-in-artifact"] } } });
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const receipt = responses.find((response) => response.statusCode === 201)!.json();
    expect(receipt.result).toBe("Failed");
    const fetched = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/verification` });
    expect(fetched.json()).toMatchObject({ status: "rejected", receipt: { receiptId: receipt.receiptId } });
    const record = store.get(execution.executionId)!;
    record.verification = undefined; record.verificationState = undefined; record.validationReports[0]!.summary.blockingFailures = 1; await store.update(record);
    const blocked = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("BLOCKING_VALIDATION_FAILURE");
    await app.close();
  });

  it("requires a reason and creates an auditable re-verification after a legacy attempt", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const first = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(first.statusCode).toBe(201);
    const firstReceipt = first.json();
    const record = store.get(execution.executionId)!;
    const legacyReceipt = { ...firstReceipt, verifier: { ...firstReceipt.verifier } };
    delete legacyReceipt.verifier.implementationVersion;
    const legacyAttempt = { ...record.verificationHistory![0]!, verifierImplementationVersion: undefined, receipt: legacyReceipt };
    record.verification = legacyReceipt;
    record.verificationState = legacyAttempt;
    record.verificationHistory = [legacyAttempt];
    await store.update(record);
    const missingReason = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.json().error.code).toBe("REVERIFICATION_REASON_REQUIRED");
    const reverified = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { reverificationReason: "Corrected independent verifier implementation." } });
    expect(reverified.statusCode).toBe(201);
    expect(reverified.json().receiptId).not.toBe(firstReceipt.receiptId);
    const history = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/verification` });
    expect(history.json().history).toHaveLength(2);
    expect(history.json().history[0].verifierImplementationVersion).toBeUndefined();
    expect(history.json().history[0].receipt.receiptId).toBe(firstReceipt.receiptId);
    expect(history.json().history[1]).toMatchObject({ reVerificationReason: "Corrected independent verifier implementation.", verifierImplementationVersion: "attestra-independent-verifier-v4" });
    const attempt = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/verification/attempts/${history.json().history[1].attemptId}` });
    expect(attempt.statusCode).toBe(200);
    await app.close();
  });

  it("keeps same-version requests idempotent and does not permit retry loops", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const first = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    const duplicate = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().receiptId).toBe(first.json().receiptId);
    const retry = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { reverificationReason: "Please retry without a server version change." } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("REVERIFICATION_NOT_ELIGIBLE");
    await app.close();
  });

  it("persists an explicit provider configuration failure and does not settle on chain", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: false });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    expect(execution.status).toBe("Failed");
    expect(execution.failure.code).toBe("PROVIDER_CONFIG");
    expect(execution).not.toHaveProperty("settlement");
    await app.close();
  });

  it("reads legacy execution records without QA assessment fields", async () => {
    const path = databasePath();
    writeFileSync(path, JSON.stringify({ version: 1, executions: [{ executionId: "legacy-execution", status: "Failed", lifecycle: "completed", requirements: "legacy", constraints: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [] }] }));
    const app = buildApp({ databasePath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/executions/legacy-execution" });
    expect(response.statusCode).toBe(200);
    expect(response.json().qaAssessments).toEqual([]);
    expect(response.json().validationReports).toEqual([]);
    await app.close();
  });

  it("migrates a trustworthy legacy receipt milestone without rewriting the receipt", async () => {
    const path = databasePath();
    const receipt = { receiptId: "legacy-receipt", projectId: "1", milestoneId: "1", artifactDigest: "a".repeat(64), result: "Failed", checks: [], timestamp: "2026-01-01T00:00:00.000Z", policyVersion: "verification-policy-v1", verifier: { engineId: "legacy-v1", llmReview: "disabled" } };
    writeFileSync(path, JSON.stringify({ version: 1, executions: [{ executionId: "legacy-receipt-execution", projectId: "1", status: "AwaitingIndependentVerification", lifecycle: "completed", requirements: "legacy", constraints: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [], qaAssessments: [], validationReports: [], finalDeliverable: { revision: 1, digest: "a".repeat(64), canonicalFormat: "attestra-artifacts-v2", artifacts: [], totalBytes: 0 }, verification: receipt }] }));
    const app = buildApp({ databasePath: path, allowLocalVerificationWrites: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/executions/legacy-receipt-execution/verification" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ milestoneId: "1", history: [{ attemptId: "legacy-legacy-receipt" }], reverification: { available: false } });
    expect(response.json().history[0]).not.toHaveProperty("verifierImplementationVersion");
    expect(JSON.parse(readFileSync(path, "utf8")).executions[0].verification).toEqual(receipt);
    await app.close();
  });

  it("blocks legacy executions with no trustworthy milestone identity", async () => {
    const path = databasePath();
    writeFileSync(path, JSON.stringify({ version: 1, executions: [{ executionId: "unresolved-milestone-execution", projectId: "1", status: "AwaitingIndependentVerification", lifecycle: "completed", requirements: "legacy", constraints: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [], qaAssessments: [], validationReports: [] }] }));
    const app = buildApp({ databasePath: path });
    const response = await app.inject({ method: "POST", url: "/api/v1/executions/unresolved-milestone-execution/verify", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MILESTONE_ID_UNRESOLVED");
    await app.close();
  });

  it("derives mandatory saved implementation requirements when criteria are omitted", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const record = store.get(execution.executionId)!;
    record.research!.implementationRequirements = ["Use responsive CSS"];
    await store.update(record);
    const verify = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(verify.statusCode).toBe(201);
    expect(verify.json().result).toBe("Passed");
    expect(store.get(execution.executionId)?.verificationState?.criteriaFingerprint).toContain("Use responsive CSS");
    await app.close();
  });

  it("does not pass unsupported mandatory saved requirements", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const record = store.get(execution.executionId)!;
    record.research!.implementationRequirements = ["Use quantum rendering guarantees"];
    await store.update(record);
    const verify = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: {} });
    expect(verify.statusCode).toBe(201);
    expect(verify.json()).toMatchObject({ result: "Failed", checks: expect.arrayContaining([expect.objectContaining({ status: "skipped", message: expect.stringContaining("could not be established") })]) });
    await app.close();
  });

  it("aligns GET re-verification eligibility with POST for non-retryable errors", async () => {
    const path = databasePath(); const store = ExecutionStore.openSync(path); const app = buildApp({ store, demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: project() });
    const execution = await waitForCompletion(app, created.json().executionId);
    const record = store.get(execution.executionId)!;
    const attempt = { attemptId: "error-attempt", executionId: execution.executionId, status: "error" as const, revision: record.finalDeliverable!.revision, artifactDigest: record.finalDeliverable!.digest, policyVersion: "verification-policy-v1", verifierImplementationVersion: "attestra-independent-verifier-v4", requestedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failure: { code: "VERIFICATION_ERROR", message: "non-retryable", retryable: false, stage: "receipt" as const } };
    record.verificationState = attempt; record.verificationHistory = [attempt]; await store.update(record);
    const status = await app.inject({ method: "GET", url: `/api/v1/executions/${execution.executionId}/verification` });
    expect(status.json().reverification).toMatchObject({ available: false });
    const retry = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { reverificationReason: "retry" } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("REVERIFICATION_NOT_ELIGIBLE");
    await app.close();
  });

  it("re-verifies the saved FocusFlow fixture in an isolated store using saved requirements", async () => {
    const sourcePath = new URL("../../../apps/api/.data/executions.json", import.meta.url);
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    const focusflow = source.executions.find((item: { executionId: string }) => item.executionId === "exec-040d6b46-3698-4658-97b0-ced5aca34540");
    const historical = focusflow.verificationHistory?.[0];
    if (!historical?.receipt) throw new Error("FocusFlow historical receipt fixture is unavailable");
    focusflow.verification = historical.receipt;
    focusflow.verificationState = historical;
    focusflow.verificationHistory = [historical];
    const isolated = databasePath();
    writeFileSync(isolated, JSON.stringify(source));
    const app = buildApp({ databasePath: isolated });
    const before = JSON.parse(readFileSync(isolated, "utf8")).executions.find((item: { executionId: string }) => item.executionId === "exec-040d6b46-3698-4658-97b0-ced5aca34540").verification;
    const response = await app.inject({ method: "POST", url: "/api/v1/executions/exec-040d6b46-3698-4658-97b0-ced5aca34540/verify", payload: { reverificationReason: "Corrected verifier implementation v2 recognizes the saved responsive CSS evidence." } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ result: "Passed", milestoneId: "1", artifactDigest: "b8169d910e973a4eb5a455930d4908dfd9951c1cb4d027a5782bfef9e52108fa", verifier: { implementationVersion: "attestra-independent-verifier-v4" } });
    const after = JSON.parse(readFileSync(isolated, "utf8")).executions.find((item: { executionId: string }) => item.executionId === "exec-040d6b46-3698-4658-97b0-ced5aca34540");
    expect(after.verificationHistory).toHaveLength(2);
    expect(after.verificationHistory[0].receipt).toEqual(before);
    await app.close();
  });

  it("marks persisted in-progress verification attempts recoverably after restart", () => {
    const path = databasePath();
    writeFileSync(path, JSON.stringify({ version: 1, executions: [{ executionId: "interrupted-execution", status: "AwaitingIndependentVerification", lifecycle: "completed", requirements: "legacy", constraints: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [], verificationState: { attemptId: "attempt-1", executionId: "interrupted-execution", status: "in_progress", revision: 1, artifactDigest: "a".repeat(64), policyVersion: "verification-policy-v1", verifierImplementationVersion: "attestra-independent-verifier-v3", requestedAt: "2026-01-01T00:00:00.000Z" }, verificationHistory: [{ attemptId: "attempt-1", executionId: "interrupted-execution", status: "in_progress", revision: 1, artifactDigest: "a".repeat(64), policyVersion: "verification-policy-v1", verifierImplementationVersion: "attestra-independent-verifier-v3", requestedAt: "2026-01-01T00:00:00.000Z" }] }] }));
    const store = ExecutionStore.openSync(path);
    expect(store.get("interrupted-execution")?.verificationState).toMatchObject({ status: "error", failure: { code: "VERIFICATION_PROCESS_INTERRUPTED", retryable: true } });
    expect(store.get("interrupted-execution")?.verificationHistory?.[0]).toMatchObject({ status: "error", failure: { code: "VERIFICATION_PROCESS_INTERRUPTED" } });
  });

  it("blocks payment-eligible verification until authoritative chain binding exists", async () => {
    const app = buildApp({ databasePath: databasePath(), demoMode: true });
    const created = await app.inject({ method: "POST", url: "/api/v1/executions", payload: { ...project(), paymentEligible: true } });
    const execution = await waitForCompletion(app, created.json().executionId);
    const response = await app.inject({ method: "POST", url: `/api/v1/executions/${execution.executionId}/verify`, payload: { criteria: { requiredSections: [], acceptanceCriteria: ["ATTESTRA"] } } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHAIN_LINKAGE_REQUIRED");
    await app.close();
  });
});
