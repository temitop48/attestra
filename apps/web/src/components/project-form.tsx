"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createExecution, type CreateExecutionInput } from "../lib/api";

export type ProjectFormProps = { onCreated: (executionId: string) => void };

export function validateProjectForm(input: CreateExecutionInput): string | undefined {
  if (!input.requirements.trim()) return "Project requirements are required.";
  if (input.requirements.length > 20_000) return "Project requirements must be 20,000 characters or fewer.";
  if (input.targetAudience && input.targetAudience.length > 1_000) return "Target audience must be 1,000 characters or fewer.";
  if (input.maxBuilderAttempts !== undefined && (!Number.isInteger(input.maxBuilderAttempts) || input.maxBuilderAttempts < 1 || input.maxBuilderAttempts > 3)) return "Maximum Builder attempts must be between 1 and 3.";
  return undefined;
}

export function ProjectForm({ onCreated }: ProjectFormProps) {
  const [requirements, setRequirements] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [constraints, setConstraints] = useState("");
  const [maxBuilderAttempts, setMaxBuilderAttempts] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: CreateExecutionInput = {
      requirements,
      paymentEligible: true,
      ...(targetAudience.trim() ? { targetAudience: targetAudience.trim() } : {}),
      ...(constraints.trim() ? { constraints: constraints.split("\n").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(maxBuilderAttempts ? { maxBuilderAttempts: Number(maxBuilderAttempts) } : {}),
    };
    const validationError = validateProjectForm(input);
    if (validationError) { setError(validationError); return; }
    setSubmitting(true);
    setError(undefined);
    try {
      const created = await createExecution(input);
      onCreated(created.executionId);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The execution could not be started.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="project-form" onSubmit={submit} noValidate>
      <div className="field-block">
        <label htmlFor="requirements">Project requirements <span aria-hidden="true">*</span></label>
        <textarea id="requirements" value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="Describe the work the agents should complete..." rows={6} aria-describedby="requirements-help" required />
        <span id="requirements-help" className="field-help">Be specific about the deliverable, audience, and acceptance expectations.</span>
      </div>
      <div className="field-block">
        <label htmlFor="target-audience">Target audience <span className="optional">optional</span></label>
        <input id="target-audience" value={targetAudience} onChange={(event) => setTargetAudience(event.target.value)} placeholder="e.g. Productivity-focused professionals" />
      </div>
      <div className="field-block">
        <label htmlFor="constraints">Constraints <span className="optional">optional · one per line</span></label>
        <textarea id="constraints" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="Use accessible HTML\nDo not load remote resources" rows={3} />
      </div>
      <div className="field-block field-block-compact">
        <label htmlFor="max-attempts">Maximum Builder attempts <span className="optional">optional</span></label>
        <select id="max-attempts" value={maxBuilderAttempts} onChange={(event) => setMaxBuilderAttempts(event.target.value)}>
          <option value="">Backend default · 3</option>
          <option value="1">1 attempt</option>
          <option value="2">2 attempts</option>
          <option value="3">3 attempts</option>
        </select>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="primary-action" type="submit" disabled={submitting}>
        {submitting ? "Starting execution…" : "Start autonomous execution"}
      </button>
    </form>
  );
}
