import { connect, keyStores, KeyPair } from "near-api-js";
import { RestrictedVerifierSigner, type RestrictedFunctionCall, type ServerSignerTransport } from "./restricted-verifier-signer.js";

export type NearApiAccountLike = {
  functionCall(options: { contractId: string; methodName: "submit_verification"; args: RestrictedFunctionCall["args"]; gas: bigint; attachedDeposit: bigint }): Promise<{ transaction_outcome?: { id?: string } }>;
};

export type NearApiConnectionLike = { account(accountId: string): Promise<NearApiAccountLike> };
export type NearApiConnect = (config: { networkId: "testnet"; nodeUrl: string; deps: { keyStore: InstanceType<typeof keyStores.InMemoryKeyStore> } }) => Promise<NearApiConnectionLike>;

export type NearSigningTransportOptions = {
  accountId: string;
  contractAccountId: string;
  rpcUrl: string;
  resolvePrivateKey: () => Promise<string>;
  requireZeroDeposit?: boolean;
  connectNear?: NearApiConnect;
  retry?: { maxAttempts?: number; backoffMs?: number; maxDelayMs?: number; canRetryBeforeBroadcast?: (error: unknown) => boolean };
};

export class NearSigningTransportError extends Error {
  constructor(message: string, public readonly submissionOutcome: "failed" | "unknown" = "unknown") { super(message); this.name = "NearSigningTransportError"; }
}

function validateCall(request: RestrictedFunctionCall, contractAccountId: string): void {
  if (request.receiverId !== contractAccountId) throw new NearSigningTransportError("Signer receiver does not match the configured escrow contract");
  if (request.methodName !== "submit_verification") throw new NearSigningTransportError("Signer only permits submit_verification");
  if (request.args.result !== "Passed") throw new NearSigningTransportError("Signer only permits passing verification receipts");
  if (!Number.isSafeInteger(request.args.project_id) || request.args.project_id < 0 || !Number.isSafeInteger(request.args.milestone_id) || request.args.milestone_id < 0) throw new NearSigningTransportError("Signer received invalid project or milestone ID");
  if (!/^[a-f0-9]{64}$/.test(request.args.deliverable_digest) || !request.args.receipt_id || !request.idempotencyKey) throw new NearSigningTransportError("Signer received invalid receipt arguments");
  if (!/^[1-9][0-9]*$/.test(request.gas) || !/^[0-9]+$/.test(request.deposit)) throw new NearSigningTransportError("Signer received invalid gas or deposit");
}

/**
 * Creates a server-only NEAR transport. The private key is resolved by the
 * caller from a secret manager and is never accepted from a request or logged.
 * near-api-js handles access-key nonce selection and final transaction outcome;
 * retries are disabled unless the caller can prove the failure occurred before
 * broadcast, preventing duplicate calls after an unknown network outcome.
 */
export async function createNearApiVerifierTransport(options: NearSigningTransportOptions): Promise<ServerSignerTransport> {
  if (!options.accountId || !options.contractAccountId || !options.rpcUrl) throw new NearSigningTransportError("NEAR signer configuration is incomplete");
  const privateKey = await options.resolvePrivateKey();
  if (!privateKey || !privateKey.startsWith("ed25519:")) throw new NearSigningTransportError("The verifier secret did not provide an Ed25519 NEAR key");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", options.accountId, KeyPair.fromString(privateKey as `ed25519:${string}`));
  const connectNear = options.connectNear ?? (connect as unknown as NearApiConnect);
  const connection = await connectNear({ networkId: "testnet", nodeUrl: options.rpcUrl, deps: { keyStore } });
  const account = await connection.account(options.accountId);
  const maxAttempts = Math.max(1, Math.min(3, options.retry?.maxAttempts ?? 1));
  const backoffMs = Math.max(0, Math.min(5_000, options.retry?.backoffMs ?? 100));
  const maxDelayMs = Math.max(backoffMs, Math.min(10_000, options.retry?.maxDelayMs ?? 1_000));
  return {
    async functionCall(request) {
      validateCall(request, options.contractAccountId);
      if (options.requireZeroDeposit && request.deposit !== "0") throw new NearSigningTransportError("Restricted verifier keys may submit only zero-deposit verification calls");
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const outcome = await account.functionCall({ contractId: request.receiverId, methodName: request.methodName, args: request.args, gas: BigInt(request.gas), attachedDeposit: BigInt(request.deposit) });
          const hash = outcome.transaction_outcome?.id;
          if (!hash) throw new NearSigningTransportError("NEAR returned no transaction hash", "unknown");
          return { hash };
        } catch (error) {
          const canRetry = attempt < maxAttempts && options.retry?.canRetryBeforeBroadcast?.(error) === true;
          if (!canRetry) throw error instanceof NearSigningTransportError ? error : new NearSigningTransportError("NEAR signing or submission failed");
          const delay = Math.min(maxDelayMs, backoffMs * (2 ** (attempt - 1)));
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw new NearSigningTransportError("NEAR submission attempts exhausted");
    },
  };
}

export async function createNearApiVerifierSigner(options: NearSigningTransportOptions): Promise<RestrictedVerifierSigner> {
  const transport = await createNearApiVerifierTransport(options);
  return new RestrictedVerifierSigner({ accountId: options.accountId, contractAccountId: options.contractAccountId, transport, restrictedKey: options.requireZeroDeposit === true });
}
