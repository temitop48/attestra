import { describe, expect, it, vi } from "vitest";
import { KeyPair } from "near-api-js";
import { createNearApiVerifierTransport } from "../src/near-signing-transport.js";
import type { RestrictedFunctionCall } from "../src/restricted-verifier-signer.js";

const validCall: RestrictedFunctionCall = { signerAccountId: "verifier.testnet", receiverId: "escrow.testnet", methodName: "submit_verification", args: { project_id: 0, milestone_id: 0, deliverable_digest: "a".repeat(64), receipt_id: "receipt-v4", result: "Passed" }, gas: "30000000000000", deposit: "1", idempotencyKey: "execution:receipt:digest" };
const testPrivateKey = KeyPair.fromRandom("ed25519").toString();

function connector(account: { functionCall: ReturnType<typeof vi.fn> }) {
  return vi.fn(async () => ({ account: vi.fn(async () => account) }));
}

describe("near-api-js verifier transport", () => {
  it("fails closed for an invalid server credential", async () => {
    await expect(createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => "not-a-near-key" })).rejects.toThrow(/Ed25519 NEAR key/);
  });

  it("uses the server-resolved key and constructs only submit_verification", async () => {
    const functionCall = vi.fn(async () => ({ transaction_outcome: { id: "tx-dry-run" } }));
    const connectNear = connector({ functionCall });
    const transport = await createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => testPrivateKey, connectNear: connectNear as never });
    await expect(transport.functionCall(validCall)).resolves.toEqual({ hash: "tx-dry-run" });
    expect(functionCall).toHaveBeenCalledWith({ contractId: "escrow.testnet", methodName: "submit_verification", args: validCall.args, gas: 30000000000000n, attachedDeposit: 1n });
  });

  it("rejects arbitrary receiver or method before the account transport", async () => {
    const functionCall = vi.fn();
    const connectNear = connector({ functionCall });
    const transport = await createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => testPrivateKey, connectNear: connectNear as never });
    await expect(transport.functionCall({ ...validCall, receiverId: "other.testnet" })).rejects.toThrow();
    expect(functionCall).not.toHaveBeenCalled();
  });

  it("enforces zero deposit for restricted-key mode", async () => {
    const functionCall = vi.fn(async () => ({ transaction_outcome: { id: "tx-zero" } }));
    const connectNear = connector({ functionCall });
    const transport = await createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => testPrivateKey, requireZeroDeposit: true, connectNear: connectNear as never });
    await expect(transport.functionCall({ ...validCall, deposit: "1" })).rejects.toThrow(/zero-deposit/);
    await expect(transport.functionCall({ ...validCall, deposit: "0" })).resolves.toEqual({ hash: "tx-zero" });
  });

  it("retries only an explicitly pre-broadcast failure and preserves the call", async () => {
    const functionCall = vi.fn().mockRejectedValueOnce(new Error("before broadcast")).mockResolvedValueOnce({ transaction_outcome: { id: "tx-after-retry" } });
    const connectNear = connector({ functionCall });
    const transport = await createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => testPrivateKey, connectNear: connectNear as never, retry: { maxAttempts: 2, backoffMs: 0, canRetryBeforeBroadcast: () => true } });
    await expect(transport.functionCall(validCall)).resolves.toEqual({ hash: "tx-after-retry" });
    expect(functionCall).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unknown submission failure", async () => {
    const functionCall = vi.fn().mockRejectedValue(new Error("timeout after broadcast"));
    const connectNear = connector({ functionCall });
    const transport = await createNearApiVerifierTransport({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", rpcUrl: "https://rpc.testnet.near.org", resolvePrivateKey: async () => testPrivateKey, connectNear: connectNear as never, retry: { maxAttempts: 3, backoffMs: 0, canRetryBeforeBroadcast: () => false } });
    await expect(transport.functionCall(validCall)).rejects.toThrow();
    expect(functionCall).toHaveBeenCalledTimes(1);
  });
});
