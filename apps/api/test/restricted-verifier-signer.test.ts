import { describe, expect, it, vi } from "vitest";
import { RestrictedVerifierSigner, serverVerifierSignerConfig, type ServerSignerTransport } from "../src/restricted-verifier-signer.js";
import { KeyPair } from "near-api-js";
import { loadVerifierCredentialFile, parseVerifierCredentialJson } from "../src/verifier-bootstrap.js";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifierTransactionIntent } from "../src/verifier-submission.js";

const intent: VerifierTransactionIntent = { receiverId: "escrow.testnet", methodName: "submit_verification", args: { project_id: 0, milestone_id: 0, deliverable_digest: "a".repeat(64), receipt_id: "receipt-v4", result: "Passed" }, gas: "30000000000000", deposit: "1", idempotencyKey: "exec:receipt:digest" };

describe("restricted server verifier signer", () => {
  it("accepts a valid restricted credential JSON without exposing its secret", () => {
    const privateKey = KeyPair.fromRandom("ed25519").toString();
    const publicKey = KeyPair.fromString(privateKey as `ed25519:${string}`).getPublicKey().toString();
    const parsed = parseVerifierCredentialJson(JSON.stringify({ account_id: "verifier.attestra-owner.testnet", public_key: publicKey, private_key: privateKey }));
    expect(parsed).toEqual({ accountId: "verifier.attestra-owner.testnet", publicKey, privateKey });
    expect(() => parseVerifierCredentialJson("not-json")).toThrow(/invalid/i);
    try { parseVerifierCredentialJson("not-json"); } catch (error) { expect(String(error)).not.toContain(privateKey); }
  });

  it("keeps compatibility with a protected local credential file", async () => {
    const privateKey = KeyPair.fromRandom("ed25519").toString();
    const directory = await mkdtemp(join(tmpdir(), "attestra-verifier-"));
    const file = join(directory, "credential.json");
    await writeFile(file, JSON.stringify({ private_key: privateKey }), { mode: 0o600 });
    await chmod(file, 0o600);
    await expect(loadVerifierCredentialFile(file)).resolves.toMatchObject({ privateKey });
  });

  it("rejects invalid credentials without printing credential material", () => {
    const value = "{}";
    expect(() => parseVerifierCredentialJson(value)).toThrow();
    expect(() => parseVerifierCredentialJson(value)).toThrow(/invalid/i);
    try { parseVerifierCredentialJson(value); } catch (error) { expect(String(error)).not.toContain(value); }
  });

  it("rejects a missing credential source", async () => {
    await expect(import("../src/verifier-bootstrap.js").then(({ createVerifierSignerFromEnvironment }) => createVerifierSignerFromEnvironment({ NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID: "verifier.attestra-owner.testnet", NEAR_ESCROW_CONTRACT_ACCOUNT: "escrow.attestra-owner.testnet" }))).rejects.toThrow(/missing/i);
  });

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
