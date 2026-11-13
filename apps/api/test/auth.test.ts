import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NearReadonlyAdapter } from "@attestra/near-readonly";
import { buildApp, createNearAdapterFromEnvironment } from "../src/app.js";
import { nep413Digest } from "../src/auth.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(value: Uint8Array): string { const digits = [0]; for (const byte of value) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = (digits[i] ?? 0) * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } } let result = ""; for (const byte of value) { if (byte !== 0) break; result += "1"; } for (let i = digits.length - 1; i >= 0; i -= 1) result += alphabet[digits[i] ?? 0]; return result; }

describe("NEP-413 wallet authentication", () => {
  it("initializes the read-only adapter from the API environment and stays Testnet-only", () => {
    const previous = { network: process.env.NEAR_NETWORK, rpc: process.env.NEAR_RPC_URL, contract: process.env.NEAR_ESCROW_CONTRACT_ACCOUNT };
    process.env.NEAR_NETWORK = "testnet"; process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org"; process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = "escrow.testnet";
    try { const adapter = createNearAdapterFromEnvironment(); expect(adapter?.network).toBe("testnet"); expect(adapter?.contractAccountId).toBe("escrow.testnet"); } finally { if (previous.network === undefined) delete process.env.NEAR_NETWORK; else process.env.NEAR_NETWORK = previous.network; if (previous.rpc === undefined) delete process.env.NEAR_RPC_URL; else process.env.NEAR_RPC_URL = previous.rpc; if (previous.contract === undefined) delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; else process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = previous.contract; }
  });

  it("returns no adapter when the contract account is missing rather than creating a mock", () => {
    const previous = process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT;
    try { expect(createNearAdapterFromEnvironment()).toBeUndefined(); } finally { if (previous === undefined) delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; else process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = previous; }
  });

  it("serves a valid challenge independently of adapter-backed authentication", async () => {
    const app = buildApp({ demoMode: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/challenge" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "Sign in to ATTESTRA Testnet", recipient: expect.any(String), nonce: expect.any(String) });
    await app.close();
  });

  it("returns a clear configuration error instead of bypassing adapter verification", async () => {
    const previous = { network: process.env.NEAR_NETWORK, rpc: process.env.NEAR_RPC_URL, contract: process.env.NEAR_ESCROW_CONTRACT_ACCOUNT };
    delete process.env.NEAR_NETWORK; delete process.env.NEAR_RPC_URL; delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicBytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const publicKeyString = `ed25519:${base58(publicBytes)}`;
    const app = buildApp({ demoMode: true });
    try {
      const challenge = await app.inject({ method: "GET", url: "/api/v1/auth/challenge" }); const body = challenge.json();
      const signature = sign(null, nep413Digest(body.message, body.recipient, Buffer.from(body.nonce, "base64url")), privateKey).toString("base64");
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: body.challengeId, signedMessage: { accountId: "owner.testnet", publicKey: publicKeyString, signature } } });
      expect(response.statusCode).toBe(503); expect(response.json().error.message).toContain("NEAR Testnet adapter is unavailable");
    } finally { await app.close(); if (previous.network === undefined) delete process.env.NEAR_NETWORK; else process.env.NEAR_NETWORK = previous.network; if (previous.rpc === undefined) delete process.env.NEAR_RPC_URL; else process.env.NEAR_RPC_URL = previous.rpc; if (previous.contract === undefined) delete process.env.NEAR_ESCROW_CONTRACT_ACCOUNT; else process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = previous.contract; }
  });

  it("verifies a challenge, checks the FullAccess key, and creates a session", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicBytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const publicKeyString = `ed25519:${base58(publicBytes)}`;
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async (_url, request) => request.method === "query" && (request.params as Record<string, unknown>).request_type === "view_access_key" ? { result: { permission: "FullAccess" } } : { result: { chain_id: "testnet" } } });
    const app = buildApp({ nearAdapter: adapter, demoMode: true });
    const challenge = await app.inject({ method: "GET", url: "/api/v1/auth/challenge" }); const body = challenge.json();
    const signature = sign(null, nep413Digest(body.message, body.recipient, Buffer.from(body.nonce, "base64url")), privateKey).toString("base64");
    const authenticated = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: body.challengeId, signedMessage: { accountId: "owner.testnet", publicKey: publicKeyString, signature } } });
    expect(authenticated.statusCode).toBe(200); expect(authenticated.json()).toMatchObject({ accountId: "owner.testnet", network: "testnet" });
    const cookie = authenticated.headers["set-cookie"];
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie } });
    expect(me.statusCode).toBe(200); expect(me.json()).toMatchObject({ authenticated: true, accountId: "owner.testnet" }); await app.close();
  });

  it("rejects a replayed challenge and an invalid signature", async () => {
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async () => ({ result: { permission: "FullAccess" } }) }); const app = buildApp({ nearAdapter: adapter });
    const challenge = await app.inject({ method: "GET", url: "/api/v1/auth/challenge" }); const body = challenge.json();
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: body.challengeId, signedMessage: { accountId: "owner.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: Buffer.alloc(64).toString("base64") } } });
    expect(bad.statusCode).toBe(401); const replay = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: body.challengeId, signedMessage: { accountId: "owner.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: Buffer.alloc(64).toString("base64") } } }); expect(replay.statusCode).toBe(401); await app.close();
  });
});
