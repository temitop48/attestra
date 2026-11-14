import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createNearApiVerifierSigner } from "./near-signing-transport.js";
import type { RestrictedVerifierSigner } from "./restricted-verifier-signer.js";
import { KeyPair } from "near-api-js";
import { NearReadonlyAdapter, type NearAccessKey } from "@attestra/near-readonly";

function configured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID || env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE || env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_JSON || env.ATTESTRA_NEAR_SIGNER_SECRET_REF);
}

type NearCredential = { account_id?: unknown; public_key?: unknown; private_key?: unknown };
type LoadedCredential = { privateKey: string; accountId?: string; publicKey?: string };

function invalidCredential(): Error { return new Error("Verifier credential is invalid"); }

function parseCredential(value: unknown, requireIdentity: boolean): LoadedCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCredential();
  const credential = value as NearCredential;
  if (typeof credential.private_key !== "string" || !credential.private_key.startsWith("ed25519:")) throw invalidCredential();
  const accountId = credential.account_id === undefined ? undefined : typeof credential.account_id === "string" ? credential.account_id : undefined;
  const publicKey = credential.public_key === undefined ? undefined : typeof credential.public_key === "string" ? credential.public_key : undefined;
  if (requireIdentity && (!accountId || !publicKey)) throw invalidCredential();
  return { privateKey: credential.private_key, ...(accountId ? { accountId } : {}), ...(publicKey ? { publicKey } : {}) };
}

export async function loadVerifierCredentialFile(filePath: string): Promise<LoadedCredential> {
  const absolute = resolve(filePath);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Verifier credential file must not be group- or world-readable");
  try { return parseCredential(JSON.parse(await readFile(absolute, "utf8")), false); } catch { throw new Error("Verifier credential file is invalid"); }
}

export function parseVerifierCredentialJson(value: string): LoadedCredential {
  try { return parseCredential(JSON.parse(value), true); } catch { throw invalidCredential(); }
}

export function assertRestrictedVerifierAccessKey(input: { accountId: string; expectedAccountId: string; publicKey: string; contractAccountId: string; expectedContractAccountId: string; accessKey: NearAccessKey }): void {
  if (input.accountId !== input.expectedAccountId) throw new Error("Verifier signer account does not match the authorized verifier account");
  if (input.accessKey.accountId !== input.accountId || input.accessKey.publicKey !== input.publicKey) throw new Error("Verifier signer key is not the finalized key being validated");
  if (input.accessKey.permission !== "FunctionCall") throw new Error("Production verifier signer must use a FunctionCall access key; FullAccess is not accepted");
  if (input.accessKey.receiverId !== input.expectedContractAccountId || input.accessKey.receiverId !== input.contractAccountId) throw new Error("Verifier FunctionCall key receiver does not match the escrow contract");
  if (!input.accessKey.methodNames || input.accessKey.methodNames.length !== 1 || input.accessKey.methodNames[0] !== "submit_verification") throw new Error("Verifier FunctionCall key must allow only submit_verification");
  if (!input.accessKey.allowance || !/^[1-9][0-9]*$/.test(input.accessKey.allowance)) throw new Error("Verifier FunctionCall key must have a finite allowance");
}

/**
 * Loads only server-side signer material. Render Free supplies the complete
 * near-api-js credential JSON through ATTESTRA_NEAR_SIGNER_CREDENTIAL_JSON;
 * local development retains the protected mode-0600 file path.
 */
export async function createVerifierSignerFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<RestrictedVerifierSigner | undefined> {
  if (!configured(env)) return undefined;
  const accountId = env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID;
  const contractAccountId = env.NEAR_ESCROW_CONTRACT_ACCOUNT;
  const rpcUrl = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const credentialFile = env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE;
  if (!accountId || !contractAccountId) throw new Error("Verifier signer requires account and escrow contract");
  if (env.NEAR_VERIFIER_PRIVATE_KEY) throw new Error("Raw verifier private keys are not accepted");
  const credential = env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_JSON ? parseVerifierCredentialJson(env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_JSON) : credentialFile ? await loadVerifierCredentialFile(credentialFile) : undefined;
  if (!credential) throw new Error("Verifier signer credential is missing");
  if (credential.accountId && credential.accountId !== accountId) throw new Error("Verifier credential account does not match the authorized verifier account");
  const privateKey = credential.privateKey;
  const publicKey = KeyPair.fromString(privateKey as `ed25519:${string}`).getPublicKey().toString();
  if (credential.publicKey && credential.publicKey !== publicKey) throw new Error("Verifier credential public key does not match its private key");
  const adapter = new NearReadonlyAdapter({ network: env.NEAR_NETWORK ?? "testnet", rpcUrl, contractAccountId });
  const accessKey = await adapter.getAccessKey(accountId, publicKey);
  assertRestrictedVerifierAccessKey({ accountId, expectedAccountId: "verifier.attestra-owner.testnet", publicKey, contractAccountId, expectedContractAccountId: "escrow.attestra-owner.testnet", accessKey });
  return createNearApiVerifierSigner({ accountId, contractAccountId, rpcUrl, resolvePrivateKey: async () => privateKey, requireZeroDeposit: true });
}
