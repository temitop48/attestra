import type { ExecutionStep } from "../lib/api";

const labels = { research: "Research", builder: "Builder", qa: "QA" } as const;

export function timelineStepText(step: ExecutionStep | undefined): string {
  if (!step) return "Waiting for assignment";
  if (step.status === "failed") return step.error?.message ?? "Agent failed";
  if (step.status === "succeeded") return "Completed";
  if (step.status === "running") return "Working";
  return "Waiting for assignment";
}

export function ExecutionTimeline({ steps }: { steps: ExecutionStep[] }) {
  return (
    <ol className="execution-timeline" aria-label="Agent execution progress">
      {(["research", "builder", "qa"] as const).map((kind) => {
        const attempts = steps.filter((step) => step.kind === kind);
        const latest = attempts.at(-1);
        return (
          <li className={`timeline-row timeline-${latest?.status ?? "pending"}`} key={kind}>
            <span className="timeline-marker" aria-hidden="true">{latest?.status === "succeeded" ? "✓" : latest?.status === "failed" ? "!" : ""}</span>
            {kind !== "qa" ? <span className="timeline-connector" aria-hidden="true" /> : null}
            <div className="timeline-copy">
              <div className="timeline-heading"><strong>{labels[kind]}</strong><span>{latest ? `attempt ${latest.attempt}` : "waiting"}</span></div>
              <p>{timelineStepText(latest)}</p>
              {attempts.length > 1 ? <ul className="timeline-attempts" aria-label={`${labels[kind]} attempts`}>{attempts.map((attempt) => <li key={attempt.stepId}><span>Attempt {attempt.attempt}</span><strong className={`attempt-${attempt.status}`}>{attempt.status}</strong>{attempt.error ? <small>{attempt.error.message}</small> : null}</li>)}</ul> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
