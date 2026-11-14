import { describe, expect, it, vi } from "vitest";
import {
  AgentError,
  AgentRunner,
  agentDefinitions,
  BuilderAgent,
  DeterministicMockProvider,
  OpenAICompatibleProvider,
  QaAgent,
  ResearchAgent,
  type BuilderOutput,
  type ResearchSpec,
  parseBuilderOutput,
  parseQaOutput,
  parseResearchSpec,
  plannedAgents,
} from "../src/index.js";

describe("agent catalog", () => {
  it("documents the planned specialist agents", () => {
    expect(plannedAgents).toEqual(["research", "builder", "qa"]);
  });
});

const researchJson = JSON.stringify({
  summary: "A focused product landing page for an engineering audience.",
  sections: ["hero", "workflow", "proof"],
  acceptanceCriteria: ["hero", "workflow", "proof"],
  designRequirements: ["Clear hierarchy", "High contrast"],
  implementationRequirements: ["Responsive HTML", "No external secrets"],
  ambiguities: [],
  risks: ["Claims need review"],
});

const builderJson = JSON.stringify({
  summary: "Generated static landing page",
  artifacts: [
    { path: "index.html", mediaType: "text/html", content: "<!doctype html><html><body><h1>ATTESTRA</h1></body></html>" },
    { path: "styles.css", mediaType: "text/css", content: "body { color: #111; }" },
  ],
});

describe("agent execution", () => {
  it("publishes explicit schemas in each specialist prompt", () => {
    expect(agentDefinitions.research.systemPrompt).toContain('"summary": string non-empty');
    expect(agentDefinitions.research.systemPrompt).toContain('"implementationRequirements": string[]');
    expect(agentDefinitions.research.systemPrompt).toContain("All six array properties are required");
    expect(agentDefinitions.builder.systemPrompt).toContain('"artifacts": Artifact[]');
    expect(agentDefinitions.builder.systemPrompt).toContain('"mediaType": "text/html"|"text/css"|"text/javascript"');
    expect(agentDefinitions.builder.systemPrompt).toContain("preserve every previously satisfied ResearchSpec section");
    expect(agentDefinitions.builder.systemPrompt).toContain("acceptanceCriteria");
    expect(agentDefinitions.builder.systemPrompt).toContain("stable normalized id, class, data-section, or aria-label");
    expect(agentDefinitions.qa.systemPrompt).toContain('"passed": boolean');
    expect(agentDefinitions.qa.systemPrompt).toContain('"missingRequirements": string[]');
    expect(agentDefinitions.qa.systemPrompt).toContain("Visible descriptive button text is an accessible name");
    expect(agentDefinitions.qa.systemPrompt).toContain("A <nav> element is already a navigation landmark");
    expect(agentDefinitions.qa.systemPrompt).toContain("Set passed=false only for a demonstrable blocking failure");
    expect(agentDefinitions.qa.systemPrompt).toContain("subjective design, optional SEO, cosmetic");
    expect(agentDefinitions.qa.systemPrompt).toContain("do not claim a WCAG failure without sufficient evidence");
  });

  it("validates research input and records successful execution metadata", async () => {
    const provider = new DeterministicMockProvider({ responses: [researchJson] });
    const result = await new ResearchAgent(provider).execute({ requirements: "Build a landing page for ATTESTRA." });

    expect(result.metadata.status).toBe("succeeded");
    expect(result.metadata.executionId).toMatch(/^exec_|^[0-9a-f-]{36}$/);
    expect(result.metadata.durationMs).toBeTypeOf("number");
    expect(result.output?.sections).toContain("hero");
  });

  it("rejects invalid research input before calling the provider", async () => {
    const provider = new DeterministicMockProvider({ responses: [researchJson] });
    const result = await new ResearchAgent(provider).execute({ requirements: "" });

    expect(result.metadata.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(provider.calls).toBe(0);
  });

  it("rejects malformed research output", async () => {
    const provider = new DeterministicMockProvider({ responses: ["{\"summary\":\"missing fields\"}"] });
    const result = await new ResearchAgent(provider).execute({ requirements: "Build a landing page." });

    expect(result.metadata.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(result.error?.message).toContain("schema_diagnostic agent=research");
    expect(result.error?.message).toContain("summary:string");
  });

  it.each([
    ["missing summary", { sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] }],
    ["empty summary", { summary: "", sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] }],
    ["whitespace summary", { summary: "   ", sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] }],
    ["incorrect summary name", { researchSummary: "A valid summary", sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] }],
    ["nested response", { research: { summary: "A valid summary", sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] } }],
    ["missing required arrays", { summary: "A valid summary", sections: [] }],
  ] as const)("rejects ResearchSpec schema error: %s", async (_name, value) => {
    const result = await new ResearchAgent(new DeterministicMockProvider({ responses: [JSON.stringify(value)] })).execute({ requirements: "Build a landing page." });
    expect(result.metadata.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(result.error?.message).toContain("schema_diagnostic agent=research");
  });

  it("accepts a complete ResearchSpec without changing parser strictness", () => {
    expect(parseResearchSpec(researchJson)).toMatchObject({ summary: expect.any(String), sections: expect.any(Array), risks: expect.any(Array) });
  });

  it("generates and validates a static builder artifact manifest", async () => {
    const provider = new DeterministicMockProvider({ responses: [builderJson] });
    const result = await new BuilderAgent(provider).execute({
      research: JSON.parse(researchJson) as ResearchSpec,
    });

    expect(result.metadata.status).toBe("succeeded");
    expect(result.output?.artifacts.map((artifact) => artifact.path)).toEqual(["index.html", "styles.css"]);
  });

  it("rejects artifact path traversal and oversized artifacts", () => {
    expect(() => parseBuilderOutput(JSON.stringify({
      summary: "unsafe",
      artifacts: [
        { path: "index.html", mediaType: "text/html", content: "ok" },
        { path: "../secrets.txt", mediaType: "text/css", content: "body{}" },
      ],
    }))).toThrowError(AgentError);

    expect(() => parseBuilderOutput(JSON.stringify({
      summary: "large",
      artifacts: [
        { path: "index.html", mediaType: "text/html", content: "x".repeat(100_001) },
        { path: "styles.css", mediaType: "text/css", content: "body{}" },
      ],
    }))).toThrowError(/exceeds/);
  });

  it("runs QA against a validated deliverable", async () => {
    const provider = new DeterministicMockProvider({
      responses: [JSON.stringify({
        passed: true,
        findings: [],
        missingRequirements: [],
        recommendations: ["Add a live accessibility audit before release."],
      })],
    });
    const research = JSON.parse(researchJson) as ResearchSpec;
    const deliverable = JSON.parse(builderJson) as BuilderOutput;
    const result = await new QaAgent(provider).execute({ research, deliverable });

    expect(result.metadata.status).toBe("succeeded");
    expect(result.output?.passed).toBe(true);
    expect(result.output?.recommendations).toHaveLength(1);
  });

  it("keeps non-blocking QA recommendations separate from approval", () => {
    const result = parseQaOutput(JSON.stringify({
      passed: true,
      findings: [],
      missingRequirements: [],
      recommendations: ["Consider an optional meta description."],
    }));

    expect(result.passed).toBe(true);
    expect(result.recommendations).toHaveLength(1);
  });

  it("captures provider errors without producing output", async () => {
    const provider = new DeterministicMockProvider({
      failure: new AgentError("PROVIDER_TIMEOUT", "timed out", true),
    });
    const result = await new ResearchAgent(provider).execute({ requirements: "Build a landing page." });

    expect(result.metadata.status).toBe("failed");
    expect(result.error).toEqual({ code: "PROVIDER_TIMEOUT", message: "timed out", retryable: true });
  });

  it("supports the reusable runner", async () => {
    const provider = new DeterministicMockProvider({ responses: [researchJson] });
    const runner = new AgentRunner();
    const result = await runner.runResearch(new ResearchAgent(provider), { requirements: "Build a landing page." });

    expect(result.output?.summary).toContain("landing page");
  });
});

describe("OpenAI-compatible provider", () => {
  it("retries bounded transient failures and returns structured content", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new AgentError("PROVIDER_NETWORK", "temporary", true))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "test-model",
        choices: [{ message: { content: researchJson } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-only-key",
      model: "test-model",
      maxRetries: 1,
      fetchImpl,
    });

    const result = await provider.complete({ messages: [{ role: "user", content: "return json" }] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.content).toContain("hero");
  });

  it("converts provider aborts into bounded timeout errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-only-key",
      model: "test-model",
      maxRetries: 1,
      fetchImpl,
    });

    await expect(provider.complete({ messages: [{ role: "user", content: "return json" }] })).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries HTTP 503 once, honors Retry-After, and recovers", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "test-model", choices: [{ message: { content: researchJson } }] }), { status: 200 }));
    const provider = new OpenAICompatibleProvider({ apiKey: "test-only-key", model: "test-model", maxRetries: 1, fetchImpl });
    await expect(provider.complete({ messages: [{ role: "user", content: "return json" }] })).resolves.toMatchObject({ content: researchJson });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops after bounded repeated HTTP 503 failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503, headers: { "retry-after": "0" } }));
    const provider = new OpenAICompatibleProvider({ apiKey: "test-only-key", model: "test-model", maxRetries: 1, fetchImpl });
    await expect(provider.complete({ messages: [{ role: "user", content: "return json" }] })).rejects.toMatchObject({ code: "PROVIDER_HTTP", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
