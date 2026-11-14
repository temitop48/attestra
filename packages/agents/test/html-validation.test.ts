import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasRequiredSection, validateHtmlCssDeliverable, type Artifact } from "../src/index.js";

const validHtml = `<!doctype html><html lang="en"><head><title>FocusFlow</title><link rel="stylesheet" href="styles.css"></head><body><nav><a href="#signup">Sign up</a></nav><main><section id="hero"><h1>FocusFlow</h1><a href="#features">Explore features</a></section><section id="features"><h2>Features</h2></section><section id="benefits"><h2>Benefits</h2></section><section id="testimonials"><h2>Testimonials</h2></section><section id="pricing"><h2>Pricing</h2></section><section id="signup"><h2>Get started</h2><form><label for="email">Email</label><input id="email" type="email"><button type="submit">Sign up now</button></form></section></main><footer>Footer</footer></body></html>`;
const validCss = `body { color: #222; background: #fff; } footer { color: #eee; background: #222; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }`;
const validArtifacts: Artifact[] = [
  { path: "index.html", mediaType: "text/html", content: validHtml },
  { path: "styles.css", mediaType: "text/css", content: validCss },
];
const requiredSections = ["hero", "features", "benefits", "testimonials", "pricing", "call to action"];

function report(artifacts: Artifact[] = validArtifacts) {
  return validateHtmlCssDeliverable({ artifacts, requiredSections, acceptanceRequirements: ["responsive CSS", "accessible HTML"] });
}

function formReport(markup: string) {
  return validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: `<!doctype html><html lang="en"><head><title>Forms</title></head><body>${markup}</body></html>` }], requiredSections: [] });
}

describe("deterministic HTML/CSS validation", () => {
  it("does not classify inputs without type or with type=text as submit controls", () => {
    const result = formReport(`<form><input id="implicit-text"><input id="explicit-text" type="text"></form>`);
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "form_control_names")?.outcome).toBe("fail");
  });

  it("recognizes explicit input submit controls and default or explicit submit buttons", () => {
    const result = formReport(`<form><input type="submit"><button type="submit"></button><button></button></form>`);
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("fail");
    expect(result.rules.find((item) => item.id === "submit_control_names")?.message).toContain("3 submit control(s)");
  });

  it("accepts named submit controls while excluding non-submit button types", () => {
    const result = formReport(`<form><input type="submit" aria-label="Save"><button type="submit">Save</button><button>Continue</button><button type="button">Open</button><button type="reset">Reset</button></form>`);
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("pass");
  });

  it("accepts a semantic landing page with three feature cards and a CTA", () => {
    const html = `<!doctype html><html lang="en"><head><title>TaskFlow</title><link rel="stylesheet" href="styles.css"></head><body><header id="hero"><h1>TaskFlow</h1></header><main><section class="feature-cards" aria-label="Features"><article class="feature-card"><h2>Plan</h2></article><article class="feature-card"><h2>Track</h2></article><article class="feature-card"><h2>Ship</h2></article></section><section id="cta-section"><h2>Get started</h2><a href="#hero">Start TaskFlow</a></section></main></body></html>`;
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }, { path: "styles.css", mediaType: "text/css", content: ".feature-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }" }], requiredSections: ["Hero", "Feature Cards", "CTA"], acceptanceRequirements: ["three feature cards"] });
    expect(result.summary.blockingFailures).toBe(0);
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("pass");
  });

  it("reproduces the production builder structure with a feature grid and three cards", () => {
    const html = `<!doctype html><html lang="en"><body><section id="hero"><h1>TaskFlow</h1></section><section class="feature-grid"><article class="card"><h2>Plan</h2></article><article class="card"><h2>Track</h2></article><article class="card"><h2>Ship</h2></article></section><section id="cta-section"><a href="#hero">Start</a></section></body></html>`;
    const result = formReport(html);
    expect(validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }], requiredSections: ["hero", "features", "cta"], acceptanceRequirements: ["three feature cards"] }).rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")).toBeUndefined();
  });

  it("fails when a feature container has fewer than three cards", () => {
    const html = `<section class="feature-grid"><article class="card">One</article><article class="card">Two</article></section>`;
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }], requiredSections: [], acceptanceRequirements: ["three feature cards"] });
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("fail");
  });

  it("does not count generic cards outside the feature section", () => {
    const html = `<div class="card">Pricing</div><section id="features"><article class="card">One</article><article class="card">Two</article><article class="card">Three</article></section>`;
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }], requiredSections: [], acceptanceRequirements: ["three feature cards"] });
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("pass");
  });

  it("counts nested feature-card markup once and accepts semantic article cards", () => {
    const html = `<section aria-label="Features"><article class="feature-card"><div class="feature-card"><h2>One</h2></div></article><article><h2>Two</h2></article><article><h2>Three</h2></article></section>`;
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }], requiredSections: [], acceptanceRequirements: ["three feature cards"] });
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("pass");
  });

  it("recognizes alternative IDs and classes without relying on exact IDs", () => {
    expect(hasRequiredSection(`<header class="masthead"></header>`, "Hero")).toBe(true);
    expect(hasRequiredSection(`<section data-section="feature-cards"></section>`, "Features")).toBe(true);
    expect(hasRequiredSection(`<aside aria-label="Call to Action"></aside>`, "CTA")).toBe(true);
  });

  it("fails missing sections and insufficient quantified cards", () => {
    const html = `<html lang="en"><head><title>TaskFlow</title></head><body><section id="hero"><h1>TaskFlow</h1></section><section class="feature-cards"><article class="feature-card"></article><article class="feature-card"></article></section></body></html>`;
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }, { path: "styles.css", mediaType: "text/css", content: "body{}" }], requiredSections: ["hero", "features", "cta-section"], acceptanceRequirements: ["three feature cards"] });
    expect(result.rules.find((item) => item.id === "required_section_cta_section")?.outcome).toBe("fail");
    expect(result.rules.find((item) => item.id === "required_count_feature_cards")?.outcome).toBe("fail");
    expect(result.summary.blockingFailures).toBeGreaterThanOrEqual(2);
  });

  it.each(["cta", "signup", "get-started"]) ("maps Call to Action to %s", (id) => {
    expect(hasRequiredSection(`<section id="${id}"><h2>Start now</h2></section>`, "Call to Action")).toBe(true);
  });

  it.each(["Hero", "Features", "Benefits", "Testimonials", "Pricing"]) ("recognizes the standard %s section", (section) => {
    expect(hasRequiredSection(`<section id="${section.toLowerCase()}"></section>`, section)).toBe(true);
  });

  it("recognizes semantic tags, element ids, and accessible section labels", () => {
    const html = `<header><h1>FocusFlow</h1></header><section id="dashboard-summary"></section><form aria-label="Task Input Form"></form><div data-section="Empty State Message"></div>`;
    expect(hasRequiredSection(html, "Header")).toBe(true);
    expect(hasRequiredSection(html, "Dashboard Summary")).toBe(true);
    expect(hasRequiredSection(html, "Task Input Form")).toBe(true);
    expect(hasRequiredSection(html, "Empty State Message")).toBe(true);
  });

  it("does not infer sections from comments, unrelated paragraphs, or unrelated ids", () => {
    const html = `<!-- <section id="cta"></section> --><p>Our call to action is clear.</p><section id="contact"></section>`;
    expect(hasRequiredSection(html, "Call to Action")).toBe(false);
    expect(hasRequiredSection(html, "Features")).toBe(false);
    const result = validateHtmlCssDeliverable({ artifacts: [{ path: "index.html", mediaType: "text/html", content: html }], requiredSections: ["Call to Action"] });
    expect(result.rules.find((item) => item.id.endsWith("call_to_action"))?.outcome).toBe("fail");
  });

  it("recognizes all explicit FocusFlow sections and valid controls", () => {
    const result = report();
    expect(result.summary.blockingFailures).toBe(0);
    expect(result.rules.find((item) => item.id.endsWith("benefits"))?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id.endsWith("testimonials"))?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "form_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "email_input_type")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "internal_fragment_links")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "semantic_navigation")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "color_contrast")?.outcome).toBe("pass");
  });

  it.each([
    ["benefits", "<section id=\"benefits\"><h2>Benefits</h2>"],
    ["testimonials", "<section id=\"testimonials\"><h2>Testimonials</h2>"],
  ])("fails when the required %s section is removed", (_name, section) => {
    const result = report([{ ...validArtifacts[0]!, content: validHtml.replace(section, "") }, validArtifacts[1]!]);
    expect(result.rules.find((item) => item.id.endsWith(_name))?.outcome).toBe("fail");
    expect(result.summary.blockingFailures).toBeGreaterThan(0);
  });

  it("fails broken fragment links and missing stylesheets", () => {
    const brokenLink = report([{ ...validArtifacts[0]!, content: validHtml.replace("#features", "#missing") }, validArtifacts[1]!]);
    expect(brokenLink.rules.find((item) => item.id === "internal_fragment_links")?.outcome).toBe("fail");
    const missingCss = report([{ ...validArtifacts[0]!, content: validHtml.replace("styles.css", "missing.css") }]);
    expect(missingCss.rules.find((item) => item.id === "local_stylesheet_references")?.outcome).toBe("fail");
  });

  it("rejects unlabeled email controls but accepts visible button text and semantic nav", () => {
    const result = report([{ ...validArtifacts[0]!, content: validHtml.replace('<label for="email">Email</label>', "") }, validArtifacts[1]!]);
    expect(result.rules.find((item) => item.id === "form_control_names")?.outcome).toBe("fail");
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "semantic_navigation")?.outcome).toBe("pass");
  });

  it("reports known, insufficient, and unknown contrast without guessing", () => {
    const insufficient = report([{ ...validArtifacts[0]! }, { ...validArtifacts[1]!, content: "footer { color: #777; background: #fff; }" }]);
    expect(insufficient.rules.find((item) => item.id === "color_contrast")?.outcome).toBe("fail");
    const unknown = report([{ ...validArtifacts[0]! }, { ...validArtifacts[1]!, content: ".theme { color: var(--foreground); background: var(--background); }" }]);
    expect(unknown.rules.find((item) => item.id === "color_contrast")?.outcome).toBe("unknown");
  });

  it("treats adaptive grid CSS as responsive evidence without requiring a media query", () => {
    const result = report([{ ...validArtifacts[0]! }, { ...validArtifacts[1]!, content: ".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }" }]);
    expect(result.rules.find((item) => item.id === "responsive_layout")?.outcome).toBe("pass");
  });

  it("does not turn unknown checks into blocking failures", () => {
    const result = validateHtmlCssDeliverable({ artifacts: [{ ...validArtifacts[0]!, content: validHtml }, { path: "styles.css", mediaType: "text/css", content: ".theme { color: var(--foreground); }" }], requiredSections: ["hero"] });
    expect(result.summary.blockingFailures).toBe(0);
    expect(result.rules.some((item) => item.outcome === "unknown")).toBe(true);
  });

  it("validates the stored FocusFlow revision 3 without changing it", () => {
    const store = JSON.parse(readFileSync(new URL("../../../apps/api/.data/executions.json", import.meta.url), "utf8")) as { executions: Array<{ executionId: string; revisions: Array<{ revision: number; artifacts: Artifact[] }> }> };
    const execution = store.executions.find((item) => item.executionId === "exec-7cf21ac5-7758-4235-bb71-0bb6bc39b061");
    const revision = execution?.revisions.find((item) => item.revision === 3);
    expect(revision).toBeDefined();
    const result = validateHtmlCssDeliverable({ artifacts: revision!.artifacts, requiredSections: ["Header", "Dashboard Summary", "Task Input Form", "Task List", "Empty State Message"], acceptanceRequirements: ["responsive CSS", "accessible HTML"] });
    expect(result.rules.filter((item) => item.id.startsWith("required_section_")).every((item) => item.outcome === "pass")).toBe(true);
    expect(result.rules.find((item) => item.id === "form_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "email_input_type")?.outcome).toBe("unknown");
    expect(result.rules.find((item) => item.id === "submit_control_names")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "internal_fragment_links")?.outcome).toBe("pass");
    expect(result.rules.find((item) => item.id === "semantic_navigation")?.outcome).toBe("unknown");
    expect(result.rules.find((item) => item.id === "color_contrast")?.outcome).toBe("pass");
  });
});
