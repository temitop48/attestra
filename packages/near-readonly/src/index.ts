export type NearNetwork = "testnet";
export type NearRpcTransport = (url: string, body: NearRpcRequest) => Promise<unknown>;

export type NearRpcRequest = { jsonrpc: "2.0"; id: number; method: "status" | "query" | "tx"; params: Record<string, unknown> | unknown[] };
export type NearRpcConfig = { rpcUrl?: string; contractAccountId: string; network?: string; fetcher?: NearRpcTransport };
export type NearStatus = { network: NearNetwork; rpcUrl: string; chainId: string; latestBlockHeight?: number };
export type NearAccountState = { accountId: string; amount: string; locked: string; codeHash: string; storageUsage: number };
export type NearProject = {
  projectId: number; owner: string; totalFunded: string; availableBalance: string; reservedBalance: string;
  paidBalance: string; refundedBalance: string; pendingRefundBalance: string; nextMilestoneId: number;
  pendingPayment?: number; pendingRefund?: number; storageDeposit: string;
};
export type NearVerification = { projectId: number; milestoneId: number; deliverableDigest: string; receiptId: string; result: "Passed" | "Failed"; verifier: string };
export type NearMilestone = {
  projectId: number; milestoneId: number; recipient: string; budget: string; dependencies: number[];
  status: "Created" | "Funded" | "InProgress" | "VerificationFailed" | "VerificationPassed" | "OwnerApproved" | "PaymentPending" | "Paid" | "Cancelled" | "Refunded";
  verification?: NearVerification; approvalReceiptId?: string;
};
export type NearAccessKey = {
  accountId: string;
  publicKey: string;
  permission: "FullAccess" | "FunctionCall" | "Unknown";
  receiverId?: string;
  methodNames?: string[];
};
export type NearTransactionAction = { methodName?: string; argsBase64?: string; deposit?: string; type: "FunctionCall" | "Transfer" | "Unknown" };
export type NearTransaction = { hash: string; signerId: string; receiverId: string; actions: NearTransactionAction[]; finalExecutionStatus: string; status: unknown; success: boolean; blockHash?: string };
export type NearReadErrorCode = "UNSUPPORTED_NETWORK" | "INVALID_CONFIG" | "RPC_ERROR" | "INVALID_RPC_RESPONSE" | "CONTRACT_QUERY_ERROR";

export class NearReadError extends Error {
  constructor(public readonly code: NearReadErrorCode, message: string) { super(message); this.name = "NearReadError"; }
}

const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
const NETWORKS = new Set(["testnet"]);
const ACCOUNT_ID = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?))*$/;
const PROJECT_STATUSES = new Set(["Created", "Funded", "InProgress", "VerificationFailed", "VerificationPassed", "OwnerApproved", "PaymentPending", "Paid", "Cancelled", "Refunded"]);

function object(value: unknown, message: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new NearReadError("INVALID_RPC_RESPONSE", message); return value as Record<string, unknown>; }
function string(value: unknown, field: string): string { if (typeof value !== "string") throw new NearReadError("INVALID_RPC_RESPONSE", `Invalid ${field}`); return value; }
function integer(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new NearReadError("INVALID_RPC_RESPONSE", `Invalid ${field}`); return value; }
function amount(value: unknown, field: string): string { const result = string(value, field); if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new NearReadError("INVALID_RPC_RESPONSE", `Invalid integer amount for ${field}`); return result; }
function optionalInteger(value: unknown, field: string): number | undefined { return value === null || value === undefined ? undefined : integer(value, field); }
function base64Json(value: unknown): unknown { if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || item < 0 || item > 255)) throw new NearReadError("INVALID_RPC_RESPONSE", "Invalid contract query result"); try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(value))); } catch { throw new NearReadError("INVALID_RPC_RESPONSE", "Contract query result is not valid JSON"); } }

export function validateNearConfig(config: NearRpcConfig): { network: NearNetwork; rpcUrl: string; contractAccountId: string; fetcher: NearRpcTransport } {
  const network = config.network ?? "testnet";
  if (!NETWORKS.has(network)) throw new NearReadError("UNSUPPORTED_NETWORK", `Unsupported NEAR network: ${network}`);
  if (!config.contractAccountId || !ACCOUNT_ID.test(config.contractAccountId)) throw new NearReadError("INVALID_CONFIG", "A valid contract account ID is required");
  let url: URL;
  try { url = new URL(config.rpcUrl ?? DEFAULT_RPC_URL); } catch { throw new NearReadError("INVALID_CONFIG", "rpcUrl must be an absolute URL"); }
  const fetcher = config.fetcher ?? (async (endpoint, body) => { const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new NearReadError("RPC_ERROR", `NEAR RPC returned HTTP ${response.status}`); return response.json(); });
  return { network: "testnet", rpcUrl: url.toString(), contractAccountId: config.contractAccountId, fetcher };
}

export class NearReadonlyAdapter {
  private readonly config: ReturnType<typeof validateNearConfig>;
  constructor(config: NearRpcConfig) { this.config = validateNearConfig(config); }
  get network(): NearNetwork { return this.config.network; }
  get rpcUrl(): string { return this.config.rpcUrl; }
  get contractAccountId(): string { return this.config.contractAccountId; }
  async status(): Promise<NearStatus> { const response = await this.rpc({ method: "status", params: {} }); const result = object(response.result, "Missing NEAR status result"); const chainId = string(result.chain_id, "chain_id"); if (chainId !== "testnet") throw new NearReadError("RPC_ERROR", `NEAR RPC chain does not match configured testnet network: ${chainId}`); const sync = result.sync_info === undefined ? undefined : object(result.sync_info, "Invalid NEAR sync info"); return { network: this.network, rpcUrl: this.rpcUrl, chainId, latestBlockHeight: sync?.latest_block_height === undefined ? undefined : integer(sync.latest_block_height, "latest_block_height") }; }
  async accountState(): Promise<NearAccountState> { const response = await this.rpc({ method: "query", params: { request_type: "view_account", finality: "final", account_id: this.contractAccountId } }); const result = object(response.result, "Missing account result"); return { accountId: this.contractAccountId, amount: amount(result.amount, "amount"), locked: amount(result.locked, "locked"), codeHash: string(result.code_hash, "code_hash"), storageUsage: integer(result.storage_usage, "storage_usage") }; }
  async getProject(projectId: number): Promise<NearProject | null> { const value = await this.view("get_project", { project_id: projectId }); if (value === null) return null; const raw = object(value, "Invalid project view"); return { projectId: integer(raw.project_id, "project_id"), owner: string(raw.owner, "owner"), totalFunded: amount(raw.total_funded, "total_funded"), availableBalance: amount(raw.available_balance, "available_balance"), reservedBalance: amount(raw.reserved_balance, "reserved_balance"), paidBalance: amount(raw.paid_balance, "paid_balance"), refundedBalance: amount(raw.refunded_balance, "refunded_balance"), pendingRefundBalance: amount(raw.pending_refund_balance, "pending_refund_balance"), nextMilestoneId: integer(raw.next_milestone_id, "next_milestone_id"), pendingPayment: optionalInteger(raw.pending_payment, "pending_payment"), pendingRefund: optionalInteger(raw.pending_refund, "pending_refund"), storageDeposit: amount(raw.storage_deposit, "storage_deposit") }; }
  async getMilestone(projectId: number, milestoneId: number): Promise<NearMilestone | null> { const value = await this.view("get_milestone", { project_id: projectId, milestone_id: milestoneId }); if (value === null) return null; const raw = object(value, "Invalid milestone view"); const status = string(raw.status, "status"); if (!PROJECT_STATUSES.has(status)) throw new NearReadError("INVALID_RPC_RESPONSE", "Invalid milestone status"); const dependencies = raw.dependencies; if (!Array.isArray(dependencies) || dependencies.some((item) => !Number.isSafeInteger(item) || item < 0)) throw new NearReadError("INVALID_RPC_RESPONSE", "Invalid milestone dependencies"); const verification = raw.verification === null || raw.verification === undefined ? undefined : this.normalizeVerification(raw.verification); return { projectId: integer(raw.project_id, "project_id"), milestoneId: integer(raw.milestone_id, "milestone_id"), recipient: string(raw.recipient, "recipient"), budget: amount(raw.budget, "budget"), dependencies: dependencies as number[], status: status as NearMilestone["status"], verification, approvalReceiptId: raw.approval_receipt_id === null || raw.approval_receipt_id === undefined ? undefined : string(raw.approval_receipt_id, "approval_receipt_id") }; }
  async getAccessKey(accountId: string, publicKey: string): Promise<NearAccessKey> {
    const response = await this.rpc({ method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } });
    const result = object(response.result, "Missing access key result");
    if (result.permission === "FullAccess") return { accountId, publicKey, permission: "FullAccess" };
    if (result.permission && typeof result.permission === "object") {
      const wrapped = object(result.permission, "Invalid access key permission");
      const permission = wrapped.FunctionCall === undefined ? wrapped : object(wrapped.FunctionCall, "Invalid FunctionCall access key permission");
      const receiverId = typeof permission.receiver_id === "string" ? permission.receiver_id : undefined;
      const methodNames = Array.isArray(permission.method_names) && permission.method_names.every((item) => typeof item === "string") ? permission.method_names as string[] : undefined;
      return { accountId, publicKey, permission: "FunctionCall", receiverId, methodNames };
    }
    return { accountId, publicKey, permission: "Unknown" };
  }
  async getTransaction(hash: string, signerId: string): Promise<NearTransaction> { const response = await this.rpc({ method: "tx", params: [hash, signerId] }); const result = object(response.result, "Missing transaction result"); const transaction = object(result.transaction, "Missing transaction data"); const actions = Array.isArray(transaction.actions) ? transaction.actions.map((value) => { const raw = object(value, "Invalid transaction action"); if (raw.FunctionCall) { const call = object(raw.FunctionCall, "Invalid function call action"); return { type: "FunctionCall" as const, methodName: string(call.method_name, "method_name"), argsBase64: string(call.args, "args"), deposit: amount(call.deposit, "deposit") }; } if (raw.Transfer) { const transfer = object(raw.Transfer, "Invalid transfer action"); return { type: "Transfer" as const, deposit: amount(transfer.deposit, "deposit") }; } return { type: "Unknown" as const }; }) : []; const status = result.status; const transactionSucceeded = Boolean(status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status)); const receiptsSucceeded = Array.isArray(result.receipts_outcome) && result.receipts_outcome.every((item) => { const outcome = object(item, "Invalid receipt outcome"); const receiptStatus = outcome.outcome && typeof outcome.outcome === "object" ? object(outcome.outcome, "Invalid receipt outcome data").status : undefined; return Boolean(receiptStatus && typeof receiptStatus === "object" && ("SuccessValue" in receiptStatus || "SuccessReceiptId" in receiptStatus)); }); const success = result.final_execution_status === "FINAL" && transactionSucceeded && receiptsSucceeded; return { hash: string(transaction.hash, "hash"), signerId: string(transaction.signer_id, "signer_id"), receiverId: string(transaction.receiver_id, "receiver_id"), actions, finalExecutionStatus: string(result.final_execution_status, "final_execution_status"), status, success, blockHash: result.transaction_outcome && typeof result.transaction_outcome === "object" ? string((result.transaction_outcome as Record<string, unknown>).block_hash, "block_hash") : undefined }; }
  private normalizeVerification(value: unknown): NearVerification { const raw = object(value, "Invalid verification view"); const result = string(raw.result, "verification.result"); if (result !== "Passed" && result !== "Failed") throw new NearReadError("INVALID_RPC_RESPONSE", "Invalid verification result"); return { projectId: integer(raw.project_id, "verification.project_id"), milestoneId: integer(raw.milestone_id, "verification.milestone_id"), deliverableDigest: string(raw.deliverable_digest, "verification.deliverable_digest"), receiptId: string(raw.receipt_id, "verification.receipt_id"), result, verifier: string(raw.verifier, "verification.verifier") }; }
  private async view(methodName: string, args: Record<string, unknown>): Promise<unknown> { const response = await this.rpc({ method: "query", params: { request_type: "call_function", finality: "final", account_id: this.contractAccountId, method_name: methodName, args_base64: btoa(JSON.stringify(args)) } }); const result = object(response.result, `Missing ${methodName} result`); if (result.error !== undefined) throw new NearReadError("CONTRACT_QUERY_ERROR", `${methodName} query failed`); return base64Json(result.result); }
  private async rpc(input: { method: "status" | "query" | "tx"; params: Record<string, unknown> | unknown[] }): Promise<Record<string, unknown>> { let response: unknown; try { response = await this.config.fetcher(this.rpcUrl, { jsonrpc: "2.0", id: Date.now(), method: input.method, params: input.params }); } catch (error) { if (error instanceof NearReadError) throw error; throw new NearReadError("RPC_ERROR", error instanceof Error ? error.message : "NEAR RPC request failed"); } const body = object(response, "Invalid NEAR RPC response"); if (body.error !== undefined) throw new NearReadError("RPC_ERROR", "NEAR RPC returned an error"); return body; }
}
