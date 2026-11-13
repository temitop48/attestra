import type { BackendVerifierSigner, VerifierTransactionIntent } from "./verifier-submission.js";

export type RestrictedFunctionCall = {
  signerAccountId: string;
  receiverId: string;
  methodName: "submit_verification";
  args: VerifierTransactionIntent["args"];
  gas: string;
  deposit: string;
  idempotencyKey: string;
};

export type ServerSignerTransport = {
  functionCall(request: RestrictedFunctionCall): Promise<{ hash: string }>;
};

export type RestrictedVerifierSignerOptions = {
  accountId: string;
  contractAccountId: string;
  transport: ServerSignerTransport;
  restrictedKey?: boolean;
};

/**
 * Narrow adapter for a KMS/NEAR signer. It intentionally has no private-key
 * parsing and no arbitrary contract-call surface. The transport is expected to
 * enforce the configured access-key permission and keep credentials outside
 * the API process where possible.
 */
export class RestrictedVerifierSigner implements BackendVerifierSigner {
  readonly accountId: string;
  readonly restrictedKey: boolean;

  constructor(private readonly options: RestrictedVerifierSignerOptions) {
    if (!options.accountId || !options.contractAccountId || !options.transport) throw new Error("Restricted verifier signer configuration is incomplete");
    this.accountId = options.accountId;
    this.restrictedKey = options.restrictedKey === true;
  }

  async submit(intent: VerifierTransactionIntent): Promise<{ hash: string }> {
    if (intent.receiverId !== this.options.contractAccountId) throw new Error("Verifier signer receiver is not the configured escrow contract");
    if (intent.methodName !== "submit_verification") throw new Error("Verifier signer only permits submit_verification");
    if (intent.args.result !== "Passed") throw new Error("Verifier signer only permits passing receipts");
    if (!Number.isSafeInteger(intent.args.project_id) || intent.args.project_id < 0 || !Number.isSafeInteger(intent.args.milestone_id) || intent.args.milestone_id < 0) throw new Error("Verifier signer received invalid chain identifiers");
    if (!/^[a-f0-9]{64}$/.test(intent.args.deliverable_digest) || !intent.args.receipt_id || !intent.idempotencyKey) throw new Error("Verifier signer received invalid receipt arguments");
    return this.options.transport.functionCall({ signerAccountId: this.accountId, receiverId: this.options.contractAccountId, methodName: "submit_verification", args: intent.args, gas: intent.gas, deposit: intent.deposit, idempotencyKey: intent.idempotencyKey });
  }
}

export function serverVerifierSignerConfig(env: NodeJS.ProcessEnv = process.env): { accountId: string; contractAccountId: string; secretReference: string } {
  if (env.NEAR_VERIFIER_PRIVATE_KEY) throw new Error("Raw verifier private keys are not accepted by the API configuration");
  const accountId = env.NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID;
  const contractAccountId = env.NEAR_ESCROW_CONTRACT_ACCOUNT;
  const secretReference = env.ATTESTRA_NEAR_SIGNER_SECRET_REF;
  if (!accountId || !contractAccountId || !secretReference) throw new Error("Server verifier signer requires account, contract, and a secret-manager reference");
  return { accountId, contractAccountId, secretReference };
}
