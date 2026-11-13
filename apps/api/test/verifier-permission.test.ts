import { describe, expect, it } from "vitest";
import { assertRestrictedVerifierAccessKey } from "../src/verifier-bootstrap.js";

const base = {
  accountId: "verifier.attestra-owner.testnet",
  expectedAccountId: "verifier.attestra-owner.testnet",
  publicKey: "ed25519:test",
  contractAccountId: "escrow.attestra-owner.testnet",
  expectedContractAccountId: "escrow.attestra-owner.testnet",
};

describe("restricted verifier access-key validation", () => {
  it("accepts only the exact submit_verification FunctionCall permission", () => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accessKey: { accountId: base.accountId, publicKey: base.publicKey, permission: "FunctionCall", receiverId: base.contractAccountId, methodNames: ["submit_verification"] } })).not.toThrow();
  });

  it.each([
    ["FullAccess", { permission: "FullAccess" as const }],
    ["wrong receiver", { permission: "FunctionCall" as const, receiverId: "other.testnet", methodNames: ["submit_verification"] }],
    ["extra method", { permission: "FunctionCall" as const, receiverId: base.contractAccountId, methodNames: ["submit_verification", "approve_milestone"] }],
    ["missing method list", { permission: "FunctionCall" as const, receiverId: base.contractAccountId }],
  ])("rejects %s", (_label, permission) => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accessKey: { accountId: base.accountId, publicKey: base.publicKey, ...permission } })).toThrow();
  });

  it("rejects an account identity mismatch", () => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accountId: "owner.testnet", accessKey: { accountId: "owner.testnet", publicKey: base.publicKey, permission: "FunctionCall", receiverId: base.contractAccountId, methodNames: ["submit_verification"] } })).toThrow();
  });
});
