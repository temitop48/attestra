"use client";

import { useState } from "react";
import Link from "next/link";
import { ExecutionHistory } from "./execution-history";
import { ExecutionConsole } from "./execution-console";
import { DeliverableViewer } from "./deliverable-viewer";
import { ProjectForm } from "./project-form";
import { QAEvidence } from "./qa-evidence";
import { VerificationPanel } from "./verification-panel";
import type { ExecutionRecord, ExecutionSummary } from "../lib/api";
import { useNearWallet, walletStatusLabel } from "./near-wallet-provider";
import { ChainSetupPanel } from "./chain-setup-panel";
import { PaymentLifecyclePanel } from "./payment-lifecycle-panel";

export function ProjectWorkspace() {
  const wallet = useNearWallet();
  const displayedAccount = wallet.accountId ?? wallet.walletAccountId;
  const [executionId, setExecutionId] = useState<string>();
  const [liveExecutionId, setLiveExecutionId] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<ExecutionRecord>();
  const [inspectionTab, setInspectionTab] = useState<"overview" | "deliverables" | "qa" | "verification">("overview");

  function startExecution(id: string) { setLiveExecutionId(id); setExecutionId(id); setSelectedExecution(undefined); setInspectionTab("overview"); }
  function selectExecution(summary: ExecutionSummary) { setExecutionId(summary.executionId); setSelectedExecution(undefined); setInspectionTab("overview"); }

  return (
    <main className="workspace-page">
      <nav className="workspace-nav" aria-label="Workspace navigation"><Link className="brand" href="/" aria-label="ATTESTRA home">ATTESTRA<span>/</span></Link><div className="workspace-nav-links"><a className="workspace-nav-active" href="#overview">Overview</a><a href="#activity">Activity</a><a href="#deliverables">Deliverables</a><a href="#qa-evidence">QA Evidence</a><a href="#verification">Verification</a></div><div className="workspace-nav-right"><span className="wallet-status"><span className={`status-dot ${displayedAccount ? "" : "status-dot-muted"}`} /> Wallet <strong>{displayedAccount ?? walletStatusLabel(wallet.authState)}</strong><small>{wallet.authState === "authenticated" ? "Authenticated" : walletStatusLabel(wallet.authState)}</small></span>{wallet.authState === "authenticated" ? <button className="wallet-button" type="button" onClick={() => void wallet.disconnect()}>Disconnect</button> : <button className="wallet-button" type="button" onClick={() => void wallet.connect()} disabled={!wallet.ready || wallet.connecting}>{wallet.connecting ? "Connecting…" : "Connect and authenticate"}</button>}<Link className="workspace-back" href="/">Back to overview</Link></div></nav>
      <header className="workspace-header" id="overview"><div><span className="section-index">Execution workspace</span><h1>Project control room</h1></div><p>Build observable work through a bounded Research → Builder → QA run.</p></header>
      <section className="workspace-grid" aria-label="Execution workspace">
        <div className="workspace-project-column"><div className="workspace-panel-heading"><div><span className="panel-kicker">01 / project brief</span><h2>Start an execution</h2></div><span className="panel-state">Ready</span></div><ProjectForm onCreated={startExecution} /><div className="workspace-note"><span>Wallet status</span><strong>{displayedAccount ?? walletStatusLabel(wallet.authState)}</strong><small>{wallet.authState === "authenticated" ? "Backend session valid. Wallet actions are enabled." : wallet.authState === "connected" ? "Wallet connected, but NEP-413 authentication is still required." : wallet.authState === "expired" ? "The backend session expired. Reconnect and authenticate again." : wallet.authState === "failed" ? "Authentication failed. Reconnect to retry without signing transactions." : "Connect and authenticate a NEAR Testnet wallet to enable wallet actions."}</small></div><ExecutionHistory selectedId={executionId} onSelect={selectExecution} /></div>
        <div id="activity"><ExecutionConsole executionId={executionId} poll={executionId === liveExecutionId} onExecution={setSelectedExecution} /></div>
      </section>
      <ChainSetupPanel execution={selectedExecution} />
      <PaymentLifecyclePanel executionId={selectedExecution?.executionId} />
      <section className="workspace-inspection" id="deliverables" aria-label="Saved execution inspection">
        <div className="inspection-tabs" role="tablist" aria-label="Execution details"><button className={inspectionTab === "overview" ? "inspection-tab inspection-tab-active" : "inspection-tab"} type="button" role="tab" aria-selected={inspectionTab === "overview"} onClick={() => setInspectionTab("overview")}>Overview</button><button className={inspectionTab === "deliverables" ? "inspection-tab inspection-tab-active" : "inspection-tab"} type="button" role="tab" aria-selected={inspectionTab === "deliverables"} onClick={() => setInspectionTab("deliverables")}>Deliverables</button><button className={inspectionTab === "qa" ? "inspection-tab inspection-tab-active" : "inspection-tab"} type="button" role="tab" aria-selected={inspectionTab === "qa"} onClick={() => setInspectionTab("qa")}>QA Evidence</button><button className={inspectionTab === "verification" ? "inspection-tab inspection-tab-active" : "inspection-tab"} type="button" role="tab" aria-selected={inspectionTab === "verification"} onClick={() => setInspectionTab("verification")}>Verification</button></div>
        {inspectionTab === "overview" ? <section className="overview-inspection" aria-label="Execution overview"><div><span className="panel-kicker">Saved execution</span><h2>{selectedExecution ? selectedExecution.executionId : "Select a saved run"}</h2><p>{selectedExecution ? selectedExecution.requirements : "Choose a recent execution to inspect its persisted research, revisions, and status details."}</p></div><div className="overview-facts"><span><strong>Status</strong>{selectedExecution?.status ?? "Not selected"}</span><span><strong>Lifecycle</strong>{selectedExecution?.lifecycle ?? "—"}</span><span><strong>Final revision</strong>{selectedExecution?.finalDeliverable ? `Revision ${selectedExecution.finalDeliverable.revision}` : "—"}</span></div></section> : null}
        {inspectionTab === "deliverables" ? <DeliverableViewer executionId={executionId} /> : null}
        {inspectionTab === "qa" ? <div id="qa-evidence"><QAEvidence execution={selectedExecution} /></div> : null}
        <div hidden={inspectionTab !== "verification"}><VerificationPanel execution={selectedExecution} /></div>
      </section>
      <footer className="workspace-footer"><span>ATTESTRA / execution console</span><span>Proof-gated by design</span></footer>
    </main>
  );
}
