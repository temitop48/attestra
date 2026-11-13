# ATTESTRA Independent Verification Architecture

Phase 2C adds an independent, off-chain verification engine. It accepts a completed orchestrator `DeliverableManifest`, recalculates its digest using the shared `computeArtifactDigest` implementation, runs bounded deterministic checks, and optionally performs a separate LLM review.

## Verification boundary

The verifier receives project and milestone identifiers, the final artifact manifest, its expected digest, and explicit acceptance criteria. It does not execute generated JavaScript, access the filesystem, access wallets, call NEAR, or treat internal QA output as evidence. Static inspection cannot prove the absence of all malicious behavior.

## Canonical artifact integrity

The orchestrator and verifier use `attestra-artifacts-v2`: JSON with fixed property order `{format, artifacts}`, sorted artifacts, and fixed artifact property order `{path, mediaType, content}`. JSON escaping prevents delimiter ambiguity for newlines and quotes. Timestamps, random IDs, execution metadata, and provider metadata are never hashed. Legacy v1 delimiter manifests are rejected.

## Deterministic policy checks

The versioned `verification-policy-v1` policy checks required `index.html` and `styles.css`, safe unique relative paths, supported media types, per-file and total-size limits, basic HTML structure, local stylesheet linkage, required sections, basic accessibility, remote scripts/resources, unsafe inline script patterns, and acceptance-criteria coverage. The reusable `html-validation-v1` report used before internal QA adds evidence-bearing checks for fragment targets, supported form names, semantic navigation, direct WCAG contrast calculations, and conservative responsive-layout evidence. Mandatory failures always produce `Failed`; unknown static checks do not.

## Optional independent LLM review

LLM review is disabled by default, and the receipt records deterministic-only operation. When enabled, the verifier uses the existing provider abstraction with a separate verifier prompt, bounded duration, structured JSON validation, and provider metadata. Artifact text is explicitly untrusted data and is not treated as instructions. Optional provider failure is recorded as skipped; required provider failure fails closed. An LLM pass cannot override a deterministic failure.

## Receipt and NEAR compatibility

Receipts contain a bounded unique receipt ID, decimal project/milestone IDs, the recalculated SHA-256 digest, `Passed`/`Failed`, check results, ISO timestamp, policy version, and verifier metadata. The mapping helper produces the future Rust call shape:

`submit_verification(project_id: u64, milestone_id: u64, deliverable_digest: String, receipt_id: String, result: VerificationResult)`

The contract bounds receipt IDs to 128 bytes and digests to 256 bytes; the TypeScript helper also rejects IDs beyond the JavaScript safe integer range. The receipt is an off-chain attestation submitted later by the authorized verifier account. It is not cryptographic proof that the deliverable is correct.

## Security and testing

Inputs, criteria, receipt IDs, paths, media types, and artifact sizes are bounded. No generated code is executed. Tests cover valid and invalid artifacts, digest mismatch, path traversal, duplicate paths, media and size limits, HTML/accessibility/resource checks, LLM failure behavior, prompt-injection-as-data handling, receipt mapping, canonicalization ambiguity, and the absence of blockchain settlement.

## Limitations

Receipt uniqueness is process-local until the future NEAR contract submission. Static checks are conservative but incomplete. Optional LLM review is not cryptographic proof and can be unavailable or incorrect. Real Testnet submission and independent verifier key management are future integration work.
