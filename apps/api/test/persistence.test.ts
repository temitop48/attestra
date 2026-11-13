import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSingleWriterLock, preparePersistentStorage, resolveDatabasePath } from "../src/persistence.js";

describe("production persistence bootstrap", () => {
  it("resolves a configurable data directory and prepares private storage", async () => {
    const root = await mkdtemp(join("/tmp", "attestra-storage-")); const database = join(root, "data", "executions.json");
    await preparePersistentStorage(database); expect(resolveDatabasePath({ ATTESTRA_DATA_DIR: join(root, "data") })).toBe(database);
    const release = await acquireSingleWriterLock(database); await expect(acquireSingleWriterLock(database)).rejects.toThrow("persistent storage lock"); await release(); await rm(root, { recursive: true, force: true });
  });
});
