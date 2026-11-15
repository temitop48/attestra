import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createExecution, getApiBaseUrl, getArtifacts, getExecution, getVerification, listExecutions, pollExecution, PollingTimeoutError, requestVerification, submitBackendVerification, type ExecutionRecord } from "../src/lib/api";

const execution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  executionId: "exec-test",
  status: "Building",
  lifecycle: "running",
  requirements: "Build a landing page",
  constraints: [],
  assignedAgents: [],
  steps: [],
  history: [],
  revisions: [],
  reworkRequests: [],
  qaAssessments: [],
  validationReports: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("frontend API client", () => {
  it("uses the local API default and creates an execution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ executionId: "exec-1", status: "Created", lifecycle: "queued" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(getApiBaseUrl()).toBe("http://localhost:4000");
    await expect(createExecution({ requirements: "Build FocusFlow" })).resolves.toEqual({ executionId: "exec-1", status: "Created", lifecycle: "queued" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/executions", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ requirements: "Build FocusFlow" }) }));
  });

  it("surfaces structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "requirements is required" } }), { status: 400 })));
    await expect(createExecution({ requirements: "" })).rejects.toMatchObject(new ApiError("requirements is required", 400, "INVALID_REQUEST"));
  });

  it("lists saved executions and loads final artifacts without creating work", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ executionId: "exec-1", status: "AwaitingIndependentVerification", lifecycle: "completed", createdAt: "2026-01-01", updatedAt: "2026-01-02" }], offset: 0, limit: 20 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ executionId: "exec-1", revision: 2, digest: "abc", artifacts: [{ path: "index.html", mediaType: "text/html", content: "<h1>Safe text</h1>" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listExecutions()).resolves.toMatchObject({ items: [{ executionId: "exec-1" }] });
    await expect(getArtifacts("exec-1")).resolves.toMatchObject({ revision: 2, artifacts: [{ path: "index.html" }] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/v1/executions?offset=0&limit=20", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/v1/executions/exec-1/artifacts", expect.anything());
  });

  it("fetches selected execution detail using the encoded execution ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(execution({ executionId: "exec/saved", lifecycle: "completed" })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getExecution("exec/saved")).resolves.toMatchObject({ executionId: "exec/saved", lifecycle: "completed" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/executions/exec%2Fsaved", expect.anything());
  });

  it("retrieves verification state and submits only an explicit POST", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "not_requested", executionId: "exec-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ receiptId: "receipt-1", projectId: "1", milestoneId: "1", artifactDigest: "a".repeat(64), result: "Passed", checks: [], timestamp: "2026-01-01", policyVersion: "verification-policy-v1", verifier: { engineId: "test", llmReview: "disabled" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getVerification("exec-1")).resolves.toMatchObject({ status: "not_requested" });
    await expect(requestVerification("exec-1")).resolves.toMatchObject({ receiptId: "receipt-1", result: "Passed" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:4000/api/v1/executions/exec-1/verification", expect.objectContaining({ headers: { "content-type": "application/json" } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:4000/api/v1/executions/exec-1/verify", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("submits a re-verification reason without exposing verifier configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ receiptId: "receipt-2", result: "Passed" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await requestVerification("exec-1", { reason: "Corrected verifier implementation." });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/executions/exec-1/verify", expect.objectContaining({ method: "POST", body: JSON.stringify({ reverificationReason: "Corrected verifier implementation." }) }));
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain("implementationVersion");
  });

  it("uses the authenticated owner backend boundary for verifier submission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "pending", executionId: "exec-1", receiptId: "receipt-1", artifactDigest: "a".repeat(64), transactionHash: "tx-1", submissionMode: "backend-verifier" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitBackendVerification("exec-1")).resolves.toMatchObject({ state: "pending", submissionMode: "backend-verifier" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/v1/executions/exec-1/chain/submit-verification", expect.objectContaining({ method: "POST", credentials: "include", body: "{}", headers: { "content-type": "application/json" } }));
  });

  it("polls until the API reports a completed lifecycle", async () => {
    const updates: string[] = [];
    const fetchExecution = vi.fn()
      .mockResolvedValueOnce(execution({ status: "Created", lifecycle: "queued" }))
      .mockResolvedValueOnce(execution({ status: "AwaitingIndependentVerification", lifecycle: "completed" }));
    const result = await pollExecution("exec-test", { fetchExecution, intervalMs: 0, sleep: async () => undefined, onUpdate: (next) => updates.push(next.status) });

    expect(result.status).toBe("AwaitingIndependentVerification");
    expect(updates).toEqual(["Created", "AwaitingIndependentVerification"]);
  });

  it("honors Retry-After for a rate-limited status poll", async () => {
    const waits: number[] = [];
    const fetchStatus = vi.fn()
      .mockRejectedValueOnce(new ApiError("Too many requests", 429, "RATE_LIMITED", 4_000))
      .mockResolvedValueOnce(execution({ lifecycle: "completed", status: "Failed" }));
    const result = await pollExecution("exec-test", { fetchExecution: fetchStatus, maxAttempts: 3, sleep: async (milliseconds) => { waits.push(milliseconds); } });
    expect(result.lifecycle).toBe("completed");
    expect(waits).toEqual([4_000]);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("does not overlap status requests and stops at a terminal state", async () => {
    let active = 0;
    let maximum = 0;
    const fetchStatus = vi.fn(async () => { active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1; return execution({ lifecycle: "completed", status: "Failed" }); });
    await pollExecution("exec-test", { fetchExecution: fetchStatus, maxAttempts: 5, sleep: async () => undefined });
    expect(maximum).toBe(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("reports a bounded polling timeout", async () => {
    const fetchExecution = vi.fn().mockResolvedValue(execution());
    await expect(pollExecution("exec-test", { fetchExecution, maxAttempts: 2, intervalMs: 0, sleep: async () => undefined })).rejects.toBeInstanceOf(PollingTimeoutError);
    expect(fetchExecution).toHaveBeenCalledTimes(2);
  });

  it("returns completed failed executions without presenting them as successful", async () => {
    const result = await pollExecution("exec-test", {
      fetchExecution: async () => execution({ lifecycle: "completed", status: "Failed", failure: { code: "AGENT_FAILED", message: "Research failed", stage: "research", retryable: true } }),
    });
    expect(result.lifecycle).toBe("completed");
    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("AGENT_FAILED");
  });
});
