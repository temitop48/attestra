import { describe, expect, it } from "vitest";
import { NearReadError, NearReadonlyAdapter, type NearRpcRequest } from "../src/index.js";

const contract = "escrow.testnet";
function encoded(value: unknown): number[] { return [...new TextEncoder().encode(JSON.stringify(value))]; }
function rpc(responses: Record<string, unknown>) {
  const requests: NearRpcRequest[] = [];
  const fetcher = async (_url: string, request: NearRpcRequest) => { requests.push(request); const key = request.method === "status" ? "status" : String(request.params.method_name ?? request.params.request_type); return responses[key] ?? { jsonrpc: "2.0", id: request.id, result: { result: encoded(null) } }; };
  return { fetcher, requests };
}
const account = { jsonrpc: "2.0", id: 1, result: { amount: "900719925474099300000000", locked: "0", code_hash: "abc", storage_usage: 42 } };
const status = { jsonrpc: "2.0", id: 1, result: { chain_id: "testnet", sync_info: { latest_block_height: 10 } } };
const project = { project_id: 7, owner: "owner.testnet", total_funded: "900719925474099300000000", available_balance: "0", reserved_balance: "900719925474099300000000", paid_balance: "0", refunded_balance: "0", pending_refund_balance: "0", next_milestone_id: 1, pending_payment: null, pending_refund: null, storage_deposit: "10" };
const milestone = { project_id: 7, milestone_id: 0, recipient: "recipient.testnet", budget: "900719925474099300000000", dependencies: [], status: "InProgress", verification: null, approval_receipt_id: null };

describe("NearReadonlyAdapter", () => {
  it("queries final project and milestone state without a transaction method", async () => {
    const mocked = rpc({ status, view_account: account, get_project: { jsonrpc: "2.0", id: 1, result: { result: encoded(project) } }, get_milestone: { jsonrpc: "2.0", id: 1, result: { result: encoded(milestone) } } });
    const adapter = new NearReadonlyAdapter({ contractAccountId: contract, fetcher: mocked.fetcher });
    expect(await adapter.getProject(7)).toMatchObject({ projectId: 7, totalFunded: "900719925474099300000000" });
    expect(await adapter.getMilestone(7, 0)).toMatchObject({ milestoneId: 0, budget: "900719925474099300000000" });
    expect(mocked.requests.every((request) => request.method === "query")).toBe(true);
    expect(mocked.requests.every((request) => request.params.finality === "final")).toBe(true);
  });
  it("normalizes status and account state", async () => {
    const mocked = rpc({ status, view_account: account }); const adapter = new NearReadonlyAdapter({ contractAccountId: contract, fetcher: mocked.fetcher });
    expect(await adapter.status()).toMatchObject({ network: "testnet", chainId: "testnet", latestBlockHeight: 10 });
    expect(await adapter.accountState()).toMatchObject({ accountId: contract, amount: "900719925474099300000000" });
  });
  it("rejects unsupported networks and malformed contract responses", async () => {
    expect(() => new NearReadonlyAdapter({ contractAccountId: contract, network: "mainnet" })).toThrowError(NearReadError);
    const mocked = rpc({ get_project: { jsonrpc: "2.0", id: 1, result: { result: encoded({ project_id: 1, total_funded: "not-an-integer" }) } } });
    await expect(new NearReadonlyAdapter({ contractAccountId: contract, fetcher: mocked.fetcher }).getProject(1)).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
  });
  it("fails closed for RPC errors", async () => {
    const adapter = new NearReadonlyAdapter({ contractAccountId: contract, fetcher: async () => { throw new Error("offline"); } });
    await expect(adapter.getProject(1)).rejects.toMatchObject({ code: "RPC_ERROR" });
  });
  it("normalizes the NEAR view_access_key FunctionCall permission wrapper", async () => {
    const mocked = rpc({ view_access_key: { jsonrpc: "2.0", id: 1, result: { permission: { FunctionCall: { receiver_id: "escrow.testnet", method_names: ["submit_verification"], allowance: "100" } } } } });
    const adapter = new NearReadonlyAdapter({ contractAccountId: contract, fetcher: mocked.fetcher });
    await expect(adapter.getAccessKey("verifier.testnet", "ed25519:test")).resolves.toMatchObject({ permission: "FunctionCall", receiverId: "escrow.testnet", methodNames: ["submit_verification"] });
  });
});
