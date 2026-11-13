import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnvironment(): void {
  const filePath = resolve(process.cwd(), "../../.env.local");
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Local API environment file is missing: ${filePath}`);
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue.startsWith("'") && rawValue.endsWith("'") ? rawValue.slice(1, -1) : rawValue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnvironment();
await import("./server.js");
