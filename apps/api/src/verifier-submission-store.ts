import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { VerifierSubmission, VerifierSubmissionState } from "./verifier-submission.js";

export type PersistedVerifierSubmission = VerifierSubmission & { idempotencyKey: string };
export interface VerifierSubmissionStoreLike {
  get(idempotencyKey: string): PersistedVerifierSubmission | undefined;
  reserve(idempotencyKey: string, initial: Omit<PersistedVerifierSubmission, "idempotencyKey">): Promise<{ created: boolean; submission: PersistedVerifierSubmission }>;
  update(idempotencyKey: string, patch: Partial<Pick<PersistedVerifierSubmission, "state" | "transactionHash" | "error">>): Promise<PersistedVerifierSubmission>;
  markUnknown(idempotencyKey: string, error: string): Promise<PersistedVerifierSubmission>;
}
type StoreFile = { version: 1; submissions: PersistedVerifierSubmission[] };

/**
 * Durable single-writer ledger for verifier submissions. A pending record is
 * reserved before signing; if the process stops before the hash is persisted,
 * the record remains pending without a hash and must be reconciled manually.
 * That is intentionally safer than issuing a second call after an ambiguous
 * outcome. Public multi-instance deployments should replace this adapter with
 * a transactional shared database implementation.
 */
export class VerifierSubmissionStore implements VerifierSubmissionStoreLike {
  private readonly records = new Map<string, PersistedVerifierSubmission>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  private constructor(filePath: string) { this.filePath = resolve(filePath); }

  static openSync(filePath: string): VerifierSubmissionStore {
    const store = new VerifierSubmissionStore(filePath);
    if (existsSync(store.filePath)) {
      const parsed = JSON.parse(readFileSync(store.filePath, "utf8")) as StoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.submissions)) throw new Error("Unsupported verifier submission store format");
      for (const submission of parsed.submissions) store.records.set(submission.idempotencyKey, submission);
    }
    return store;
  }

  get(idempotencyKey: string): PersistedVerifierSubmission | undefined { return this.records.get(idempotencyKey); }

  async reserve(idempotencyKey: string, initial: Omit<PersistedVerifierSubmission, "idempotencyKey">): Promise<{ created: boolean; submission: PersistedVerifierSubmission }> {
    const existing = this.records.get(idempotencyKey);
    if (existing) return { created: false, submission: existing };
    const submission = { ...initial, idempotencyKey };
    this.records.set(idempotencyKey, submission);
    await this.persist();
    return { created: true, submission };
  }

  async update(idempotencyKey: string, patch: Partial<Pick<PersistedVerifierSubmission, "state" | "transactionHash" | "error">>): Promise<PersistedVerifierSubmission> {
    const current = this.records.get(idempotencyKey);
    if (!current) throw new Error("Verifier submission reservation not found");
    const next = { ...current, ...patch };
    this.records.set(idempotencyKey, next);
    await this.persist();
    return next;
  }

  async markUnknown(idempotencyKey: string, error: string): Promise<PersistedVerifierSubmission> {
    return this.update(idempotencyKey, { state: "unknown" satisfies VerifierSubmissionState, error });
  }

  private async persist(): Promise<void> {
    const operation = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = join(dirname(this.filePath), `.${this.filePath.split("/").pop() ?? "verifier-submissions"}.tmp`);
      await writeFile(temporaryPath, JSON.stringify({ version: 1, submissions: [...this.records.values()] } satisfies StoreFile), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    };
    this.writeChain = this.writeChain.then(operation);
    return this.writeChain;
  }
}
