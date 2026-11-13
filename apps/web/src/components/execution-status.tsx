import type { ExecutionLifecycle, ExecutionStatus } from "../lib/api";

export function statusLabel(status: ExecutionStatus, lifecycle: ExecutionLifecycle): string {
  if (lifecycle === "queued") return "Queued";
  if (lifecycle === "running") return status === "Created" ? "Starting" : status;
  return status;
}

export function ExecutionStatus({ status, lifecycle }: { status: ExecutionStatus; lifecycle: ExecutionLifecycle }) {
  return (
    <div className="execution-status" aria-label={`Execution status: ${statusLabel(status, lifecycle)}`}>
      <span className={`status-pip status-pip-${lifecycle === "completed" ? (status === "Failed" ? "failed" : "complete") : "running"}`} aria-hidden="true" />
      <span>{statusLabel(status, lifecycle)}</span>
      <span className="status-secondary">{lifecycle}</span>
    </div>
  );
}
