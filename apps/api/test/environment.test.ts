import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadLocalEnvironment } from "../src/environment.js";

describe("local environment loading", () => {
  it("does not load .env.local values in production", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attestra-env-")), ".env.local");
    writeFileSync(path, "FROM_LOCAL_FILE=must-not-load\nEXPLICIT=value-from-process\n");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", EXPLICIT: "deployment-value" };
    loadLocalEnvironment(environment, path);
    expect(environment.FROM_LOCAL_FILE).toBeUndefined();
    expect(environment.EXPLICIT).toBe("deployment-value");
  });

  it("loads missing local values during development without overriding deployment values", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attestra-env-")), ".env.local");
    writeFileSync(path, "FROM_LOCAL_FILE=loaded\nEXPLICIT=file-value\nQUOTED=\"quoted-value\"\n");
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "development", EXPLICIT: "deployment-value" };
    loadLocalEnvironment(environment, path);
    expect(environment.FROM_LOCAL_FILE).toBe("loaded");
    expect(environment.EXPLICIT).toBe("deployment-value");
    expect(environment.QUOTED).toBe("quoted-value");
  });
});
