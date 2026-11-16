import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPostgresPersistence, databaseSsl, PostgresVerifierSubmissionStore } from "../src/postgres-persistence.js";
import type { PersistedVerifierSubmission } from "../src/verifier-submission-store.js";

class TransactionalSubmissionPool {
  readonly records = new Map<string, PersistedVerifierSubmission>();
  failUpdates = false;

  async query<T extends { record?: PersistedVerifierSubmission }>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.startsWith("select record from attest_verifier_submissions where")) {
      const record = this.records.get(String(values[0]));
      return { rows: record ? [{ record } as T] : [], rowCount: record ? 1 : 0 };
    }
    if (sql.startsWith("select record from attest_verifier_submissions")) return { rows: [...this.records.values()].map((record) => ({ record } as T)), rowCount: this.records.size };
    if (sql.startsWith("insert into attest_verifier_submissions")) {
      const key = String(values[0]);
      if (this.records.has(key)) return { rows: [], rowCount: 0 };
      this.records.set(key, JSON.parse(String(values[2])) as PersistedVerifierSubmission);
      return { rows: [{ record: this.records.get(key)! } as T], rowCount: 1 };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }

  async connect() {
    const pool = this;
    return {
      async query<T extends { record?: PersistedVerifierSubmission }>(sql: string, values: unknown[] = []) {
        if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] as T[], rowCount: 0 };
        if (sql.startsWith("select record from attest_verifier_submissions where")) {
          const record = pool.records.get(String(values[0]));
          return { rows: record ? [{ record } as T] : [], rowCount: record ? 1 : 0 };
        }
        if (sql.startsWith("update attest_verifier_submissions")) {
          if (pool.failUpdates) throw new Error("database unavailable");
          pool.records.set(String(values[0]), JSON.parse(String(values[1])) as PersistedVerifierSubmission);
          return { rows: [] as T[], rowCount: 1 };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() { /* test client */ },
    };
  }

  async end() { return undefined; }
}

function submission(state: PersistedVerifierSubmission["state"], recoveryState: NonNullable<PersistedVerifierSubmission["recoveryState"]>, revision = 0): PersistedVerifierSubmission {
  return { idempotencyKey: "exec:receipt:digest", state, recoveryState, executionId: "exec", receiptId: "receipt", artifactDigest: "a".repeat(64), revision };
}

describe("PostgreSQL production persistence", () => {
  it("uses verified TLS by default and supports a server-side CA certificate", () => {
    const ssl = databaseSsl({ DATABASE_SSL: "true", DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nexample\\n-----END CERTIFICATE-----" });
    expect(ssl).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----"
    });
  });

  it("does not enable PostgreSQL TLS unless explicitly configured", () => {
    expect(databaseSsl({ DATABASE_SSL: "false", DATABASE_SSL_CA: "not-used" })).toBeUndefined();
  });

  it("rejects JSON paths instead of silently falling back in production", async () => {
    await expect(createPostgresPersistence({ DATABASE_URL: ".data/executions.json" })).rejects.toThrow("PostgreSQL connection string");
  });

  it("ships the required idempotent tables and uniqueness constraints", async () => {
    const migration = await readFile(new URL("../migrations/001_persistence.sql", import.meta.url), "utf8");
    expect(migration).toContain("attest_execution_records");
    expect(migration).toContain("execution_id text primary key");
    expect(migration).toContain("attest_verifier_submissions");
    expect(migration).toContain("idempotency_key text primary key");
  });

  it("fails closed when a configured database cannot be reached", async () => {
    await expect(createPostgresPersistence({ DATABASE_URL: "postgresql://127.0.0.1:1/attestra", DATABASE_SSL: "false" })).rejects.toThrow("PostgreSQL persistence is unavailable");
  });

  it("rejects stale writers after a finalized transition and refreshes their cache", async () => {
    const pool = new TransactionalSubmissionPool();
    pool.records.set("exec:receipt:digest", submission("pending", "transaction_known"));
    const first = await PostgresVerifierSubmissionStore.open(pool as never);
    const stale = await PostgresVerifierSubmissionStore.open(pool as never);
    await first.update("exec:receipt:digest", { state: "finalized", recoveryState: "finalized" });
    await expect(stale.update("exec:receipt:digest", { state: "unknown", recoveryState: "unknown" })).rejects.toThrow("changed by another writer");
    expect(stale.get("exec:receipt:digest")).toMatchObject({ state: "finalized", recoveryState: "finalized", revision: 1 });
    await expect(stale.update("exec:receipt:digest", { state: "definitive_failure", recoveryState: "definitive_failure" })).rejects.toThrow("Illegal verifier submission transition");
  });

  it("allows repeated identical finalized updates but never regresses them", async () => {
    const pool = new TransactionalSubmissionPool();
    pool.records.set("exec:receipt:digest", submission("pending", "transaction_known"));
    const store = await PostgresVerifierSubmissionStore.open(pool as never);
    await store.update("exec:receipt:digest", { state: "finalized", recoveryState: "finalized" });
    await expect(store.update("exec:receipt:digest", { state: "finalized", recoveryState: "finalized" })).resolves.toMatchObject({ state: "finalized", revision: 2 });
    await expect(store.update("exec:receipt:digest", { state: "unknown", recoveryState: "unknown" })).rejects.toThrow("Illegal verifier submission transition");
  });

  it("leaves the cached and durable records unchanged when PostgreSQL persistence fails", async () => {
    const pool = new TransactionalSubmissionPool();
    pool.records.set("exec:receipt:digest", submission("pending", "transaction_known"));
    const store = await PostgresVerifierSubmissionStore.open(pool as never);
    pool.failUpdates = true;
    await expect(store.update("exec:receipt:digest", { state: "finalized", recoveryState: "finalized" })).rejects.toThrow("database unavailable");
    expect(store.get("exec:receipt:digest")).toMatchObject({ state: "pending", recoveryState: "transaction_known", revision: 0 });
    expect(pool.records.get("exec:receipt:digest")).toMatchObject({ state: "pending", recoveryState: "transaction_known", revision: 0 });
  });

  it("normalizes legacy pending records conservatively", async () => {
    const pool = new TransactionalSubmissionPool();
    pool.records.set("exec:receipt:digest", submission("pending", undefined as never));
    delete pool.records.get("exec:receipt:digest")!.recoveryState;
    const store = await PostgresVerifierSubmissionStore.open(pool as never);
    expect(store.get("exec:receipt:digest")).toMatchObject({ state: "pending", recoveryState: "broadcast_attempted", revision: 0 });
  });
});
