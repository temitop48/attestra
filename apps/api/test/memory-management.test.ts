import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NearReadonlyAdapter } from "@attestra/near-readonly";
import { buildApp } from "../src/app.js";
import { nep413Digest } from "../src/auth.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(value: Uint8Array): string { const digits = [0]; for (const byte of value) { let carry = byte; for (let i = 0; i < digits.length; i += 1) { const next = (digits[i] ?? 0) * 256 + carry; digits[i] = next % 58; carry = Math.floor(next / 58); } while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); } } let result = ""; for (const byte of value) { if (byte !== 0) break; result += "1"; } for (let i = digits.length - 1; i >= 0; i -= 1) result += alphabet[digits[i] ?? 0]; return result; }

async function authenticate(app: ReturnType<typeof buildApp>, accountId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicBytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const publicKeyString = `ed25519:${base58(publicBytes)}`;
  const challenge = await app.inject({ method: "GET", url: "/api/v1/auth/challenge", remoteAddress: accountId === "owner.testnet" ? "192.0.2.10" : "192.0.2.11" });
  const body = challenge.json();
  const signature = sign(null, nep413Digest(body.message, body.recipient, Buffer.from(body.nonce, "base64url")), privateKey).toString("base64");
  return app.inject({ method: "POST", url: "/api/v1/auth/near", remoteAddress: accountId === "owner.testnet" ? "192.0.2.10" : "192.0.2.11", payload: { challengeId: body.challengeId, signedMessage: { accountId, publicKey: publicKeyString, signature } } });
}

describe("bounded API memory state", () => {
  it("cleans stale rate-limit entries and rejects new keys at capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const app = buildApp({ memoryLimits: { maxRateBuckets: 1, cleanupIntervalMs: 10 } });
    try {
      expect((await app.inject({ method: "GET", url: "/health", remoteAddress: "192.0.2.20" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/health", remoteAddress: "192.0.2.21" })).statusCode).toBe(429);
      vi.advanceTimersByTime(60_001);
      expect((await app.inject({ method: "GET", url: "/health", remoteAddress: "192.0.2.21" })).statusCode).toBe(200);
    } finally { await app.close(); vi.useRealTimers(); }
  });

  it("preserves unexpired challenges at capacity and removes expired challenges before admission", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async () => ({ result: { permission: "FullAccess" } }) });
    const app = buildApp({ nearAdapter: adapter, memoryLimits: { maxAuthChallenges: 1, cleanupIntervalMs: 10 } });
    try {
      const first = await app.inject({ method: "GET", url: "/api/v1/auth/challenge", remoteAddress: "192.0.2.30" });
      const firstBody = first.json();
      expect(first.statusCode).toBe(200);
      const rejected = await app.inject({ method: "GET", url: "/api/v1/auth/challenge", remoteAddress: "192.0.2.31" });
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json()).toEqual({ error: { code: "AUTHENTICATION_CAPACITY_EXCEEDED", message: "Authentication challenge capacity is temporarily full; retry later" } });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicBytes = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
      const signedMessage = { accountId: "owner.testnet", publicKey: `ed25519:${base58(publicBytes)}`, signature: sign(null, nep413Digest(firstBody.message, firstBody.recipient, Buffer.from(firstBody.nonce, "base64url")), privateKey).toString("base64") };
      const authenticated = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: firstBody.challengeId, signedMessage }, remoteAddress: "192.0.2.30" });
      expect(authenticated.statusCode).toBe(200);
      const replay = await app.inject({ method: "POST", url: "/api/v1/auth/near", payload: { challengeId: firstBody.challengeId, signedMessage }, remoteAddress: "192.0.2.30" });
      expect(replay.statusCode).toBe(401);
      const second = await app.inject({ method: "GET", url: "/api/v1/auth/challenge", remoteAddress: "192.0.2.31" });
      expect(second.statusCode).toBe(200);
      vi.advanceTimersByTime(300_001);
      const afterExpiry = await app.inject({ method: "GET", url: "/api/v1/auth/challenge", remoteAddress: "192.0.2.31" });
      expect(afterExpiry.statusCode).toBe(200);
    } finally { await app.close(); vi.useRealTimers(); }
  });

  it("preserves active sessions while rejecting new sessions at capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const adapter = new NearReadonlyAdapter({ contractAccountId: "escrow.testnet", fetcher: async () => ({ result: { permission: "FullAccess" } }) });
    const app = buildApp({ nearAdapter: adapter, memoryLimits: { maxSessions: 1, cleanupIntervalMs: 10 } });
    try {
      const first = await authenticate(app, "owner.testnet");
      expect(first.statusCode).toBe(200);
      const cookie = first.headers["set-cookie"];
      vi.advanceTimersByTime(60_001);
      const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie }, remoteAddress: "192.0.2.10" });
      expect(me.statusCode).toBe(200);
      const second = await authenticate(app, "other.testnet");
      expect(second.statusCode).toBe(503);
      expect(second.json().error.code).toBe("AUTHENTICATION_CAPACITY_EXCEEDED");
    } finally { await app.close(); vi.useRealTimers(); }
  });
});
