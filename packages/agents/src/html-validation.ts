import type { Artifact } from "./index.js";

export type DeterministicOutcome = "pass" | "fail" | "unknown";
export type DeterministicSeverity = "low" | "medium" | "high";

export type DeterministicValidationRule = {
  id: string;
  outcome: DeterministicOutcome;
  severity: DeterministicSeverity;
  blocking: boolean;
  message: string;
  evidence: string;
  path?: string;
};

export type DeterministicValidationReport = {
  version: "html-validation-v1";
  rules: DeterministicValidationRule[];
  summary: { passed: number; failed: number; unknown: number; blockingFailures: number };
};

export type DeterministicValidationInput = {
  artifacts: readonly Artifact[];
  requiredSections?: readonly string[];
  acceptanceRequirements?: readonly string[];
  research?: { sections?: readonly string[]; implementationRequirements?: readonly string[] };
};

type HtmlElement = { tag: string; attrs: Record<string, string>; content: string; text: string };
type CssRule = { selector: string; declarations: Record<string, string> };

const sectionAliases: Record<string, string[]> = {
  hero: ["hero", "banner", "masthead"],
  features: ["features", "feature"],
  benefits: ["benefits", "benefit", "why"],
  testimonials: ["testimonials", "testimonial", "reviews", "trusted"],
  pricing: ["pricing", "plans", "price"],
  "call to action": ["call-to-action", "call to action", "cta", "signup", "sign-up", "get-started"],
  cta: ["call-to-action", "call to action", "cta", "signup", "sign-up", "get-started"],
};

const numberWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function attrMap(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function stripMarkup(value: string): string {
  return value.replace(/<!--([\s\S]*?)-->/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function elements(html: string, tag: string): HtmlElement[] {
  const result: HtmlElement[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  for (const match of html.matchAll(pattern)) {
    result.push({ tag, attrs: attrMap(match[1] ?? ""), content: match[2] ?? "", text: stripMarkup(match[2] ?? "") });
  }
  return result;
}

function selfClosingElements(html: string, tag: string): HtmlElement[] {
  const result: HtmlElement[] = [];
  const pattern = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  for (const match of html.matchAll(pattern)) result.push({ tag, attrs: attrMap(match[1] ?? ""), content: "", text: "" });
  return result;
}

function rule(id: string, outcome: DeterministicOutcome, severity: DeterministicSeverity, blocking: boolean, message: string, evidence: string, path?: string): DeterministicValidationRule {
  return { id, outcome, severity, blocking, message, evidence, ...(path ? { path } : {}) };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripHtmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, " ");
}

function identityMatchesAlias(identity: string, alias: string): boolean {
  const value = normalized(identity);
  const candidate = normalized(alias);
  return Boolean(value && candidate && (value === candidate || ` ${value} `.includes(` ${candidate} `)));
}

function requiredCardCount(requirement: string): { count: number; label: string } | undefined {
  const match = normalized(requirement).match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][a-z ]*?)\s+cards?\b/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  const count = Number.isNaN(parsed) ? (numberWords[match[1]!] ?? 0) : parsed;
  const label = match[2]!.trim();
  return Number.isSafeInteger(count) && count > 0 && count <= 32 ? { count, label } : undefined;
}

function countMatchingCards(html: string, label: string): number {
  const wanted = normalized(label);
  let count = 0;
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
    const attrs = attrMap(match[2] ?? "");
    const identity = [attrs.id, attrs.class, attrs["data-section"], attrs["aria-label"]].filter(Boolean).join(" ");
    const value = normalized(identity);
    if (value.includes("card") && !value.includes("cards") && (value.includes(wanted) || (wanted.endsWith("s") && value.includes(wanted.slice(0, -1))))) count += 1;
  }
  return count;
}

export function hasRequiredCardQuantity(html: string, requirement: string): boolean | undefined {
  const requested = requiredCardCount(requirement);
  return requested ? countMatchingCards(html, requested.label) >= requested.count : undefined;
}

function quantityRule(requirement: string, html: string): DeterministicValidationRule | undefined {
  const requested = requiredCardCount(requirement);
  if (!requested) return undefined;
  const actual = countMatchingCards(html, requested.label);
  const label = normalized(`${requested.label} cards`);
  return rule(`required_count_${label.replace(/[^a-z0-9]+/g, "_")}`, actual >= requested.count ? "pass" : "fail", "high", actual < requested.count, actual >= requested.count ? `Required quantity met: ${actual} ${label}` : `Required quantity not met: found ${actual} ${label}, require ${requested.count}`, `Requirement: ${requirement}; detected: ${actual}`, "index.html");
}

function findArtifact(artifacts: readonly Artifact[], path: string): Artifact | undefined {
  return artifacts.find((artifact) => artifact.path === path);
}

export function hasRequiredSection(html: string, requirement: string): boolean | undefined {
  const requested = normalized(requirement);
  if (!requested) return undefined;
  const aliases = sectionAliases[requested] ?? [requested];
  const source = stripHtmlComments(html);
  const matched = [...source.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)].some((match) => {
    const element = attrMap(match[2] ?? "");
    // A requirement may be represented by a semantic element (`<header>`),
    // an id/class, or an explicit accessible/data label. Never infer a
    // section from arbitrary visible prose.
    const identities = [match[1], element.id, element.class, element["data-section"], element["aria-label"]].filter(Boolean);
    return identities.some((identity) => aliases.some((alias) => identityMatchesAlias(identity!, alias)));
  });
  return matched;
}

function idsIn(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) ids.add(match[1]!);
  return ids;
}

function linksHaveTargets(html: string): { passed: boolean; evidence: string } {
  const ids = idsIn(html);
  const broken: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["'][^>]*>/gi)) {
    if (!ids.has(match[1]!)) broken.push(`#${match[1]}`);
  }
  return broken.length === 0
    ? { passed: true, evidence: `All ${[...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']#[^"']+["'][^>]*>/gi)].length} fragment links resolve to an id` }
    : { passed: false, evidence: `Missing fragment targets: ${broken.slice(0, 8).join(", ")}` };
}

function accessibleName(element: HtmlElement, html: string): string {
  if (element.attrs["aria-label"]?.trim()) return element.attrs["aria-label"]!.trim();
  if (element.attrs["aria-labelledby"]?.trim()) {
    const labels = element.attrs["aria-labelledby"]!.split(/\s+/).map((id) => new RegExp(`<[^>]+\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["'])[^>]*>[\\s\\S]*?<\\/[^>]+>`, "i").exec(html)?.[0] ?? "");
    const text = stripMarkup(labels.join(" "));
    if (text) return text;
  }
  if (element.attrs.title?.trim()) return element.attrs.title!.trim();
  return element.text.trim();
}

function formChecks(html: string): DeterministicValidationRule[] {
  const inputs = selfClosingElements(html, "input");
  const labels = elements(html, "label");
  const labelFor = new Set(labels.map((label) => label.attrs.for).filter(Boolean));
  const unlabeled = inputs.filter((input) => {
    const hasLabel = Boolean(input.attrs.id && labelFor.has(input.attrs.id));
    return !hasLabel && !input.attrs["aria-label"]?.trim() && !input.attrs["aria-labelledby"]?.trim() && !input.attrs.title?.trim();
  });
  const submitControls = [
    ...elements(html, "button"),
    ...inputs.filter((input) => ["submit", "button", "image"].includes((input.attrs.type ?? "submit").toLowerCase())),
  ];
  const unnamedSubmit = submitControls.filter((control) => !accessibleName(control, html));
  const unnamedLinks = elements(html, "a").filter((link) => !accessibleName(link, html));
  const emailInputs = inputs.filter((input) => (input.attrs.type ?? "").toLowerCase() === "email");
  const emailRequirement = /\bemail\b/i.test(html);
  return [
    rule("form_control_names", unlabeled.length ? "fail" : "pass", "high", unlabeled.length > 0, unlabeled.length ? `${unlabeled.length} form control(s) lack a supported accessible name` : "All form controls have a label or supported accessible name", "Supported labels, aria-label, aria-labelledby, and title attributes were checked", "index.html"),
    rule("submit_control_names", unnamedSubmit.length ? "fail" : "pass", "high", unnamedSubmit.length > 0, unnamedSubmit.length ? `${unnamedSubmit.length} submit control(s) lack an accessible name` : "Submit controls have visible or programmatic names", "Visible text and supported naming attributes were checked", "index.html"),
    rule("link_names", unnamedLinks.length ? "fail" : "pass", "high", unnamedLinks.length > 0, unnamedLinks.length ? `${unnamedLinks.length} link(s) lack an accessible name` : "Links have visible or programmatic names", "Visible text and supported naming attributes were checked", "index.html"),
    rule("email_input_type", emailRequirement ? (emailInputs.length ? "pass" : "fail") : "unknown", "medium", emailRequirement, emailInputs.length ? "Email input uses type=email" : "An email-related requirement is present but no type=email control was found", emailRequirement ? "Email-related markup was detected" : "No explicit email requirement was detected", "index.html"),
  ];
}

function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Record<string, string> = {};
    for (const declaration of (match[2] ?? "").split(";")) {
      const separator = declaration.indexOf(":");
      if (separator > 0) declarations[declaration.slice(0, separator).trim().toLowerCase()] = declaration.slice(separator + 1).trim();
    }
    rules.push({ selector: (match[1] ?? "").trim(), declarations });
  }
  return rules;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Returns true only for bounded, inspectable responsive CSS evidence. It does
 * not attempt to prove browser-level responsiveness or infer inherited styles.
 */
export function hasResponsiveCssEvidence(css: string): boolean {
  const source = stripCssComments(css);
  const mediaBodies = [...source.matchAll(/(?:^|})\s*@media\s*[^{}]+\{([\s\S]*?)\}/gi)].map((match) => match[1] ?? "");
  if (mediaBodies.some((body) => /[{;]\s*[a-z-]+\s*:/i.test(body))) return true;
  return cssRules(source).some(({ declarations }) => {
    const display = declarations.display?.replace(/\s+/g, "").toLowerCase();
    const adaptiveGrid = display === "grid" && /repeat\s*\(\s*(?:auto-fit|auto-fill)\s*,\s*minmax\s*\(/i.test(declarations["grid-template-columns"] ?? "");
    const wrappingFlex = display === "flex" && (/(?:^|\s)wrap(?:-reverse)?(?:\s|$)/i.test(declarations["flex-wrap"] ?? "") || /(?:^|\s)wrap(?:\s|$)/i.test(declarations["flex-flow"] ?? ""));
    return adaptiveGrid || wrappingFlex;
  });
}

function parseColor(value: string): [number, number, number] | undefined {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.split("").map((digit) => digit + digit).join("") : hex[1]!;
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  const rgb = value.trim().match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => { const normalizedValue = value / 255; return normalizedValue <= 0.03928 ? normalizedValue / 12.92 : ((normalizedValue + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function contrastCheck(css: string): DeterministicValidationRule {
  const pairs: { selector: string; ratio: number; foreground: string; background: string }[] = [];
  for (const item of cssRules(css)) {
    const foreground = item.declarations.color ? parseColor(item.declarations.color) : undefined;
    const background = parseColor(item.declarations["background-color"] ?? item.declarations.background ?? "");
    if (foreground && background) pairs.push({ selector: item.selector, ratio: contrastRatio(foreground, background), foreground: item.declarations.color!, background: item.declarations["background-color"] ?? item.declarations.background! });
  }
  if (!pairs.length) return rule("color_contrast", "unknown", "medium", false, "Contrast could not be established from direct color declarations", "No selector contained reliably parseable foreground and background colors", "styles.css");
  const failed = pairs.filter((pair) => pair.ratio < 4.5);
  const evidence = pairs.slice(0, 8).map((pair) => `${pair.selector}: ${pair.foreground}/${pair.background} = ${pair.ratio.toFixed(2)}:1`).join("; ");
  return rule("color_contrast", failed.length ? "fail" : "pass", failed.length ? "high" : "low", failed.length > 0, failed.length ? "A directly specified color pair is below the WCAG AA normal-text threshold" : "Directly specified color pairs meet the WCAG AA normal-text threshold", evidence, "styles.css");
}

function acceptanceRule(requirement: string, html: string, css: string, requiredSections: readonly string[]): DeterministicValidationRule {
  const text = normalized(requirement);
  const section = requiredSections.find((item) => normalized(item) === text);
  if (section) {
    const present = hasRequiredSection(html, section);
    return rule(`acceptance_${text.replace(/[^a-z0-9]+/g, "_")}`, present === true ? "pass" : present === false ? "fail" : "unknown", "high", present === false, present === true ? `Required section '${section}' was found` : `Required section '${section}' was not found`, `Requirement: ${requirement}`, "index.html");
  }
  if (/responsive|mobile/i.test(text)) return rule("acceptance_responsive", hasResponsiveCssEvidence(css) ? "pass" : "unknown", "medium", false, "Responsive behavior was checked only using detectable CSS patterns", hasResponsiveCssEvidence(css) ? "Media query, adaptive grid, or wrapping flex pattern found" : "Static analysis cannot establish complete mobile behavior", "styles.css");
  if (/accessible|accessibility|semantic html/i.test(text)) return rule("acceptance_accessibility", /<html\b[^>]*\blang\s*=|<nav\b/i.test(html) ? "pass" : "unknown", "high", false, "Basic semantic/accessibility evidence was inspected", "Language or semantic navigation markup was found", "index.html");
  if (/remote|external resource|self-contained/i.test(text)) {
    const remote = /(?:https?:)?\/\//i.test(`${html}\n${css}`) || /@import\s+/i.test(css);
    return rule("acceptance_external_resources", remote ? "fail" : "pass", "high", remote, remote ? "Remote or external resource references were found" : "No remote or external resource references were found", remote ? "A URL or @import reference was detected" : "No URL or @import reference detected");
  }
  return rule(`acceptance_${text.replace(/[^a-z0-9]+/g, "_").slice(0, 48)}`, "unknown", "low", false, "This acceptance requirement needs context beyond deterministic static analysis", `Requirement: ${requirement}`);
}

export function validateHtmlCssDeliverable(input: DeterministicValidationInput): DeterministicValidationReport {
  const artifacts = input.artifacts;
  const htmlArtifact = findArtifact(artifacts, "index.html");
  const cssArtifact = findArtifact(artifacts, "styles.css");
  const html = htmlArtifact?.content ?? "";
  const css = cssArtifact?.content ?? "";
  const requiredSections = [...new Set([...(input.requiredSections ?? []), ...(input.research?.sections ?? [])])];
  const acceptanceRequirements = [...new Set([...(input.acceptanceRequirements ?? []), ...(input.research?.implementationRequirements ?? [])])];
  const rules: DeterministicValidationRule[] = [];

  rules.push(rule("required_index_html", htmlArtifact ? "pass" : "fail", "high", !htmlArtifact, htmlArtifact ? "index.html is present" : "index.html is missing", `Paths: ${artifacts.map((artifact) => artifact.path).join(", ") || "none"}`, "index.html"));
  rules.push(rule("required_styles_css", cssArtifact ? "pass" : "fail", "high", !cssArtifact, cssArtifact ? "styles.css is present" : "styles.css is missing", `Paths: ${artifacts.map((artifact) => artifact.path).join(", ") || "none"}`, "styles.css"));

  for (const section of requiredSections) {
    const present = hasRequiredSection(html, section);
    rules.push(rule(`required_section_${normalized(section).replace(/[^a-z0-9]+/g, "_")}`, present === true ? "pass" : present === false ? "fail" : "unknown", "high", present === false, present === true ? `Required section '${section}' was found` : `Required section '${section}' was not found`, `Requirement: ${section}`, "index.html"));
  }

  for (const requirement of [...new Set([...requiredSections, ...acceptanceRequirements])]) {
    const quantity = quantityRule(requirement, html);
    if (quantity) rules.push(quantity);
  }

  const fragment = linksHaveTargets(html);
  rules.push(rule("internal_fragment_links", fragment.passed ? "pass" : "fail", "high", !fragment.passed, fragment.passed ? "All internal fragment links resolve" : "One or more internal fragment links are broken", fragment.evidence, "index.html"));
  rules.push(...formChecks(html));
  const nav = /<nav\b/i.test(html);
  rules.push(rule("semantic_navigation", nav ? "pass" : "unknown", "low", false, nav ? "Semantic <nav> markup is present; redundant ARIA is not required" : "No navigation landmark was found, but static analysis cannot infer whether navigation was required", nav ? "<nav> element found" : "No <nav> element found", "index.html"));

  if (htmlArtifact) {
    const localStylesheets = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*>/gi)].map((match) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[0] ?? "")?.[1]).filter((href): href is string => {
      if (!href) return false;
      return !/^(?:https?:|\/\/|data:)/i.test(href);
    });
    const missing = localStylesheets.filter((href) => !findArtifact(artifacts, href));
    rules.push(rule("local_stylesheet_references", missing.length ? "fail" : "pass", "high", missing.length > 0, missing.length ? "A local stylesheet reference has no matching artifact" : "All local stylesheet references resolve to artifacts", missing.length ? `Missing: ${missing.join(", ")}` : `Resolved: ${localStylesheets.join(", ") || "none"}`, "index.html"));
  } else rules.push(rule("local_stylesheet_references", "unknown", "high", false, "Stylesheet references cannot be checked without index.html", "index.html is missing", "index.html"));

  if (cssArtifact) {
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    rules.push(rule("css_syntax", open === close ? "pass" : "fail", "medium", open !== close, open === close ? "CSS braces are balanced" : "CSS braces are unbalanced", `${open} opening braces, ${close} closing braces`, "styles.css"));
    rules.push(contrastCheck(css));
    const responsivePattern = hasResponsiveCssEvidence(css);
    rules.push(rule("responsive_layout", responsivePattern ? "pass" : "unknown", "medium", false, responsivePattern ? "Responsive CSS pattern detected" : "Static analysis cannot establish responsive behavior without a detectable adaptive pattern", responsivePattern ? "Media query, adaptive grid, or wrapping flex pattern found" : "No reliable responsive pattern found; this is not treated as an automatic failure", "styles.css"));
  } else {
    rules.push(rule("css_syntax", "unknown", "medium", false, "CSS syntax cannot be checked without styles.css", "styles.css is missing", "styles.css"));
    rules.push(rule("color_contrast", "unknown", "medium", false, "Contrast cannot be checked without styles.css", "styles.css is missing", "styles.css"));
    rules.push(rule("responsive_layout", "unknown", "medium", false, "Responsive behavior cannot be checked without styles.css", "styles.css is missing", "styles.css"));
  }

  const remote = /(?:https?:)?\/\//i.test(`${html}\n${css}`) || /@import\s+/i.test(css);
  rules.push(rule("remote_resources", remote ? "fail" : "pass", "high", remote, remote ? "Remote resource references were found" : "No remote resource references were found", remote ? "A URL or @import reference was detected" : "No URL or @import reference detected"));
  for (const requirement of acceptanceRequirements) rules.push(acceptanceRule(requirement, html, css, requiredSections));

  const blockingFailures = rules.filter((item) => item.outcome === "fail" && item.blocking).length;
  return {
    version: "html-validation-v1",
    rules,
    summary: {
      passed: rules.filter((item) => item.outcome === "pass").length,
      failed: rules.filter((item) => item.outcome === "fail").length,
      unknown: rules.filter((item) => item.outcome === "unknown").length,
      blockingFailures,
    },
  };
}
