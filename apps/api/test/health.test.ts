import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /health", () => {
  it("reports the API as healthy", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "api" });
    await app.close();
  });

  it("gives execution status reads a separate bounded bucket and Retry-After", async () => {
    const app = buildApp();
    for (let index = 0; index < 180; index += 1) {
      const response = await app.inject({ method: "GET", url: `/api/v1/executions/missing-${index}`, remoteAddress: "127.0.0.91" });
      expect(response.statusCode).toBe(404);
    }
    const limited = await app.inject({ method: "GET", url: "/api/v1/executions/missing-final", remoteAddress: "127.0.0.91" });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});
