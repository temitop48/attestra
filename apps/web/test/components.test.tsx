import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateProjectForm } from "../src/components/project-form";
import { nearToYocto } from "../src/components/chain-setup-panel";
import { ExecutionTimeline, timelineStepText } from "../src/components/execution-timeline";
import WorkspacePage from "../src/app/workspace/page";
import { QAEvidence } from "../src/components/qa-evidence";
import { formatExecutionDate } from "../src/components/execution-history";
import { renderToStaticMarkup } from "react-dom/server";
import { VerificationPanel, VerificationReceiptView, reverificationDisabledReasons, verificationEligibility, verificationStatusLabel } from "../src/components/verification-panel";
import { walletStatusLabel } from "../src/components/near-wallet-provider";

describe("project form validation", () => {
  it("converts exact NEAR budgets without floating point", () => {
    expect(nearToYocto("0.01")).toBe("10000000000000000000000");
    expect(() => nearToYocto("0")).toThrow();
    expect(() => nearToYocto("-1")).toThrow();
    expect(() => nearToYocto("0.0000000000000000000000001")).toThrow();
  });
  it("requires a non-empty requirements brief", () => {
    expect(validateProjectForm({ requirements: "   " })).toBe("Project requirements are required.");
  });

  it("accepts valid optional execution settings", () => {
    expect(validateProjectForm({ requirements: "Build FocusFlow", targetAudience: "Teams", constraints: ["Accessible HTML"], maxBuilderAttempts: 3 })).toBeUndefined();
  });

  it("bounds the Builder attempt setting", () => {
    expect(validateProjectForm({ requirements: "Build FocusFlow", maxBuilderAttempts: 4 })).toContain("between 1 and 3");
  });
});

describe("execution timeline", () => {
  it("renders Research, Builder, and QA and preserves failure text", () => {
    const element = ExecutionTimeline({ steps: [{ stepId: "qa-1", kind: "qa", attempt: 1, status: "failed", error: { code: "QA_FAILED", message: "Missing testimonials", stage: "qa", retryable: true } }] });
    expect(React.isValidElement(element)).toBe(true);
    expect(timelineStepText(undefined)).toBe("Waiting for assignment");
    expect(timelineStepText({ stepId: "qa-1", kind: "qa", attempt: 1, status: "failed", error: { code: "QA_FAILED", message: "Missing testimonials", stage: "qa", retryable: true } })).toBe("Missing testimonials");
    expect(element.props.children).toHaveLength(3);
  });
});

describe("workspace presentation", () => {
  it("keeps the temporary escrow setup owner-only and fixed to the reviewed plan", () => {
    const source = readFileSync(new URL("../src/components/chain-setup-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain('OWNER_ACCOUNT = "lateram9099.testnet"');
    expect(source).toContain('RECIPIENT_ACCOUNT = "vitalurial616.testnet"');
    expect(source).toContain('PROJECT_STORAGE_DEPOSIT = "3000000000000000000000"');
    expect(source).toContain('MILESTONE_STORAGE_DEPOSIT = "5000000000000000000000"');
    expect(source).toContain("wallet.authState === \"authenticated\"");
    expect(source).toContain("confirmTransaction");
    expect(source).toContain("recordProjectTransaction");
    expect(source).toContain("recordMilestoneTransaction");
  });

  it("uses one explicit wallet authentication state model", () => {
    expect(walletStatusLabel("disconnected")).toBe("Not connected");
    expect(walletStatusLabel("connected")).toContain("authentication required");
    expect(walletStatusLabel("authenticated")).toBe("Authenticated");
    expect(walletStatusLabel("expired")).toContain("Session expired");
    expect(walletStatusLabel("failed")).toContain("Authentication failed");
    const source = readFileSync(new URL("../src/components/project-workspace.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('<strong>Not connected</strong>');
    expect(source).toContain("wallet.authState");
  });
  it("keeps the workspace route backed by the existing execution workspace", () => {
    const page = WorkspacePage();
    expect(React.isValidElement(page)).toBe(true);
    expect(page.type.name).toBe("ProjectWorkspace");
  });

  it("declares a reduced-motion fallback in the shared stylesheet", () => {
    const stylesheet = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain(".scroll-reveal.reveal-enabled");
  });

  it("formats saved dates and keeps legacy evidence records readable", () => {
    expect(formatExecutionDate("not-a-date")).toBe("Unknown date");
    expect(formatExecutionDate("2026-01-02T00:00:00.000Z")).toContain("Jan");
    const evidence = React.createElement(QAEvidence, { execution: { qaAssessments: [], validationReports: [], reworkRequests: [] } as never });
    expect(React.isValidElement(evidence)).toBe(true);
  });

  it("keeps generated source as escaped text rather than HTML injection", () => {
    const viewer = readFileSync(new URL("../src/components/deliverable-viewer.tsx", import.meta.url), "utf8");
    expect(viewer).toContain("<code>{selected?.content");
    expect(viewer).not.toContain("dangerouslySetInnerHTML");
  });

  it("shows advisory eligibility and does not POST during status rendering", () => {
    const eligible = {
      ...({ executionId: "exec-1", status: "AwaitingIndependentVerification", lifecycle: "completed", requirements: "brief", constraints: [], assignedAgents: [], steps: [], history: [], revisions: [], reworkRequests: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" } as any),
      finalDeliverable: { revision: 1, digest: "a".repeat(64), totalBytes: 12 },
      qaAssessments: [{ revision: 1, digest: "a".repeat(64), passed: true, findings: [], missingRequirements: [], recommendations: [], evaluatedAt: "2026-01-01" }],
      validationReports: [{ revision: 1, artifactDigest: "a".repeat(64), summary: { passed: 1, failed: 0, unknown: 0, blockingFailures: 0 }, rules: [] }],
    };
    expect(verificationEligibility(eligible).eligible).toBe(true);
    expect(verificationEligibility({ ...eligible, qaAssessments: [{ ...eligible.qaAssessments[0], passed: false }] }).reasons).toContain("The final revision has not received QA approval.");
    expect(verificationStatusLabel("not_requested")).toBe("Not requested");
    expect(renderToStaticMarkup(<VerificationPanel execution={eligible} />)).toContain("Request independent verification");
    expect(renderToStaticMarkup(<VerificationReceiptView receipt={{ receiptId: "r1", projectId: "1", milestoneId: "1", artifactDigest: "a".repeat(64), result: "Passed", checks: [], timestamp: "2026-01-01", policyVersion: "verification-policy-v1", verifier: { engineId: "test", llmReview: "disabled" } }} />)).toContain("Verified");
  });

  it("renders legacy verifier versions as unknown and exposes history without posting", () => {
    const markup = renderToStaticMarkup(<VerificationReceiptView receipt={{ receiptId: "legacy", projectId: "1", milestoneId: "1", artifactDigest: "a".repeat(64), result: "Failed", checks: [], timestamp: "2026-01-01", policyVersion: "verification-policy-v1", verifier: { engineId: "legacy", llmReview: "disabled" } }} />);
    expect(markup).toContain("Unknown (legacy)");
    expect(markup).toContain("Rejected");
  });

  it("explains why a re-verification request is disabled", () => {
    const reasons = reverificationDisabledReasons({ eligibility: { eligible: true, reasons: [] }, chainReady: true, requesting: false, loading: false, status: "rejected", reason: "   ", localWritesEnabled: true });
    expect(reasons).toContain("Enter an explicit reason before requesting re-verification.");
    expect(reverificationDisabledReasons({ eligibility: { eligible: false, reasons: ["QA approval is required."] }, chainReady: false, requesting: false, loading: false, status: "rejected", reason: "fix verifier", localWritesEnabled: true })).toEqual(expect.arrayContaining(["QA approval is required.", "Confirmed on-chain project and milestone linkage is required."]));
  });
});
