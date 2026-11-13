import { describe, expect, it } from "vitest";
import { healthResponse } from "../src/index.js";

describe("shared contracts", () => {
  it("creates a stable health response shape", () => {
    expect(healthResponse()).toMatchObject({ status: "ok", service: "api" });
  });
});
