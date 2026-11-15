import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

describe("backend verifier submission request parsing", () => {
  it("reproduces Fastify's 400 for an absent JSON body", async () => {
    const app = buildApp({ databasePath: join(mkdtempSync(join(tmpdir(), "attestra-submit-request-")), "executions.json"), demoMode: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/executions/exec-parser-regression/chain/submit-verification",
        headers: { "content-type": "application/json" },
        remoteAddress: "127.0.0.1",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "FST_ERR_CTP_EMPTY_JSON_BODY", statusCode: 400 });
    } finally {
      await app.close();
    }
  });

  it("accepts the fixed frontend request shape past Fastify parsing", async () => {
    const app = buildApp({ databasePath: join(mkdtempSync(join(tmpdir(), "attestra-submit-request-")), "executions.json"), demoMode: true });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/executions/exec-parser-regression/chain/submit-verification",
        headers: { "content-type": "application/json" },
        payload: "{}",
        remoteAddress: "127.0.0.1",
      });

      // The request now reaches the route's authentication boundary. It
      // cannot invoke the signer without an authenticated owner session.
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: "AUTHENTICATION_REQUIRED", message: "Connect and authenticate a NEAR wallet before this operation" } });
    } finally {
      await app.close();
    }
  });
});
