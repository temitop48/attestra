import { describe, expect, it, vi } from "vitest";
import { RestrictedVerifierSigner, serverVerifierSignerConfig, type ServerSignerTransport } from "../src/restricted-verifier-signer.js";
import type { VerifierTransactionIntent } from "../src/verifier-submission.js";

const intent: VerifierTransactionIntent = { receiverId: "escrow.testnet", methodName: "submit_verification", args: { project_id: 0, milestone_id: 0, deliverable_digest: "a".repeat(64), receipt_id: "receipt-v4", result: "Passed" }, gas: "30000000000000", deposit: "1", idempotencyKey: "exec:receipt:digest" };

describe("restricted server verifier signer", () => {
  it("forwards only the fixed verifier function-call shape", async () => {
    const functionCall = vi.fn(async () => ({ hash: "dry-run-hash" }));
    const signer = new RestrictedVerifierSigner({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", transport: { functionCall } });
    const result = await signer.submit(intent);
    expect(result).toEqual({ hash: "dry-run-hash" });
    expect(functionCall).toHaveBeenCalledWith({ ...intent, signerAccountId: "verifier.testnet" });
  });

  it.each([
    ["receiver", { receiverId: "other.testnet" }],
    ["method", { methodName: "approve_milestone" }],
    ["result", { args: { ...intent.args, result: "Failed" } }],
    ["digest", { args: { ...intent.args, deliverable_digest: "not-a-digest" } }],
  ])("rejects a client-controlled %s", async (_field, change) => {
    const transport: ServerSignerTransport = { functionCall: vi.fn(async () => ({ hash: "must-not-be-called" })) };
    const signer = new RestrictedVerifierSigner({ accountId: "verifier.testnet", contractAccountId: "escrow.testnet", transport });
    await expect(signer.submit({ ...intent, ...change } as VerifierTransactionIntent)).rejects.toThrow();
    expect(transport.functionCall).not.toHaveBeenCalled();
  });

  it("rejects raw private-key configuration", () => {
    expect(() => serverVerifierSignerConfig({ NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID: "verifier.testnet", NEAR_ESCROW_CONTRACT_ACCOUNT: "escrow.testnet", ATTESTRA_NEAR_SIGNER_SECRET_REF: "kms://verifier", NEAR_VERIFIER_PRIVATE_KEY: "redacted" })).toThrow(/Raw verifier private keys/);
  });

  it("requires a server-side secret reference", () => {
    expect(() => serverVerifierSignerConfig({ NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID: "verifier.testnet", NEAR_ESCROW_CONTRACT_ACCOUNT: "escrow.testnet" })).toThrow(/secret-manager reference/);
  });
});
