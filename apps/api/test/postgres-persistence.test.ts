import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createPostgresPersistence } from "../src/postgres-persistence.js";

describe("PostgreSQL production persistence", () => {
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
});
