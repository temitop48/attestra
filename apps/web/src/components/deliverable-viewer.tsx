"use client";

import { useEffect, useState } from "react";
import { ApiError, getArtifacts, type ArtifactResponse } from "../lib/api";

export function DeliverableViewer({ executionId }: { executionId?: string }) {
  const [result, setResult] = useState<ArtifactResponse>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setResult(undefined); setSelectedPath(undefined); setError(undefined);
    if (!executionId) return () => { active = false; };
    setLoading(true);
    getArtifacts(executionId).then((next) => { if (active) { setResult(next); setSelectedPath(next.artifacts[0]?.path); } }).catch((cause) => { if (active) setError(cause instanceof ApiError ? cause.message : "Artifacts could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [executionId]);

  const selected = result?.artifacts.find((artifact) => artifact.path === selectedPath);
  return <section className="viewer-section" aria-labelledby="deliverables-title"><div className="inspection-heading"><div><span className="panel-kicker">Deliverables</span><h2 id="deliverables-title">Final artifact</h2></div>{result ? <span className="revision-label">Revision {result.revision}</span> : null}</div>{!executionId ? <p className="inspection-empty">Select a saved execution to inspect its final artifacts.</p> : null}{loading ? <p className="inspection-empty" role="status">Loading artifact contents…</p> : null}{error ? <p className="inline-error" role="alert">{error}</p> : null}{result ? <><div className="artifact-meta"><span><strong>Digest</strong><code>{result.digest}</code></span><span><strong>Files</strong>{result.artifacts.length}</span></div><div className="source-layout"><div className="file-list" role="tablist" aria-label="Generated files">{result.artifacts.map((artifact) => <button className={artifact.path === selectedPath ? "file-tab file-tab-selected" : "file-tab"} key={artifact.path} type="button" role="tab" aria-selected={artifact.path === selectedPath} onClick={() => setSelectedPath(artifact.path)}><span>{artifact.path}</span><small>{artifact.mediaType}</small></button>)}</div><div className="source-panel"><div className="source-panel-header"><span>{selected?.path ?? "No file selected"}</span><span>{selected?.mediaType}</span></div><pre tabIndex={0} aria-label={selected ? `${selected.path} source code` : "Source code unavailable"}><code>{selected?.content ?? "No artifact content available."}</code></pre></div></div></> : null}</section>;
}
