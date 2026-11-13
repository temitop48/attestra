import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createNearApiVerifierSigner } from "./near-signing-transport.js";
import type { RestrictedVerifierSigner } from "./restricted-verifier-signer.js";
import { KeyPair } from "near-api-js";
import { NearReadonlyAdapter, type NearAccessKey } from "@attestra/near-readonly";

function configured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID || env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE || env.ATTESTRA_NEAR_SIGNER_SECRET_REF);
}

async function localCredentialKey(filePath: string): Promise<string> {
  const absolute = resolve(filePath);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Verifier credential file must not be group- or world-readable");
  const parsed = JSON.parse(await readFile(absolute, "utf8")) as { private_key?: unknown };
  if (typeof parsed.private_key !== "string" || !parsed.private_key.startsWith("ed25519:")) throw new Error("Verifier credential file does not contain an Ed25519 NEAR key");
  return parsed.private_key;
}

export function assertRestrictedVerifierAccessKey(input: { accountId: string; expectedAccountId: string; publicKey: string; contractAccountId: string; expectedContractAccountId: string; accessKey: NearAccessKey }): void {
  if (input.accountId !== input.expectedAccountId) throw new Error("Verifier signer account does not match the authorized verifier account");
  if (input.accessKey.accountId !== input.accountId || input.accessKey.publicKey !== input.publicKey) throw new Error("Verifier signer key is not the finalized key being validated");
  if (input.accessKey.permission !== "FunctionCall") throw new Error("Production verifier signer must use a FunctionCall access key; FullAccess is not accepted");
  if (input.accessKey.receiverId !== input.expectedContractAccountId || input.accessKey.receiverId !== input.contractAccountId) throw new Error("Verifier FunctionCall key receiver does not match the escrow contract");
  if (!input.accessKey.methodNames || input.accessKey.methodNames.length !== 1 || input.accessKey.methodNames[0] !== "submit_verification") throw new Error("Verifier FunctionCall key must allow only submit_verification");
}

/**
 * Loads only server-side signer material. A secret-manager adapter can be
 * supplied by resolving ATTESTRA_NEAR_SIGNER_SECRET_REF in deployment code;
 * this local path exists solely for an operator-controlled Testnet demo.
 */
export async function createVerifierSignerFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<RestrictedVerifierSigner | undefined> {
  if (!configured(env)) return undefined;
  const accountId = env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID;
  const contractAccountId = env.NEAR_ESCROW_CONTRACT_ACCOUNT;
  const rpcUrl = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const credentialFile = env.ATTESTRA_NEAR_SIGNER_CREDENTIAL_FILE;
  if (!accountId || !contractAccountId || !credentialFile) throw new Error("Verifier signer requires account, escrow contract, and a server-only credential file or secret-manager integration");
  if (env.NEAR_VERIFIER_PRIVATE_KEY) throw new Error("Raw verifier private keys are not accepted");
  const privateKey = await localCredentialKey(credentialFile);
  const publicKey = KeyPair.fromString(privateKey as `ed25519:${string}`).getPublicKey().toString();
  const adapter = new NearReadonlyAdapter({ network: env.NEAR_NETWORK ?? "testnet", rpcUrl, contractAccountId });
  const accessKey = await adapter.getAccessKey(accountId, publicKey);
  const restricted = env.NODE_ENV === "production" || env.ATTESTRA_REQUIRE_RESTRICTED_VERIFIER_KEY === "true";
  if (restricted) assertRestrictedVerifierAccessKey({ accountId, expectedAccountId: "verifier.attestra-owner.testnet", publicKey, contractAccountId, expectedContractAccountId: "escrow.attestra-owner.testnet", accessKey });
  return createNearApiVerifierSigner({ accountId, contractAccountId, rpcUrl, resolvePrivateKey: async () => privateKey, requireZeroDeposit: restricted });
}
