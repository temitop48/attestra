import { describe, expect, it } from "vitest";
import { assertRestrictedVerifierAccessKey } from "../src/verifier-bootstrap.js";

const base = {
  accountId: "verifier.attestra-owner.testnet",
  expectedAccountId: "verifier.attestra-owner.testnet",
  publicKey: "ed25519:test",
  contractAccountId: "escrow.attestra-owner.testnet",
  expectedContractAccountId: "escrow.attestra-owner.testnet",
};

const restrictedAccessKey = { accountId: base.accountId, publicKey: base.publicKey, permission: "FunctionCall" as const, receiverId: base.contractAccountId, methodNames: ["submit_verification"], allowance: "100000000000000000000" };

describe("restricted verifier access-key validation", () => {
  it("accepts only the exact submit_verification FunctionCall permission", () => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accessKey: restrictedAccessKey })).not.toThrow();
  });

  it.each([
    ["FullAccess", { permission: "FullAccess" as const }],
    ["wrong receiver", { permission: "FunctionCall" as const, receiverId: "other.testnet", methodNames: ["submit_verification"] }],
    ["extra method", { permission: "FunctionCall" as const, receiverId: base.contractAccountId, methodNames: ["submit_verification", "approve_milestone"] }],
    ["missing method list", { permission: "FunctionCall" as const, receiverId: base.contractAccountId }],
    ["unlimited allowance", { permission: "FunctionCall" as const, receiverId: base.contractAccountId, methodNames: ["submit_verification"], allowance: undefined }],
  ])("rejects %s", (_label, permission) => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accessKey: { accountId: base.accountId, publicKey: base.publicKey, ...permission } })).toThrow();
  });

  it("rejects an account identity mismatch", () => {
    expect(() => assertRestrictedVerifierAccessKey({ ...base, accountId: "owner.testnet", accessKey: { ...restrictedAccessKey, accountId: "owner.testnet" } })).toThrow();
  });
});
