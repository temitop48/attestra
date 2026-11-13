"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getChainLinkage, getVerification, requestVerification, type ExecutionRecord, type VerificationReceipt, type VerificationState } from "../lib/api";

type Eligibility = { eligible: boolean; reasons: string[] };
type ReverificationButtonState = { eligibility: Eligibility; chainReady: boolean; requesting: boolean; loading: boolean; status: VerificationState["status"]; reason: string; localWritesEnabled: boolean };

export function verificationEligibility(execution?: ExecutionRecord): Eligibility {
  const reasons: string[] = [];
  if (!execution) return { eligible: false, reasons: ["Select an execution first."] };
  if (execution.lifecycle !== "completed" || execution.status !== "AwaitingIndependentVerification") reasons.push("Agent execution is not complete.");
  const final = execution.finalDeliverable;
  if (!final || final.totalBytes <= 0) reasons.push("A final deliverable is not available.");
  if (final) {
    const qa = (execution.qaAssessments ?? []).filter((assessment) => assessment.revision === final.revision && assessment.digest === final.digest).sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
    if (!qa?.passed) reasons.push("The final revision has not received QA approval.");
    const reports = (execution.validationReports ?? []).filter((report) => report.revision === final.revision && report.artifactDigest === final.digest);
    if (reports.some((report) => report.summary.blockingFailures > 0 || report.rules.some((rule) => rule.blocking && rule.outcome === "fail"))) reasons.push("Blocking deterministic validation failures remain.");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function verificationStatusLabel(status: VerificationState["status"]): string {
  return { not_requested: "Not requested", in_progress: "In progress", verified: "Verified", rejected: "Rejected", error: "Verification error" }[status];
}

export function reverificationDisabledReasons(state: ReverificationButtonState): string[] {
  const reasons = [...state.eligibility.reasons];
  if (!state.chainReady) reasons.push("Confirmed on-chain project and milestone linkage is required.");
  if (state.requesting) reasons.push("A verification request is already being submitted.");
  if (state.loading) reasons.push("Verification status is still loading.");
  if (state.status === "in_progress") reasons.push("Verification is already in progress.");
  if (!state.reason.trim()) reasons.push("Enter an explicit reason before requesting re-verification.");
  if (!state.localWritesEnabled) reasons.push("Verification writes are disabled in this browser environment.");
  return [...new Set(reasons)];
}

export function VerificationReceiptView({ receipt }: { receipt: VerificationReceipt }) {
  return <div className="receipt-view"><div className="receipt-summary"><span className={receipt.result === "Passed" ? "decision decision-pass" : "decision decision-fail"}>{receipt.result === "Passed" ? "Verified" : "Rejected"}</span><strong>{receipt.receiptId}</strong></div><dl className="receipt-facts"><div><dt>Execution</dt><dd>{receipt.projectId}</dd></div><div><dt>Artifact digest</dt><dd><code>{receipt.artifactDigest}</code></dd></div><div><dt>Policy</dt><dd>{receipt.policyVersion}</dd></div><div><dt>Verifier</dt><dd>{receipt.verifier.implementationVersion ?? "Unknown (legacy)"}</dd></div><div><dt>Timestamp</dt><dd>{receipt.timestamp}</dd></div></dl><details className="receipt-checks"><summary>Verification checks ({receipt.checks.length})</summary><ul>{receipt.checks.map((check) => <li key={check.id}><div><strong>{check.name}</strong><span className={`check-${check.status}`}>{check.status}</span></div><p>{check.message}</p>{check.evidence ? <small>{check.evidence}</small> : null}</li>)}</ul></details>{receipt.failure ? <p className="verification-failure"><strong>{receipt.failure.code}</strong>{receipt.failure.message}</p> : null}</div>;
}

export function VerificationPanel({ execution }: { execution?: ExecutionRecord }) {
  const [state, setState] = useState<VerificationState>();
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [chainReady, setChainReady] = useState(true);
  const requestController = useRef<AbortController | undefined>(undefined);
  const eligibility = useMemo(() => verificationEligibility(execution), [execution]);
  // Verification authorization is enforced by the authenticated backend session;
  // no privileged operator token is ever exposed to this browser bundle.
  const localWritesEnabled = true;

  useEffect(() => {
    const controller = new AbortController();
    setState(undefined); setError(undefined); setLoading(false); setRequesting(false); setReason(""); setChainReady(!execution?.paymentEligible);
    if (!execution?.executionId) return () => controller.abort();
    setLoading(true);
    Promise.all([getVerification(execution.executionId, controller.signal), execution.paymentEligible ? getChainLinkage(execution.executionId) : Promise.resolve({ confirmed: true })]).then(([verification, chain]) => { setState(verification); setChainReady(chain.confirmed); }).catch((cause) => { if (cause instanceof DOMException && cause.name === "AbortError") return; setError(cause instanceof ApiError ? cause.message : "Verification status could not be loaded."); }).finally(() => setLoading(false));
    const linkageRefresh = execution.paymentEligible ? window.setInterval(() => { void getChainLinkage(execution.executionId).then((response) => { if (!controller.signal.aborted) setChainReady(response.confirmed); }).catch(() => undefined); }, 2000) : undefined;
    return () => { controller.abort(); if (linkageRefresh !== undefined) window.clearInterval(linkageRefresh); requestController.current?.abort(); };
  }, [execution?.executionId, execution?.paymentEligible]);

  async function refresh() {
    if (!execution?.executionId || loading) return;
    setLoading(true); setError(undefined);
    try { setState(await getVerification(execution.executionId)); } catch (cause) { setError(cause instanceof ApiError ? cause.message : "Verification status could not be loaded."); } finally { setLoading(false); }
  }

  async function request() {
    const isReverification = Boolean(state?.latestAttempt ?? state?.receipt);
    if (!execution?.executionId || !eligibility.eligible || (execution.paymentEligible && !chainReady) || requesting || state?.status === "in_progress" || !localWritesEnabled) return;
    if (isReverification && (!state?.reverification?.available || !reason.trim() || !window.confirm("Request a new independent verification attempt using this reason?"))) return;
    requestController.current?.abort(); const controller = new AbortController(); requestController.current = controller; setRequesting(true); setError(undefined); setState((previous) => ({ ...(previous ?? { history: [] }), status: "in_progress", executionId: execution.executionId }));
    try { await requestVerification(execution.executionId, { reason: isReverification ? reason.trim() : undefined, signal: controller.signal }); setState(await getVerification(execution.executionId, controller.signal)); setReason(""); } catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof ApiError ? cause.message : "Independent verification could not be requested."); } finally { setRequesting(false); }
  }

  const status = state?.status ?? "not_requested";
  const isReverificationAvailable = Boolean(state?.reverification?.available);
  const hasAttempt = Boolean(state?.latestAttempt ?? state?.receipt);
  const reverificationReasons = reverificationDisabledReasons({ eligibility, chainReady, requesting, loading, status, reason, localWritesEnabled });
  return <section className="verification-panel" id="verification" aria-labelledby="verification-title"><div className="inspection-heading"><div><span className="panel-kicker">Independent verification</span><h2 id="verification-title">Verification control</h2></div><div className="verification-heading-actions"><span className={`verification-status verification-status-${status}`}>{verificationStatusLabel(status)}</span><button className="text-action" type="button" onClick={() => void refresh()} disabled={!execution || loading}>Refresh</button></div></div>{!execution ? <p className="inspection-empty">Select an execution to load its verification state.</p> : <><div className="verification-action-row"><div><strong>{eligibility.eligible && chainReady ? "Ready for an explicit verification request." : "Verification is currently unavailable."}</strong>{eligibility.reasons.length > 0 ? <ul className="eligibility-reasons">{eligibility.reasons.map((item) => <li key={item}>{item}</li>)}</ul> : null}{execution.paymentEligible && !chainReady ? <p className="verification-notice">Attach confirmed on-chain project and milestone state before requesting payment-backed verification.</p> : null}{eligibility.reasons.length === 0 && (!execution.paymentEligible || chainReady) ? <p>Backend eligibility checks remain authoritative.</p> : null}</div>{!hasAttempt ? <button className="primary-action verification-action" type="button" onClick={() => void request()} disabled={!eligibility.eligible || (execution.paymentEligible && !chainReady) || requesting || loading || status === "in_progress" || !localWritesEnabled}>{requesting ? "Requesting…" : "Request independent verification"}</button> : null}</div>{hasAttempt && isReverificationAvailable ? <div className="reverification-form"><label htmlFor="reverification-reason">Reason for re-verification</label><textarea id="reverification-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Describe the legitimate verifier or policy change." /><button className="primary-action verification-action" type="button" onClick={() => void request()} disabled={!eligibility.eligible || (execution.paymentEligible && !chainReady) || requesting || loading || status === "in_progress" || !reason.trim() || !localWritesEnabled}>{requesting ? "Requesting…" : "Request re-verification"}</button>{reverificationReasons.length > 0 ? <ul className="eligibility-reasons" aria-live="polite">{reverificationReasons.map((item) => <li key={item}>{item}</li>)}</ul> : null}</div> : null}{hasAttempt && !isReverificationAvailable ? <p className="verification-notice">{state?.reverification?.reason ?? "A new verifier or policy version is required before another attempt."}</p> : null}{!localWritesEnabled ? <p className="verification-notice">Verification writes are disabled in this production browser. No privileged token is exposed to the client.</p> : null}{error ? <div className="inline-error" role="alert"><p>{error}</p><button className="text-action" type="button" onClick={() => void refresh()}>Refresh status</button></div> : null}{loading ? <p className="inspection-empty" role="status">Loading verification state…</p> : null}{state?.status === "error" && state.failure ? <p className="verification-failure"><strong>{state.failure.code}</strong>{state.failure.message}</p> : null}{state?.receipt ? <VerificationReceiptView receipt={state.receipt} /> : null}{state?.history?.length ? <details className="verification-history"><summary>Verification history ({state.history.length})</summary><ol>{state.history.slice().reverse().map((attempt) => <li key={attempt.attemptId}><strong>{attempt.status === "verified" && attempt.result === "Passed" ? "Passed" : attempt.result === "Failed" ? "Rejected" : attempt.status}</strong><span>{attempt.requestedAt}</span><code>{attempt.artifactDigest}</code>{attempt.reVerificationReason ? <p>{attempt.reVerificationReason}</p> : null}</li>)}</ol></details> : null}<p className="payment-disclaimer">QA approval, independent verification, and payment release are separate states. NEAR payment settlement is not performed here.</p></>}</section>;
}
