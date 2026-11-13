"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, checkHealth, getExecution, pollExecution, type ExecutionRecord } from "../lib/api";
import { ExecutionStatus } from "./execution-status";
import { ExecutionTimeline } from "./execution-timeline";

export function ExecutionConsole({ executionId, poll = true, onExecution }: { executionId?: string; poll?: boolean; onExecution?: (execution: ExecutionRecord) => void }) {
  const [execution, setExecution] = useState<ExecutionRecord>();
  const [error, setError] = useState<string>();
  const [timedOut, setTimedOut] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState<boolean>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let active = true;
    checkHealth().then(() => { if (active) setBackendAvailable(true); }).catch(() => { if (active) setBackendAvailable(false); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!executionId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(undefined);
    setTimedOut(false);
    try {
      const result = poll ? await pollExecution(executionId, { signal: controller.signal, onUpdate: (next) => { setExecution(next); onExecution?.(next); } }) : await getExecution(executionId);
      setExecution(result);
      onExecution?.(result);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (cause instanceof ApiError) setError(cause.message);
      else if (cause instanceof Error && cause.name === "PollingTimeoutError") setTimedOut(true);
      else setError(cause instanceof Error ? cause.message : "Execution status could not be loaded.");
    }
  }, [executionId, onExecution, poll]);

  useEffect(() => {
    setExecution(undefined);
    setError(undefined);
    setTimedOut(false);
    if (executionId) void refresh();
    return () => controllerRef.current?.abort();
  }, [executionId, refresh]);

  if (!executionId) {
    return <section className="console-empty" aria-labelledby="console-empty-title"><span className="section-index">02 / execution</span><h2 id="console-empty-title">Your execution will appear here.</h2><p>Start a project to watch the Research, Builder, and QA agents work through the brief.</p></section>;
  }

  return (
    <section className={`execution-console ${execution ? `execution-${execution.lifecycle}` : "execution-loading"}`} aria-labelledby="execution-console-title" aria-live="polite">
      <div className="console-header"><div><span className="section-index">02 / live activity</span><h2 id="execution-console-title">Run monitor</h2></div>{execution ? <ExecutionStatus status={execution.status} lifecycle={execution.lifecycle} /> : <span className="status-secondary status-loading">Loading status<span className="loading-dots" aria-hidden="true">…</span></span>}</div>
      <div className="execution-id"><span>Execution ID</span><code>{executionId}</code></div>
      {backendAvailable === false ? <p className="inline-warning" role="status">Backend unavailable. Status updates may not arrive.</p> : null}
      {error ? <div className="console-error" role="alert"><strong>Could not load execution</strong><p>{error}</p><button type="button" className="text-action" onClick={() => void refresh()}>Retry status fetch</button></div> : null}
      {timedOut ? <div className="console-error" role="alert"><strong>Status polling timed out</strong><p>The execution may still be running. Fetch its status again when the backend is available.</p><button type="button" className="text-action" onClick={() => void refresh()}>Resume polling</button></div> : null}
      {execution ? <>
        <ExecutionTimeline steps={execution.steps} />
        {execution.status === "AwaitingIndependentVerification" ? <p className="completion-note">Agent execution complete. Awaiting independent verification.</p> : null}
        {execution.status === "Failed" && execution.failure ? <div className="failure-detail"><span className="section-index">Execution failure</span><strong>{execution.failure.code}</strong><p>{execution.failure.message}</p></div> : null}
      </> : <div className="timeline-loading" aria-live="polite"><span className="loading-bar" aria-hidden="true" />Connecting to the execution record…</div>}
    </section>
  );
}
