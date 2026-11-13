const baseUrl = (process.env.BACKEND_URL ?? "http://localhost:4000").replace(/\/$/, "");
const pollIntervalMs = 2_000;
const maxPolls = 90;

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${body?.error?.message ?? "request failed"}`);
  return body;
}

const project = {
  projectId: "1",
  requirements: "Create a modern, responsive landing page for a productivity application called FocusFlow. Include a hero section, features, benefits, testimonials, pricing, and a call to action. Use a clean professional design with accessible HTML and responsive CSS.",
  targetAudience: "Productivity-focused professionals",
  constraints: ["Use accessible HTML", "Use responsive CSS", "Do not load remote scripts or external resources"],
};
const criteria = {
  requiredSections: ["hero", "features", "benefits", "testimonials", "pricing"],
  acceptanceCriteria: ["FocusFlow", "responsive", "call to action"],
  requireAccessibility: true,
};

console.log(`Checking ${baseUrl}/health`);
console.log("Health:", await request("/health"));
console.log("Creating FocusFlow execution (provider credentials are never printed)...");
const created = await request("/api/v1/executions", { method: "POST", body: JSON.stringify(project) });
console.log("Execution created:", created.executionId);

let execution;
for (let attempt = 1; attempt <= maxPolls; attempt += 1) {
  execution = await request(`/api/v1/executions/${encodeURIComponent(created.executionId)}`);
  console.log(`Poll ${attempt}/${maxPolls}: lifecycle=${execution.lifecycle} status=${execution.status}`);
  if (execution.lifecycle === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}
if (!execution || execution.lifecycle !== "completed") throw new Error("Execution polling timed out; no success is assumed");
console.log("Agent steps:", (execution.steps ?? []).map((step) => ({ kind: step.kind, attempt: step.attempt, status: step.status, error: step.error?.code })));
if (execution.status !== "AwaitingIndependentVerification") throw new Error(`Execution failed: ${execution.failure?.code ?? "unknown failure"}: ${execution.failure?.message ?? "no failure detail"}`);

const artifacts = await request(`/api/v1/executions/${encodeURIComponent(created.executionId)}/artifacts`);
console.log("Artifacts:", { revision: artifacts.revision, digest: artifacts.digest, files: artifacts.artifacts.map((artifact) => ({ path: artifact.path, mediaType: artifact.mediaType, bytes: new TextEncoder().encode(artifact.content).byteLength })) });
const receipt = await request(`/api/v1/executions/${encodeURIComponent(created.executionId)}/verify`, { method: "POST", body: JSON.stringify({ milestoneId: "1", criteria }) });
console.log("Verification receipt:", { receiptId: receipt.receiptId, result: receipt.result, artifactDigest: receipt.artifactDigest, policyVersion: receipt.policyVersion });
if (receipt.result !== "Passed") throw new Error(`Independent verification failed: ${receipt.failure?.code ?? "unknown failure"}: ${receipt.failure?.message ?? "no failure detail"}`);
console.log("Smoke test completed. No NEAR transaction or settlement was attempted.");
