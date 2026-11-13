"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, listExecutions, type ExecutionSummary } from "../lib/api";

export function formatExecutionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function ExecutionHistory({ selectedId, onSelect }: { selectedId?: string; onSelect: (execution: ExecutionSummary) => void }) {
  const [items, setItems] = useState<ExecutionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await listExecutions(0, 20);
      setItems(response.items);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Execution history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section className="history-section" aria-labelledby="history-title">
      <div className="history-heading"><div><span className="panel-kicker">03 / saved runs</span><h2 id="history-title">Recent executions</h2></div><button className="text-action" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      {error ? <div className="inline-error" role="alert"><p>{error}</p><button className="text-action" type="button" onClick={() => void refresh()}>Try again</button></div> : null}
      {!error && loading && items.length === 0 ? <p className="history-empty" role="status">Loading saved runs…</p> : null}
      {!error && !loading && items.length === 0 ? <p className="history-empty">No saved executions yet. Start a brief above to create the first run.</p> : null}
      {items.length > 0 ? <ul className="history-list">{items.map((item) => <li key={item.executionId}><button className={`history-row ${selectedId === item.executionId ? "history-row-selected" : ""}`} type="button" onClick={() => onSelect(item)}><span className={`history-state history-state-${item.status === "Failed" ? "failed" : item.lifecycle}`} aria-hidden="true" /><span className="history-main"><strong>{item.projectId ? `Project ${item.projectId}` : "Unassigned project"}</strong><code>{item.executionId}</code></span><span className="history-status"><strong>{item.status}</strong><small>{item.lifecycle} · {formatExecutionDate(item.updatedAt)}</small></span><span className="history-arrow" aria-hidden="true">→</span></button></li>)}</ul> : null}
    </section>
  );
}
