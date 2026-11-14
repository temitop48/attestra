import type { DeterministicValidationReport } from "./html-validation.js";

export { hasRequiredCardQuantity, hasRequiredSection, hasResponsiveCssEvidence, validateHtmlCssDeliverable } from "./html-validation.js";
export type { DeterministicOutcome, DeterministicSeverity, DeterministicValidationInput, DeterministicValidationReport, DeterministicValidationRule } from "./html-validation.js";

export type AgentKind = "research" | "builder" | "qa";

export const plannedAgents: readonly AgentKind[] = ["research", "builder", "qa"];

export type ExecutionStatus = "pending" | "running" | "succeeded" | "failed";
export type FindingSeverity = "low" | "medium" | "high";

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ExecutionMetadata = {
  executionId: string;
  agentId: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  tokenUsage?: TokenUsage;
};

export type AgentExecution<T> = {
  metadata: ExecutionMetadata;
  output?: T;
  error?: AgentErrorInfo;
};

export type AgentErrorInfo = {
  code: string;
  message: string;
  retryable: boolean;
};

export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmRequest = {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export type LlmResponse = {
  content: string;
  model?: string;
  provider?: string;
  usage?: TokenUsage;
};

export interface LlmProvider {
  readonly name: string;
  readonly model?: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
};

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new AgentError("PROVIDER_CONFIG", "An LLM API key is required");
    }
    if (!options.model.trim()) {
      throw new AgentError("PROVIDER_CONFIG", "An LLM model identifier is required");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1_000, 120_000, "timeoutMs");
    this.maxRetries = boundedInteger(options.maxRetries ?? 2, 0, 3, "maxRetries");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: request.model ?? this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 4_000,
      response_format: { type: "json_object" },
    };

    let lastError: AgentError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const message = providerMessage(payload) ?? `LLM provider returned HTTP ${response.status}`;
          const error = new AgentError("PROVIDER_HTTP", message, response.status >= 500 || response.status === 429);
          (error as AgentError & { retryAfterMs?: number }).retryAfterMs = retryAfterMilliseconds(response);
          throw error;
        }

        const content = readString(readObject(payload)?.choices?.[0] && readObject(readObject(payload)?.choices?.[0])?.message, "content");
        if (!content) {
          throw new AgentError("PROVIDER_RESPONSE", "LLM provider returned no message content", true);
        }
        const usage = readUsage(readObject(payload)?.usage);
        return {
          content,
          model: readString(payload, "model") ?? this.model,
          provider: this.name,
          usage,
        };
      } catch (error) {
        lastError = normalizeProviderError(error);
        if (!lastError.retryable || attempt >= this.maxRetries) throw lastError;
        const retryAfterMs = (lastError as AgentError & { retryAfterMs?: number }).retryAfterMs;
        const backoffMs = Math.min(5_000, 250 * 2 ** attempt);
        await delay(retryAfterMs ?? backoffMs + Math.floor(Math.random() * 250));
      }
    }
    throw lastError ?? new AgentError("PROVIDER_ERROR", "LLM provider failed", true);
  }
}

export function providerFromEnvironment(env: Record<string, string | undefined> = readEnvironment()): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: env.ATTESTRA_LLM_API_KEY ?? "",
    baseUrl: env.ATTESTRA_LLM_BASE_URL,
    model: env.ATTESTRA_LLM_MODEL ?? "gpt-4o-mini",
    timeoutMs: env.ATTESTRA_LLM_TIMEOUT_MS ? Number(env.ATTESTRA_LLM_TIMEOUT_MS) : undefined,
    maxRetries: env.ATTESTRA_LLM_MAX_RETRIES ? Number(env.ATTESTRA_LLM_MAX_RETRIES) : undefined,
  });
}

export type ResearchInput = {
  projectId?: string;
  requirements: string;
  targetAudience?: string;
  constraints?: string[];
};

export type ResearchSpec = {
  projectId?: string;
  summary: string;
  sections: string[];
  acceptanceCriteria: string[];
  designRequirements: string[];
  implementationRequirements: string[];
  ambiguities: string[];
  risks: string[];
};

export type BuilderInput = {
  research: ResearchSpec;
  rework?: {
    attempt: number;
    findings: QaFinding[];
    recommendations: string[];
    previousRevision: number;
    previousDigest: string;
    previousArtifacts: Artifact[];
    latestQa: QaOutput;
    unresolvedRequirements: string[];
    requiredSections: string[];
  };
};

export type Artifact = {
  path: string;
  content: string;
  mediaType: "text/html" | "text/css" | "text/javascript";
};

export type BuilderOutput = {
  summary: string;
  artifacts: Artifact[];
};

export type QaInput = { research: ResearchSpec; deliverable: BuilderOutput; deterministicValidation?: DeterministicValidationReport };

export type QaFinding = {
  severity: FindingSeverity;
  code: string;
  message: string;
  path?: string;
  recommendation: string;
};

export type QaOutput = {
  passed: boolean;
  findings: QaFinding[];
  missingRequirements: string[];
  recommendations: string[];
};

const MAX_REQUIREMENTS_LENGTH = 20_000;
const MAX_ARRAY_ITEMS = 32;
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 100_000;
const MAX_TOTAL_ARTIFACT_BYTES = 250_000;
const MAX_RESPONSE_BYTES = 500_000;
const MAX_AGENT_EXECUTION_MS = 120_000;

export const ARTIFACT_LIMITS = {
  maxArtifacts: MAX_ARTIFACTS,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  maxTotalArtifactBytes: MAX_TOTAL_ARTIFACT_BYTES,
} as const;

export function artifactByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isSafeArtifactPath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) && !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

export const agentDefinitions = {
  research: {
    id: "research-agent-v1",
    role: "Research Agent",
    systemPrompt:
      "You are ATTESTRA's Research Agent. Analyze the supplied project requirements and return exactly one top-level JSON object, with no wrapper object, Markdown fences, or explanatory text. The object must match this exact schema: {\"projectId\": string optional, \"summary\": string non-empty, \"sections\": string[], \"acceptanceCriteria\": string[], \"designRequirements\": string[], \"implementationRequirements\": string[], \"ambiguities\": string[], \"risks\": string[]}. All six array properties are required and may be empty when appropriate. Preserve explicit quantities and counts in acceptanceCriteria (for example, \"three feature cards\") so deterministic validation and rework can enforce them. Use valid JSON, be concrete, identify ambiguity, and never invent credentials or external facts. Example: {\"summary\":\"A focused landing page for professionals.\",\"sections\":[\"hero\"],\"acceptanceCriteria\":[\"three feature cards\"],\"designRequirements\":[\"clear hierarchy\"],\"implementationRequirements\":[\"responsive HTML\"],\"ambiguities\":[],\"risks\":[]}",
  },
  builder: {
    id: "builder-agent-v1",
    role: "Builder Agent",
    systemPrompt:
      "You are ATTESTRA's Builder Agent. Convert the supplied research specification into a safe static landing page and return exactly one top-level JSON object with no wrapper object, Markdown fences, or explanatory text. The object must match this exact schema: {\"summary\": string non-empty, \"artifacts\": Artifact[]}. Each Artifact must be {\"path\": string, \"mediaType\": \"text/html\"|\"text/css\"|\"text/javascript\", \"content\": string non-empty}; include exactly relative index.html with text/html and styles.css with text/css, and use matching .js/text/javascript only for optional browser JavaScript. Use safe relative paths, plain static files, and no secrets. Implement every acceptanceCriteria item exactly, preserving explicit quantities. For each required section, use semantic HTML plus a stable normalized id, class, data-section, or aria-label; for repeated content, use identifiable card elements and the required count. When rework context is supplied, revise the previous artifacts rather than regenerating unrelated content: preserve every previously satisfied ResearchSpec section, use the preservation checklist, fix the latest blocking QA findings and missing requirements, maintain responsive behavior and valid semantic HTML with accessible names, and return complete replacement artifacts rather than partial patches. Example: {\"summary\":\"Static landing page\",\"artifacts\":[{\"path\":\"index.html\",\"mediaType\":\"text/html\",\"content\":\"<!doctype html><html><body></body></html>\"},{\"path\":\"styles.css\",\"mediaType\":\"text/css\",\"content\":\"body{}\"}]}",
  },
  qa: {
    id: "qa-agent-v1",
    role: "QA Agent",
    systemPrompt:
      "You are ATTESTRA's internal QA Agent. Compare the static deliverable with the research specification and the deterministic validation report supplied in the input. Return exactly one top-level JSON object with no wrapper object, Markdown fences, or explanatory text. The object must match this exact schema: {\"passed\": boolean, \"findings\": Finding[], \"missingRequirements\": string[], \"recommendations\": string[]}. Each Finding must be {\"severity\": \"low\"|\"medium\"|\"high\", \"code\": string non-empty, \"message\": string non-empty, \"path\": string optional, \"recommendation\": string non-empty}. All arrays are required and may be empty when appropriate. A deterministic report with outcome=fail and blocking=true is verified blocking evidence: acknowledge it and do not contradict it without a specific explanation tied to the artifact. Deterministic unknown outcomes are not failures. Set passed=false only for a demonstrable blocking failure: an explicitly required section or deliverable is missing, a required quantity is not met, functionality is broken, an explicit acceptance criterion is violated, or an accessibility defect is supported by supplied markup or deterministic evidence. Set passed=true when only subjective design, optional SEO, cosmetic, redundant ARIA, or unverified concerns remain; put those in recommendations. Visible descriptive button text is an accessible name. A <nav> element is already a navigation landmark; do not require redundant role=\"navigation\" or aria-label attributes. Assess contrast from actual foreground/background values when possible and do not claim a WCAG failure without sufficient evidence. Example: {\"passed\":true,\"findings\":[],\"missingRequirements\":[],\"recommendations\":[\"Consider an optional meta description.\"]}. Identify concrete missing requirements and recommend revisions. You are not the independent verifier.",
  },
} as const;

type SchemaField = { name: string; required: boolean };

function schemaDiagnostics(content: string, agentKind: AgentKind, response: LlmResponse, fields: readonly SchemaField[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).slice(0, 12).map((key) => key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)).join(",") || "none";
  const fieldState = fields.map(({ name, required }) => `${name}:${Object.prototype.hasOwnProperty.call(value, name) ? typeof value[name] : required ? "missing" : "absent"}`).join(",");
  const model = (response.model ?? "unknown").replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 80);
  const provider = (response.provider ?? "unknown").replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 80);
  return `schema_diagnostic agent=${agentKind} model=${model} provider=${provider} keys=${keys} fields=${fieldState}`;
}

function parseAgentOutput<T>(content: string, response: LlmResponse, agentKind: AgentKind, fields: readonly SchemaField[], parser: (value: string) => T): T {
  try {
    return parser(content);
  } catch (error) {
    const diagnostic = schemaDiagnostics(content, agentKind, response, fields);
    if (diagnostic && error instanceof AgentError) throw new AgentError(error.code, `${error.message}; ${diagnostic}`, error.retryable);
    throw error;
  }
}

const researchFields: readonly SchemaField[] = [
  { name: "projectId", required: false },
  { name: "summary", required: true },
  { name: "sections", required: true },
  { name: "acceptanceCriteria", required: true },
  { name: "designRequirements", required: true },
  { name: "implementationRequirements", required: true },
  { name: "ambiguities", required: true },
  { name: "risks", required: true },
];
const builderFields: readonly SchemaField[] = [{ name: "summary", required: true }, { name: "artifacts", required: true }];
const qaFields: readonly SchemaField[] = [{ name: "passed", required: true }, { name: "findings", required: true }, { name: "missingRequirements", required: true }, { name: "recommendations", required: true }];

export class ResearchAgent {
  readonly kind = "research" as const;
  readonly id = agentDefinitions.research.id;

  constructor(private readonly provider: LlmProvider) {}

  async execute(input: ResearchInput): Promise<AgentExecution<ResearchSpec>> {
    return executeAgent(this.id, this.provider, input, validateResearchInput, async (value) => {
      const response = await this.provider.complete({
        messages: [
          { role: "system", content: agentDefinitions.research.systemPrompt },
          { role: "user", content: JSON.stringify({ task: "research", input: value }) },
        ],
      });
      return { output: parseAgentOutput(response.content, response, "research", researchFields, parseResearchSpec), response };
    });
  }
}

export class BuilderAgent {
  readonly kind = "builder" as const;
  readonly id = agentDefinitions.builder.id;

  constructor(private readonly provider: LlmProvider) {}

  async execute(input: BuilderInput): Promise<AgentExecution<BuilderOutput>> {
    return executeAgent(this.id, this.provider, input, validateBuilderInput, async (value) => {
      const response = await this.provider.complete({
        messages: [
          { role: "system", content: agentDefinitions.builder.systemPrompt },
          { role: "user", content: JSON.stringify({ task: "build", input: value }) },
        ],
      });
      return { output: parseAgentOutput(response.content, response, "builder", builderFields, parseBuilderOutput), response };
    });
  }
}

export class QaAgent {
  readonly kind = "qa" as const;
  readonly id = agentDefinitions.qa.id;

  constructor(private readonly provider: LlmProvider) {}

  async execute(input: QaInput): Promise<AgentExecution<QaOutput>> {
    return executeAgent(this.id, this.provider, input, validateQaInput, async (value) => {
      const response = await this.provider.complete({
        messages: [
          { role: "system", content: agentDefinitions.qa.systemPrompt },
          { role: "user", content: JSON.stringify({ task: "qa", input: value }) },
        ],
      });
      return { output: parseAgentOutput(response.content, response, "qa", qaFields, parseQaOutput), response };
    });
  }
}

export class AgentRunner {
  async runResearch(agent: ResearchAgent, input: ResearchInput) {
    return agent.execute(input);
  }

  async runBuilder(agent: BuilderAgent, input: BuilderInput) {
    return agent.execute(input);
  }

  async runQa(agent: QaAgent, input: QaInput) {
    return agent.execute(input);
  }
}

export class DeterministicMockProvider implements LlmProvider {
  readonly name = "deterministic-mock";
  readonly model = "mock-v1";
  private readonly responses: string[];
  private readonly failure?: AgentError;
  calls = 0;
  readonly requests: LlmRequest[] = [];

  constructor(options: { responses?: string[]; failure?: AgentError } = {}) {
    this.responses = [...(options.responses ?? [])];
    this.failure = options.failure;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
    this.requests.push(request);
    if (this.failure) throw this.failure;
    const content = this.responses.shift();
    if (!content) throw new AgentError("MOCK_EXHAUSTED", "Mock provider has no response", false);
    return { content, model: this.model, provider: this.name, usage: { totalTokens: 0 } };
  }
}

export function validateResearchInput(input: ResearchInput): void {
  assertObject(input, "Research input must be an object");
  assertText(input.requirements, "requirements", MAX_REQUIREMENTS_LENGTH);
  if (input.projectId !== undefined) assertText(input.projectId, "projectId", 128);
  if (input.targetAudience !== undefined) assertText(input.targetAudience, "targetAudience", 1_000);
  if (input.constraints !== undefined) validateStringArray(input.constraints, "constraints");
}

export function parseResearchSpec(content: string): ResearchSpec {
  const value = parseJson(content);
  assertObject(value, "Research response must be an object");
  const spec: ResearchSpec = {
    projectId: optionalText(value.projectId, "projectId", 128),
    summary: requiredText(value.summary, "summary", 4_000),
    sections: requiredStringArray(value.sections, "sections"),
    acceptanceCriteria: value.acceptanceCriteria === undefined ? [] : requiredStringArray(value.acceptanceCriteria, "acceptanceCriteria"),
    designRequirements: requiredStringArray(value.designRequirements, "designRequirements"),
    implementationRequirements: requiredStringArray(value.implementationRequirements, "implementationRequirements"),
    ambiguities: requiredStringArray(value.ambiguities, "ambiguities"),
    risks: requiredStringArray(value.risks, "risks"),
  };
  return spec;
}

export function validateBuilderInput(input: BuilderInput): void {
  assertObject(input, "Builder input must be an object");
  parseResearchSpec(JSON.stringify(input.research));
  if (input.rework !== undefined) {
    if (!Number.isInteger(input.rework.attempt) || input.rework.attempt < 1 || input.rework.attempt > 3) {
      throw new AgentError("INVALID_INPUT", "rework.attempt must be between 1 and 3");
    }
    if (!Array.isArray(input.rework.findings) || !Array.isArray(input.rework.recommendations)) {
      throw new AgentError("INVALID_INPUT", "rework findings and recommendations are required arrays");
    }
    input.rework.findings.forEach(parseFinding);
    validateStringArray(input.rework.recommendations, "rework.recommendations");
    if (!Number.isInteger(input.rework.previousRevision) || input.rework.previousRevision < 1 || input.rework.previousRevision > 3) throw new AgentError("INVALID_INPUT", "rework.previousRevision must be between 1 and 3");
    if (!/^[a-f0-9]{64}$/.test(input.rework.previousDigest)) throw new AgentError("INVALID_INPUT", "rework.previousDigest must be a SHA-256 digest");
    parseBuilderOutput(JSON.stringify({ summary: "previous deliverable", artifacts: input.rework.previousArtifacts }));
    parseQaOutput(JSON.stringify(input.rework.latestQa));
    validateStringArray(input.rework.unresolvedRequirements, "rework.unresolvedRequirements");
    validateStringArray(input.rework.requiredSections, "rework.requiredSections");
  }
}

export function parseBuilderOutput(content: string): BuilderOutput {
  const value = parseJson(content);
  assertObject(value, "Builder response must be an object");
  const summary = requiredText(value.summary, "summary", 4_000);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > MAX_ARTIFACTS) {
    throw new AgentError("INVALID_ARTIFACTS", `artifacts must contain 1-${MAX_ARTIFACTS} files`);
  }
  const artifacts = value.artifacts.map((item, index) => parseArtifact(item, index));
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) throw new AgentError("INVALID_ARTIFACT_PATH", `Duplicate artifact path: ${artifact.path}`);
    paths.add(artifact.path);
    const bytes = artifactByteLength(artifact.content);
    if (bytes > MAX_ARTIFACT_BYTES) throw new AgentError("ARTIFACT_TOO_LARGE", `${artifact.path} exceeds the per-file limit`);
    totalBytes += bytes;
  }
  if (!paths.has("index.html") || !paths.has("styles.css")) {
    throw new AgentError("INVALID_ARTIFACTS", "A landing page must include index.html and styles.css");
  }
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new AgentError("ARTIFACT_TOO_LARGE", "Artifacts exceed the total size limit");
  return { summary, artifacts };
}

export function validateQaInput(input: QaInput): void {
  assertObject(input, "QA input must be an object");
  validateBuilderInput({ research: input.research });
  parseBuilderOutput(JSON.stringify(input.deliverable));
  if (input.deterministicValidation !== undefined) {
    assertObject(input.deterministicValidation, "deterministicValidation must be an object");
    if (input.deterministicValidation.version !== "html-validation-v1" || !Array.isArray(input.deterministicValidation.rules)) {
      throw new AgentError("INVALID_INPUT", "deterministicValidation has an unsupported shape");
    }
  }
}

export function parseQaOutput(content: string): QaOutput {
  const value = parseJson(content);
  assertObject(value, "QA response must be an object");
  if (typeof value.passed !== "boolean") throw new AgentError("INVALID_QA", "passed must be a boolean");
  const findings = Array.isArray(value.findings) ? value.findings.map(parseFinding) : [];
  const missingRequirements = requiredStringArray(value.missingRequirements ?? [], "missingRequirements");
  const recommendations = requiredStringArray(value.recommendations ?? [], "recommendations");
  return { passed: value.passed, findings, missingRequirements, recommendations };
}

async function executeAgent<I, O>(
  agentId: string,
  provider: LlmProvider,
  input: I,
  validateInput: (value: I) => void,
  invoke: (value: I) => Promise<{ output: O; response: LlmResponse }>,
): Promise<AgentExecution<O>> {
  const executionId = createExecutionId();
  const started = Date.now();
  const metadata: ExecutionMetadata = {
    executionId,
    agentId,
    status: "running",
    startedAt: new Date(started).toISOString(),
    provider: provider.name,
    model: provider.model,
  };
  try {
    validateInput(input);
    const { output, response } = await withTimeout(invoke(input), MAX_AGENT_EXECUTION_MS);
    const completed = Date.now();
    metadata.status = "succeeded";
    metadata.completedAt = new Date(completed).toISOString();
    metadata.durationMs = completed - started;
    metadata.provider = response.provider ?? provider.name;
    metadata.model = response.model ?? provider.model;
    metadata.tokenUsage = response.usage;
    return { metadata, output };
  } catch (error) {
    const completed = Date.now();
    const normalized = normalizeAgentError(error);
    metadata.status = "failed";
    metadata.completedAt = new Date(completed).toISOString();
    metadata.durationMs = completed - started;
    return {
      metadata,
      error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
    };
  }
}

function parseArtifact(value: unknown, index: number): Artifact {
  assertObject(value, `Artifact ${index} must be an object`);
  const path = requiredText(value.path, `artifacts[${index}].path`, 128);
  if (!isSafeArtifactPath(path)) {
    throw new AgentError("INVALID_ARTIFACT_PATH", `Unsafe artifact path: ${path}`);
  }
  const mediaType = value.mediaType;
  if (mediaType !== "text/html" && mediaType !== "text/css" && mediaType !== "text/javascript") {
    throw new AgentError("INVALID_ARTIFACT_TYPE", `Unsupported media type for ${path}`);
  }
  const content = requiredText(value.content, `artifacts[${index}].content`, MAX_ARTIFACT_BYTES);
  const extension = path.split(".").pop();
  const expected = extension === "html" ? "text/html" : extension === "css" ? "text/css" : extension === "js" ? "text/javascript" : undefined;
  if (!expected || expected !== mediaType) throw new AgentError("INVALID_ARTIFACT_TYPE", `Media type does not match path: ${path}`);
  return { path, content, mediaType };
}

function parseFinding(value: unknown): QaFinding {
  assertObject(value, "QA finding must be an object");
  const severity = value.severity;
  if (severity !== "low" && severity !== "medium" && severity !== "high") throw new AgentError("INVALID_QA", "Invalid QA finding severity");
  return {
    severity,
    code: requiredText(value.code, "finding.code", 128),
    message: requiredText(value.message, "finding.message", 2_000),
    path: optionalText(value.path, "finding.path", 128),
    recommendation: requiredText(value.recommendation, "finding.recommendation", 2_000),
  };
}

function parseJson(content: string): Record<string, unknown> {
  if (byteLength(content) > MAX_RESPONSE_BYTES) throw new AgentError("RESPONSE_TOO_LARGE", "Provider response exceeds the response limit");
  try {
    const value: unknown = JSON.parse(content);
    assertObject(value, "Provider response must be a JSON object");
    return value;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("INVALID_JSON", "Provider response was not valid JSON");
  }
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("INVALID_INPUT", message);
}

function assertText(value: unknown, field: string, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new AgentError("INVALID_INPUT", `${field} must be non-empty text`);
  if (byteLength(value) > maxBytes) throw new AgentError("INPUT_TOO_LARGE", `${field} exceeds its size limit`);
}

function requiredText(value: unknown, field: string, maxBytes: number): string {
  assertText(value, field, maxBytes);
  return value;
}

function optionalText(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxBytes);
}

function validateStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || value.some((item) => typeof item !== "string")) {
    throw new AgentError("INVALID_INPUT", `${field} must be an array of at most ${MAX_ARRAY_ITEMS} strings`);
  }
  for (const item of value) assertText(item, field, 1_000);
}

function requiredStringArray(value: unknown, field: string): string[] {
  validateStringArray(value, field);
  return [...value];
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new AgentError("PROVIDER_CONFIG", `${field} must be between ${minimum} and ${maximum}`);
  return value;
}

function byteLength(value: string): number {
  return artifactByteLength(value);
}

function createExecutionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid ?? `exec_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeProviderError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new AgentError("PROVIDER_TIMEOUT", "LLM provider request timed out", true);
  if (error instanceof Error) return new AgentError("PROVIDER_NETWORK", error.message, true);
  return new AgentError("PROVIDER_ERROR", "LLM provider request failed", true);
}

function normalizeAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof Error) return new AgentError("AGENT_ERROR", error.message);
  return new AgentError("AGENT_ERROR", "Agent execution failed");
}

function readObject(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = readObject(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function readUsage(value: unknown): TokenUsage | undefined {
  const usage = readObject(value);
  if (!usage) return undefined;
  return {
    promptTokens: numberOrUndefined(usage.prompt_tokens),
    completionTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function providerMessage(value: unknown): string | undefined {
  const error = readObject(readObject(value)?.error);
  return readString(error, "message");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1_000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.max(0, parsed - Date.now());
}

function readEnvironment(): Record<string, string | undefined> {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return maybeProcess?.env ?? {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentError("AGENT_TIMEOUT", "Agent execution exceeded its time limit", true)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
