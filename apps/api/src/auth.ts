import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

const NEP413_TAG = 2 ** 31 + 413;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type AuthChallenge = { challengeId: string; message: string; recipient: string; nonce: string; expiresAt: number };
export type SignedNearMessage = { accountId: string; publicKey: string; signature: string };

function base58Decode(value: string): Uint8Array {
  const bytes = [0];
  for (const character of value) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw new Error("Invalid base58 value");
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) { const next = (bytes[i] ?? 0) * 58 + carry; bytes[i] = next & 255; carry = next >> 8; }
    while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const character of value) { if (character !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

function borshString(value: string): Buffer { const bytes = Buffer.from(value, "utf8"); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); }
export function nep413Digest(message: string, recipient: string, nonce: Uint8Array): Buffer {
  if (nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const tag = Buffer.alloc(4); tag.writeUInt32LE(NEP413_TAG);
  return createHash("sha256").update(Buffer.concat([tag, borshString(message), Buffer.from(nonce), borshString(recipient), Buffer.from([0])])).digest();
}

export function newAuthChallenge(recipient: string): AuthChallenge {
  const nonce = randomBytes(32);
  return { challengeId: randomBytes(24).toString("base64url"), message: "Sign in to ATTESTRA Testnet", recipient, nonce: nonce.toString("base64url"), expiresAt: Date.now() + 5 * 60_000 };
}

export function verifySignedNearMessage(challenge: AuthChallenge, signed: SignedNearMessage): void {
  if (Date.now() > challenge.expiresAt) throw new Error("Authentication challenge expired");
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(signed.accountId)) throw new Error("Invalid NEAR account ID");
  const [keyType, encodedKey] = signed.publicKey.split(":");
  if (keyType !== "ed25519" || !encodedKey) throw new Error("Only ed25519 wallet keys are supported for authentication");
  const keyBytes = base58Decode(encodedKey);
  const signature = Buffer.from(signed.signature, "base64");
  if (keyBytes.length !== 32 || signature.length !== 64) throw new Error("Invalid NEAR signature encoding");
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes]), format: "der", type: "spki" });
  if (!verify(null, nep413Digest(challenge.message, challenge.recipient, Buffer.from(challenge.nonce, "base64url")), publicKey, signature)) throw new Error("Wallet signature could not be verified");
}

export function parseCookie(header: string | undefined, name: string): string | undefined { return header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1); }
