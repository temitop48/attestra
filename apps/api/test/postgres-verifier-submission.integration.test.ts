import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresVerifierSubmissionStore } from "../src/postgres-persistence.js";

function isolatedDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return undefined;
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return undefined;
    if (url.port !== "55432" || url.pathname !== "/attestra_test" || url.username !== "attestra_test") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const databaseUrl = isolatedDatabaseUrl(process.env.ATTESTRA_TEST_DATABASE_URL);
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : (undefined as unknown as Pool);
const key = "integration-execution:integration-receipt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type RecoveryState = "reserved" | "broadcast_attempted" | "transaction_known" | "finalized" | "definitive_failure" | "unknown" | "receipt_confirmed_without_hash";

function record(state: "pending" | "finalized" | "failed" | "unknown", recoveryState: RecoveryState = "transaction_known", revision = 0) {
  return {
    idempotencyKey: key,
    state,
    recoveryState,
    revision,
    executionId: "integration-execution",
    receiptId: "integration-receipt",
    artifactDigest: "a".repeat(64),
  };
}

async function reset() {
  if (!pool) throw new Error("ATTESTRA_TEST_DATABASE_URL must point to the isolated local PostgreSQL test database");
  await pool.query("delete from attest_verifier_submissions");
}

async function openStores() {
  if (!pool) throw new Error("ATTESTRA_TEST_DATABASE_URL must point to the isolated local PostgreSQL test database");
  return Promise.all([PostgresVerifierSubmissionStore.open(pool), PostgresVerifierSubmissionStore.open(pool)]);
}

describe.skipIf(!databaseUrl)("real PostgreSQL verifier-submission recovery and concurrency", () => {
  beforeAll(async () => {
    if (!pool) return;
    const migration = await readFile(new URL("../migrations/001_persistence.sql", import.meta.url), "utf8");
    for (const statement of migration.split(";").map((sql) => sql.trim()).filter(Boolean)) await pool.query(statement);
    const identity = await pool.query<{ database: string; user: string }>("select current_database() as database, current_user as user");
    expect(identity.rows[0]).toMatchObject({ database: "attestra_test", user: "attestra_test" });
    await reset();
  });

  afterAll(async () => {
    if (!pool) return;
    await reset();
    await pool.end();
  });

  it("uses the isolated PostgreSQL persistence implementation", async () => {
    if (!pool) return;
    const version = await pool.query<{ version: string }>("select version()");
    expect(version.rows[0].version).toMatch(/^PostgreSQL 16\./);
  });

  it("serializes concurrent updates from independent store instances and rejects one stale writer", async () => {
    await reset();
    const [first, second] = await openStores();
    await first.reserve(key, record("pending", "transaction_known"));
    const outcomes = await Promise.allSettled([
      first.update(key, { state: "finalized", recoveryState: "finalized" }),
      second.update(key, { state: "unknown", recoveryState: "unknown" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const persisted = await pool.query<{ record: typeof record extends (...args: never[]) => infer T ? T : never }>("select record from attest_verifier_submissions where idempotency_key = $1", [key]);
    expect(persisted.rows[0].record.revision).toBe(1);
    expect(["finalized", "unknown"]).toContain(persisted.rows[0].record.recoveryState);
  });

  it("proves SELECT FOR UPDATE row locking with a blocked writer", async () => {
    if (!pool) return;
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("pending", "transaction_known"));
    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query("select record from attest_verifier_submissions where idempotency_key = $1 for update", [key]);
      let finished = false;
      const update = store.update(key, { state: "finalized", recoveryState: "finalized" }).then(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(finished).toBe(false);
      await locker.query("commit");
      await update;
      expect(finished).toBe(true);
    } finally {
      locker.release();
    }
  });

  it("detects stale JSONB revisions and refreshes the losing cache", async () => {
    await reset();
    const [winner, stale] = await openStores();
    await winner.reserve(key, record("pending", "transaction_known"));
    await stale.reserve(key, record("pending", "transaction_known"));
    await winner.update(key, { state: "finalized", recoveryState: "finalized" });
    await expect(stale.update(key, { state: "unknown", recoveryState: "unknown" })).rejects.toThrow("changed by another writer");
    expect(stale.get(key)).toMatchObject({ state: "finalized", recoveryState: "finalized", revision: 1 });
  });

  it.each([
    ["finalized", "finalized", "unknown"],
    ["definitive_failure", "failed", "finalized"],
  ] as const)("preserves %s against a concurrent conflicting update", async (initialRecovery, initialState, conflictingRecovery) => {
    await reset();
    const [store, stale] = await openStores();
    await store.reserve(key, record("pending", "transaction_known"));
    await stale.reserve(key, record("pending", "transaction_known"));
    await store.update(key, { state: initialState, recoveryState: initialRecovery });
    await expect(stale.update(key, { state: conflictingRecovery === "unknown" ? "unknown" : "finalized", recoveryState: conflictingRecovery })).rejects.toThrow("changed by another writer");
    const persisted = await pool.query<{ record: ReturnType<typeof record> }>("select record from attest_verifier_submissions where idempotency_key = $1", [key]);
    expect(persisted.rows[0].record.recoveryState).toBe(initialRecovery);
  });

  it("rolls back invalid transitions without changing JSONB or the cache", async () => {
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("pending", "transaction_known"));
    await store.update(key, { state: "finalized", recoveryState: "finalized" });
    await expect(store.update(key, { state: "unknown", recoveryState: "unknown" })).rejects.toThrow("Illegal verifier submission transition");
    expect(store.get(key)).toMatchObject({ recoveryState: "finalized", revision: 1 });
    const persisted = await pool.query<{ record: ReturnType<typeof record> }>("select record from attest_verifier_submissions where idempotency_key = $1", [key]);
    expect(persisted.rows[0].record).toMatchObject({ recoveryState: "finalized", revision: 1 });
  });

  it("refreshes a cache from durable state before applying a later write", async () => {
    await reset();
    const [writer, reader] = await openStores();
    await writer.reserve(key, record("pending", "transaction_known"));
    await reader.reserve(key, record("pending", "transaction_known"));
    await writer.update(key, { state: "finalized", recoveryState: "finalized" });
    await expect(reader.update(key, { state: "unknown", recoveryState: "unknown" })).rejects.toThrow("changed by another writer");
    expect(reader.get(key)?.revision).toBe(1);
    expect((await reader.get(key))?.recoveryState).toBe("finalized");
  });

  it("writes durable state before updating in-memory state", async () => {
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("pending", "transaction_known"));
    await store.update(key, { state: "finalized", recoveryState: "finalized" });
    const independent = await PostgresVerifierSubmissionStore.open(pool);
    expect(independent.get(key)).toMatchObject({ state: "finalized", recoveryState: "finalized", revision: 1 });
  });

  it("normalizes legacy records without revision or recovery fields conservatively", async () => {
    await reset();
    await pool.query("insert into attest_verifier_submissions (idempotency_key, execution_id, record) values ($1, $2, $3::jsonb)", [key, "integration-execution", JSON.stringify({ ...record("pending"), recoveryState: undefined, revision: undefined })]);
    const store = await PostgresVerifierSubmissionStore.open(pool);
    expect(store.get(key)).toMatchObject({ revision: 0, recoveryState: "broadcast_attempted" });
  });

  it("reserves a unique idempotency key exactly once under concurrency", async () => {
    await reset();
    const [first, second] = await openStores();
    const results = await Promise.all([first.reserve(key, record("pending", "reserved")), second.reserve(key, record("pending", "reserved"))]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect((await pool.query("select count(*)::int as count from attest_verifier_submissions where idempotency_key = $1", [key])).rows[0].count).toBe(1);
  });

  it("allows repeated finalized updates but never permits regression", async () => {
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("pending", "transaction_known"));
    await store.update(key, { state: "finalized", recoveryState: "finalized" });
    await expect(store.update(key, { state: "finalized", recoveryState: "finalized" })).resolves.toMatchObject({ revision: 2 });
    await expect(store.update(key, { state: "pending", recoveryState: "broadcast_attempted" })).rejects.toThrow("Illegal verifier submission transition");
  });

  it("does not make receipt-confirmed-without-hash broadcastable", async () => {
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("finalized", "receipt_confirmed_without_hash"));
    await expect(store.update(key, { recoveryState: "broadcast_attempted" })).rejects.toThrow("Illegal verifier submission transition");
    expect(store.get(key)?.transactionHash).toBeUndefined();
  });

  it("does not automatically rebroadcast an unknown outcome", async () => {
    await reset();
    const store = await PostgresVerifierSubmissionStore.open(pool);
    await store.reserve(key, record("unknown", "unknown"));
    await expect(store.update(key, { recoveryState: "broadcast_attempted" })).rejects.toThrow("Illegal verifier submission transition");
    expect(store.get(key)).toMatchObject({ state: "unknown", recoveryState: "unknown", revision: 0 });
  });
});
