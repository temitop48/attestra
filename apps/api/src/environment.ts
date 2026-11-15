import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function localEnvironmentPath(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../../.env.local");
}

export function loadLocalEnvironment(environment: NodeJS.ProcessEnv = process.env, filePath: string = localEnvironmentPath()): void {
  if (environment.NODE_ENV === "production") return;
  let contents: string;
  try { contents = readFileSync(filePath, "utf8"); } catch { return; }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue.startsWith("'") && rawValue.endsWith("'") ? rawValue.slice(1, -1) : rawValue;
    if (environment[key] === undefined) environment[key] = value;
  }
}
