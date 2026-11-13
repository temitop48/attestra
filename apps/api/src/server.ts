import { buildApp } from "./app.js";
import { createVerifierSignerFromEnvironment } from "./verifier-bootstrap.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSingleWriterLock, resolveDatabasePath } from "./persistence.js";
import { createPostgresPersistence } from "./postgres-persistence.js";

function loadLocalEnvironment(): void {
  const filePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.local");
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnvironment();

function validateProductionEnvironment(): void {
  if (process.env.NODE_ENV !== "production") return;
  const origin = process.env.FRONTEND_ORIGIN;
  if (!origin || !/^https:\/\/[^/]+$/.test(origin)) throw new Error("FRONTEND_ORIGIN must be one explicit HTTPS origin in production");
  if (!process.env.ATTESTRA_LLM_API_KEY || process.env.ATTESTRA_DEMO_MODE === "true") throw new Error("A real AI provider key is required and demo mode is forbidden in production");
  if (process.env.NEAR_NETWORK !== "testnet" || !process.env.NEAR_ESCROW_CONTRACT_ACCOUNT || !process.env.NEAR_RPC_URL) throw new Error("NEAR Testnet network, escrow contract, and RPC URL are required in production");
  if (!process.env.DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL)) throw new Error("A PostgreSQL DATABASE_URL is required for durable production storage; JSON persistence is not allowed in production");
}

validateProductionEnvironment();

let verifierSigner;
let verifierSignerConfigurationError: string | undefined;
try {
  verifierSigner = await createVerifierSignerFromEnvironment();
} catch (error) {
  verifierSignerConfigurationError = error instanceof Error ? error.message : "Verifier signer configuration is invalid";
}
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";
const usePostgres = process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL?.match(/^postgres(?:ql)?:\/\//));
const persistence = usePostgres ? await createPostgresPersistence() : undefined;
const databasePath = persistence ? undefined : resolveDatabasePath();
const releaseStorageLock = databasePath ? await acquireSingleWriterLock(databasePath) : async () => undefined;
const app = buildApp({ verifierSigner, verifierSignerConfigurationError, ...(persistence ? { store: persistence.executionStore, verifierSubmissionStore: persistence.submissionStore } : { databasePath }) });

try {
  await app.listen({ port, host });
} catch (error) {
  await releaseStorageLock();
  await persistence?.close();
  app.log.error(error);
  process.exit(1);
}

async function shutdown(): Promise<void> { await app.close(); await releaseStorageLock(); await persistence?.close(); }
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
