import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const keys = ["NEAR_NETWORK", "NEAR_ESCROW_CONTRACT_ACCOUNT", "NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO", "NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO", "NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO", "NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO"] as const;
const previous = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});

describe("GET /api/v1/near/config", () => {
  it("exposes the configured approval and settlement deposits to the browser runtime", async () => {
    for (const key of keys) previous.set(key, process.env[key]);
    process.env.NEAR_NETWORK = "testnet";
    process.env.NEAR_ESCROW_CONTRACT_ACCOUNT = "escrow.attestra-owner.testnet";
    process.env.NEAR_PROJECT_STORAGE_DEPOSIT_YOCTO = "3000000000000000000000";
    process.env.NEAR_MILESTONE_STORAGE_DEPOSIT_YOCTO = "5000000000000000000000";
    process.env.NEAR_APPROVAL_STORAGE_DEPOSIT_YOCTO = "330000000000000000000";
    process.env.NEAR_SETTLEMENT_STORAGE_DEPOSIT_YOCTO = "510000000000000000000";

    const app = buildApp({ demoMode: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/near/config" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approvalStorageDeposit: "330000000000000000000",
      settlementStorageDeposit: "510000000000000000000",
    });
    await app.close();
  });
});
