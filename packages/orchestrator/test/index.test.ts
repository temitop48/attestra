import { describe, expect, it } from "vitest";
import {
  AgentError,
  BuilderAgent,
  DeterministicMockProvider,
  QaAgent,
  ResearchAgent,
  type BuilderOutput,
  type ResearchSpec,
} from "@attestra/agents";
import {
  Orchestrator,
  assertValidTransition,
  canonicalizeArtifacts,
  computeArtifactDigest,
  createEmptyPlan,
  type ProjectExecutionRequest,
} from "../src/index.js";

const research: ResearchSpec = {
  summary: "A focused landing page for an engineering audience.",
  sections: ["hero", "workflow", "proof"],
  designRequirements: ["Clear hierarchy", "High contrast"],
  implementationRequirements: ["Responsive HTML", "No external secrets"],
  ambiguities: [],
  risks: ["Claims need review"],
};

const builder: BuilderOutput = {
  summary: "Static landing page",
  artifacts: [
    { path: "index.html", mediaType: "text/html", content: "<!doctype html><html lang=\"en\"><head><title>ATTESTRA</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><section id=\"hero\"><h1>ATTESTRA</h1><a href=\"#workflow\">Start</a></section><section id=\"workflow\"><h2>Workflow</h2></section><section id=\"proof\"><h2>Proof</h2></section></main></body></html>" },
    { path: "styles.css", mediaType: "text/css", content: "body { color: #111; background: #fff; } @media (max-width: 600px) { body { font-size: 1rem; } }" },
  ],
};

const passingQa = JSON.stringify({ passed: true, findings: [], missingRequirements: [], recommendations: [] });
const failingQa = JSON.stringify({
  passed: false,
  findings: [{ severity: "medium", code: "MISSING_CTA", message: "The page lacks a clear call to action.", recommendation: "Add a primary CTA to the hero." }],
  missingRequirements: ["Primary CTA"],
  recommendations: ["Add and test the CTA."],
});

function request(overrides: Partial<ProjectExecutionRequest> = {}): ProjectExecutionRequest {
  return { projectId: "project-1", requirements: "Build an ATTESTRA landing page.", ...overrides };
}

function orchestrator(options: {
  researchResponses?: string[];
  builderResponses?: string[];
  qaResponses?: string[];
  researchFailure?: AgentError;
  builderFailure?: AgentError;
  qaFailure?: AgentError;
  maxBuilderAttempts?: number;
  maxHistoryEvents?: number;
} = {}) {
  const researchProvider = new DeterministicMockProvider({ responses: options.researchResponses ?? [JSON.stringify(research)], failure: options.researchFailure });
  const builderProvider = new DeterministicMockProvider({ responses: options.builderResponses ?? [JSON.stringify(builder)], failure: options.builderFailure });
  const qaProvider = new DeterministicMockProvider({ responses: options.qaResponses ?? [passingQa], failure: options.qaFailure });
  return {
    value: new Orchestrator({
      researchAgent: new ResearchAgent(researchProvider),
      builderAgent: new BuilderAgent(builderProvider),
      qaAgent: new QaAgent(qaProvider),
      maxBuilderAttempts: options.maxBuilderAttempts,
      maxHistoryEvents: options.maxHistoryEvents,
      executionIdFactory: () => "execution-test",
    }),
    providers: { researchProvider, builderProvider, qaProvider },
  };
}

describe("orchestrator foundation", () => {
  it("keeps the existing empty plan boundary", () => {
    expect(createEmptyPlan()).toEqual([]);
  });
});

describe("autonomous project execution", () => {
  it("completes Research → Builder → QA successfully", async () => {
    const { value } = orchestrator();
    const result = await value.execute(request());

    expect(result.status).toBe("AwaitingIndependentVerification");
    expect(result.research).toEqual(research);
    expect(result.finalDeliverable?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.failure).toBeUndefined();
    expect(result.history.map((event) => event.type)).toContain("deliverable_ready");
  });

  it("propagates Research Agent failure", async () => {
    const { value } = orchestrator({ researchFailure: new AgentError("PROVIDER_TIMEOUT", "research timeout", true) });
    const result = await value.execute(request());

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("PROVIDER_TIMEOUT");
    expect(result.failure?.stage).toBe("research");
  });

  it("does not continue to Builder after Research schema validation fails", async () => {
    const { value, providers } = orchestrator({ researchResponses: [JSON.stringify({ sections: [], designRequirements: [], implementationRequirements: [], ambiguities: [], risks: [] })] });
    const result = await value.execute(request());

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("INVALID_INPUT");
    expect(result.failure?.stage).toBe("research");
    expect(providers.builderProvider.calls).toBe(0);
  });

  it("propagates Builder Agent failure", async () => {
    const { value } = orchestrator({ builderFailure: new AgentError("PROVIDER_HTTP", "builder unavailable", true) });
    const result = await value.execute(request());

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("PROVIDER_HTTP");
    expect(result.failure?.stage).toBe("builder");
  });

  it("reports QA execution failure without falsely reporting success", async () => {
    const { value } = orchestrator({ qaFailure: new AgentError("PROVIDER_TIMEOUT", "qa timeout", true) });
    const result = await value.execute(request());

    expect(result.status).toBe("Failed");
    expect(result.failure?.stage).toBe("qa");
    expect(result.finalDeliverable).toBeUndefined();
  });

  it("performs bounded rework and preserves each revision digest", async () => {
    const revisedBuilder = { ...builder, artifacts: [{ ...builder.artifacts[0]!, content: builder.artifacts[0]!.content.replace("ATTESTRA</h1>", "ATTESTRA Platform</h1>") }, builder.artifacts[1]!] };
    const { value } = orchestrator({ builderResponses: [JSON.stringify(builder), JSON.stringify(revisedBuilder)], qaResponses: [failingQa, passingQa] });
    const result = await value.execute(request());

    expect(result.status).toBe("AwaitingIndependentVerification");
    expect(result.revisions).toHaveLength(2);
    expect(result.revisions[0]?.digest).not.toBe(result.revisions[1]?.digest);
    expect(result.reworkRequests[0]?.findings[0]?.code).toBe("MISSING_CTA");
  });

  it("passes prior artifacts, complete QA context, and preservation requirements into rework", async () => {
    const { value, providers } = orchestrator({ builderResponses: [JSON.stringify(builder), JSON.stringify(builder)], qaResponses: [failingQa, passingQa] });
    const result = await value.execute(request());
    const secondBuilderRequest = JSON.parse(providers.builderProvider.requests[1]!.messages[1]!.content) as { input: { rework?: Record<string, unknown> } };
    const rework = secondBuilderRequest.input.rework;

    expect(result.status).toBe("AwaitingIndependentVerification");
    expect(rework?.previousRevision).toBe(1);
    expect(rework?.previousDigest).toBe(result.revisions[0]?.digest);
    expect(rework?.previousArtifacts).toEqual(builder.artifacts);
    expect(rework?.latestQa).toMatchObject({ passed: false, missingRequirements: ["Primary CTA"] });
    expect(rework?.unresolvedRequirements).toEqual(["Primary CTA"]);
    expect(rework?.requiredSections).toEqual(research.sections);
    expect(result.qaAssessments).toHaveLength(2);
    expect(result.qaAssessments[0]).toMatchObject({ revision: 1, passed: false, digest: result.revisions[0]?.digest });
    expect(result.validationReports[0]).toMatchObject({ executionId: result.executionId, revision: 1, artifactDigest: result.revisions[0]?.digest, version: "html-validation-v1" });
  });

  it("keeps a deterministic blocking failure rejected even when QA says passed", async () => {
    const incompleteBuilder = { ...builder, artifacts: [{ ...builder.artifacts[0]!, content: builder.artifacts[0]!.content.replace(/<section id="workflow">[\s\S]*?<\/section>/, "") }, builder.artifacts[1]!] };
    const { value } = orchestrator({ maxBuilderAttempts: 1, builderResponses: [JSON.stringify(incompleteBuilder)], qaResponses: [passingQa] });
    const result = await value.execute(request({ maxBuilderAttempts: 1 }));

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("REWORK_EXHAUSTED");
    expect(result.qaAssessments[0]?.passed).toBe(false);
    expect(result.qaAssessments[0]?.findings.some((finding) => finding.code === "DETERMINISTIC_REQUIRED_SECTION_WORKFLOW")).toBe(true);
  });

  it("keeps missing required sections blocking across revisions", async () => {
    const missingSectionsQa = JSON.stringify({
      passed: false,
      findings: [
        { severity: "high", code: "MISSING_REQUIRED_SECTION", message: "Required sections are missing.", recommendation: "Restore benefits and testimonials." },
      ],
      missingRequirements: ["benefits", "testimonials"],
      recommendations: [],
    });
    const { value, providers } = orchestrator({ builderResponses: [JSON.stringify(builder), JSON.stringify(builder)], qaResponses: [missingSectionsQa, passingQa] });
    const result = await value.execute(request());
    const secondBuilderRequest = JSON.parse(providers.builderProvider.requests[1]!.messages[1]!.content) as { input: { rework?: { unresolvedRequirements?: string[] } } };

    expect(result.qaAssessments[0]?.missingRequirements).toEqual(["benefits", "testimonials"]);
    expect(secondBuilderRequest.input.rework?.unresolvedRequirements).toEqual(["benefits", "testimonials"]);
  });

  it("fails after rework exhaustion and preserves QA findings", async () => {
    const { value } = orchestrator({ maxBuilderAttempts: 2, builderResponses: [JSON.stringify(builder), JSON.stringify(builder)], qaResponses: [failingQa, failingQa] });
    const result = await value.execute(request());

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("REWORK_EXHAUSTED");
    expect(result.revisions).toHaveLength(2);
    expect(result.reworkRequests.at(-1)?.findings[0]?.code).toBe("MISSING_CTA");
    expect(result.reworkRequests.at(-1)?.terminal).toBe(true);
    expect(result.reworkRequests.at(-1)?.nextBuilderAttempt).toBeUndefined();
    expect(result.qaAssessments).toHaveLength(2);
    expect(result.finalDeliverable).toBeUndefined();
  });

  it("enforces the three-attempt maximum", async () => {
    const { value, providers } = orchestrator({
      maxBuilderAttempts: 3,
      builderResponses: [JSON.stringify(builder), JSON.stringify(builder), JSON.stringify(builder)],
      qaResponses: [failingQa, failingQa, failingQa],
    });
    const result = await value.execute(request({ maxBuilderAttempts: 3 }));

    expect(result.status).toBe("Failed");
    expect(result.failure?.code).toBe("REWORK_EXHAUSTED");
    expect(providers.builderProvider.calls).toBe(3);
  });

  it("rejects invalid state transitions", () => {
    expect(() => assertValidTransition("Created", "Paid" as never)).toThrow(/Cannot transition/);
    expect(() => assertValidTransition("Failed", "Planning")).toThrow(/Cannot transition/);
  });

  it("prevents duplicate execution IDs within the process", async () => {
    const { value } = orchestrator();
    const first = value.execute(request({ executionId: "same-execution" }));

    await expect(value.execute(request({ executionId: "same-execution" }))).rejects.toMatchObject({ code: "DUPLICATE_EXECUTION" });
    await expect(first).resolves.toMatchObject({ executionId: "same-execution" });
  });

  it("uses deterministic canonical artifact hashing", async () => {
    const first = await computeArtifactDigest(builder.artifacts);
    const second = await computeArtifactDigest([...builder.artifacts].reverse());

    expect(canonicalizeArtifacts(builder.artifacts)).toContain('"format":"attestra-artifacts-v2"');
    expect(canonicalizeArtifacts(builder.artifacts)).toContain('"path":"index.html"');
    expect(first).toBe(second);
  });

  it("changes the digest when artifact content changes", async () => {
    const original = await computeArtifactDigest(builder.artifacts);
    const changed = await computeArtifactDigest([{ ...builder.artifacts[0]!, content: "changed" }, builder.artifacts[1]!]);

    expect(changed).not.toBe(original);
  });

  it("keeps the final digest equal to the final artifacts", async () => {
    const { value } = orchestrator();
    const result = await value.execute(request());

    expect(result.finalDeliverable).toBeDefined();
    await expect(computeArtifactDigest(result.finalDeliverable?.artifacts ?? [])).resolves.toBe(result.finalDeliverable?.digest);
  });

  it("records provider timeout errors in the execution failure", async () => {
    const { value } = orchestrator({ researchFailure: new AgentError("PROVIDER_TIMEOUT", "timed out", true) });
    const result = await value.execute(request());

    expect(result.failure).toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("orders assignment before agent start and completion", async () => {
    const { value } = orchestrator();
    const result = await value.execute(request());
    const events = result.history.filter((event) => event.agentKind === "research").map((event) => event.type);

    expect(events.indexOf("agent_assigned")).toBeLessThan(events.indexOf("agent_started"));
    expect(events.indexOf("agent_started")).toBeLessThan(events.indexOf("agent_completed"));
  });

  it("records agent assignment metadata", async () => {
    const { value } = orchestrator();
    const result = await value.execute(request());

    expect(result.assignedAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentKind: "research", agentId: "research-agent-v1", attempt: 1 }),
      expect.objectContaining({ agentKind: "builder", agentId: "builder-agent-v1", attempt: 1 }),
      expect.objectContaining({ agentKind: "qa", agentId: "qa-agent-v1", attempt: 1 }),
    ]));
  });

  it("bounds execution history", async () => {
    const { value } = orchestrator({ maxHistoryEvents: 32, maxBuilderAttempts: 3, builderResponses: [JSON.stringify(builder), JSON.stringify(builder), JSON.stringify(builder)], qaResponses: [failingQa, failingQa, failingQa] });
    const result = await value.execute(request({ maxHistoryEvents: 32, maxBuilderAttempts: 3 }));

    expect(result.history.length).toBeLessThanOrEqual(32);
    expect(result.status).toBe("Failed");
  });

  it("never emits a blockchain settlement or verification success", async () => {
    const { value } = orchestrator();
    const result = await value.execute(request());
    const eventTypes = result.history.map((event) => event.type);

    expect(result.status).toBe("AwaitingIndependentVerification");
    expect(eventTypes).not.toContain("payment_pending");
    expect(eventTypes).not.toContain("verification_submitted");
  });
});
