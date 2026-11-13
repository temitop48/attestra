#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const WASM_PATH = resolve(ROOT, "contracts/escrow/target/wasm32-unknown-unknown/release/attestra_escrow.wasm");
const DEFAULT_REPORT = resolve(ROOT, ".data/near-testnet-deployment-report.json");
const REQUIRED_AUTHORIZATION = "I_UNDERSTAND_ATTESTRA_TESTNET_DEPLOYMENT";
const ACCOUNT_ID = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?))*$/;

function fail(message) { throw new Error(message); }
function env(name) { const value = process.env[name]?.trim(); return value || undefined; }
function requireAccount(name) { const value = env(name); if (!value || !ACCOUNT_ID.test(value)) fail(`${name} must be a valid NEAR account ID`); return value; }
function config() {
  const network = env("NEAR_NETWORK");
  if (network !== "testnet") fail("NEAR_NETWORK must be exactly testnet; Mainnet deployment is not supported by this workflow");
  const rpcUrl = env("NEAR_RPC_URL") ?? "https://rpc.testnet.near.org";
  const parsed = new URL(rpcUrl);
  if (parsed.hostname.includes("mainnet") || parsed.hostname.includes("near.org") && !parsed.hostname.includes("testnet")) fail("NEAR_RPC_URL does not identify the Testnet RPC endpoint");
  const contract = requireAccount("NEAR_ESCROW_CONTRACT_ACCOUNT");
  const administrator = requireAccount("NEAR_ADMINISTRATOR_ACCOUNT_ID");
  const verifier = requireAccount("NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID");
  const deployer = requireAccount("NEAR_DEPLOYER_ACCOUNT_ID");
  if (deployer !== contract) fail("NEAR_DEPLOYER_ACCOUNT_ID must equal NEAR_ESCROW_CONTRACT_ACCOUNT for this deployment flow");
  if (verifier === administrator || verifier === contract) fail("NEAR_AUTHORIZED_VERIFIER_ACCOUNT_ID must be distinct from the administrator and contract accounts");
  const initDeposit = env("NEAR_INITIALIZATION_DEPOSIT_NEAR");
  if (!initDeposit || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(initDeposit)) fail("NEAR_INITIALIZATION_DEPOSIT_NEAR must be a positive decimal NEAR amount");
  if (Number(initDeposit) <= 0) fail("NEAR_INITIALIZATION_DEPOSIT_NEAR must be positive");
  return { network, rpcUrl, contract, administrator, verifier, deployer, initDeposit };
}
function wasmHash() { if (!existsSync(WASM_PATH)) fail(`WASM artifact not found at ${WASM_PATH}`); return createHash("sha256").update(readFileSync(WASM_PATH)).digest("hex"); }
function buildWasm() {
  const result = spawnSync("cargo", ["build", "--manifest-path", "contracts/escrow/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release"], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) fail("Contract WASM build failed");
}
async function rpc(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  if (!response.ok) fail(`NEAR RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) fail(`NEAR RPC error: ${body.error.message ?? "unknown error"}`);
  return body.result;
}
async function viewContract(rpcUrl, accountId, methodName, args) {
  const result = await rpc(rpcUrl, "query", { request_type: "call_function", finality: "final", account_id: accountId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64") });
  if (!Array.isArray(result.result)) fail(`Contract view ${methodName} returned an invalid result`);
  try { return JSON.parse(Buffer.from(result.result).toString("utf8")); } catch { fail(`Contract view ${methodName} did not return JSON`); }
}
async function verifyNetworkAndAccount(settings, requireInitialized = false) {
  const status = await rpc(settings.rpcUrl, "status", {});
  if (status.chain_id !== "testnet") fail(`RPC chain_id is ${status.chain_id}, not testnet`);
  const account = await rpc(settings.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: settings.contract });
  const initialization = requireInitialized ? { method: "get_project_ids", result: await viewContract(settings.rpcUrl, settings.contract, "get_project_ids", { owner: settings.administrator, from_index: 0, limit: 1 }) } : { method: "get_project_ids", checked: false };
  if (requireInitialized && !Array.isArray(initialization.result)) fail("Contract initialization could not be verified through get_project_ids");
  return { chainId: status.chain_id, latestBlockHeight: status.sync_info?.latest_block_height, contractAccount: { accountId: settings.contract, amount: account.amount, locked: account.locked, codeHash: account.code_hash, storageUsage: account.storage_usage }, initialization };
}
function runNear(args) {
  const result = spawnSync("near", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`NEAR CLI command failed: near ${args.join(" ")}\n${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}
async function writeReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  console.log(`Deployment report: ${reportPath}`);
}
function readPreviousReport(reportPath) {
  if (!existsSync(reportPath)) return undefined;
  try { return JSON.parse(readFileSync(reportPath, "utf8")); } catch { fail(`Existing deployment report is not valid JSON: ${reportPath}`); }
}
function refuseUnreviewedRecovery(previous) {
  const partial = new Set(["deployment_submitted", "deployment_failed", "deployment_succeeded", "initialization_submitted", "initialization_failed"]);
  if (previous && partial.has(previous.status) && env("ATTESTRA_DEPLOYMENT_RECOVERY") !== "I_UNDERSTAND_PARTIAL_DEPLOYMENT") fail(`Existing report is in ${previous.status}; refusing automatic redeployment. Review the account and set ATTESTRA_DEPLOYMENT_RECOVERY explicitly after an operator decision.`);
}
function archivePreviousReport(reportPath, previous) {
  if (!previous) return undefined;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  let archivePath = `${reportPath}.before-recovery-${stamp}.json`;
  let suffix = 1;
  while (existsSync(archivePath)) archivePath = `${reportPath}.before-recovery-${stamp}-${suffix++}.json`;
  copyFileSync(reportPath, archivePath);
  chmodSync(archivePath, 0o600);
  return archivePath;
}
function transactionHash(output) { return output.match(/Transaction Id\s+([1-9A-HJ-NP-Za-km-z]{40,64})/i)?.[1]; }
function help() {
  console.log("Usage: node scripts/deploy-near-testnet.mjs [--prepare|--execute|--verify]");
  console.log("Default mode is --prepare. --execute requires explicit authorization and performs blockchain writes.");
  console.log("--verify performs read-only post-deployment checks using supplied transaction hashes.");
}

const mode = process.argv.includes("--help") ? "help" : process.argv.includes("--execute") ? "execute" : process.argv.includes("--verify") ? "verify" : "prepare";
if (mode === "help") { help(); process.exit(0); }
try {
  const settings = config();
  if (mode === "prepare" || mode === "execute") buildWasm();
  const reportPath = resolve(env("ATTESTRA_DEPLOYMENT_REPORT") ?? DEFAULT_REPORT);
  const previous = readPreviousReport(reportPath);
  if (mode === "execute") refuseUnreviewedRecovery(previous);
  const previousReportArchive = mode === "execute" && previous ? archivePreviousReport(reportPath, previous) : undefined;
  const report = { schema: "attestra-near-deployment-report-v1", generatedAt: new Date().toISOString(), mode, network: settings.network, rpcUrl: settings.rpcUrl, contractAccountId: settings.contract, administratorAccountId: settings.administrator, authorizedVerifierAccountId: settings.verifier, wasmPath: WASM_PATH, wasmSha256: wasmHash(), initialization: { method: "new", administrator: settings.administrator, verifier: settings.verifier, depositNear: settings.initDeposit, caller: settings.administrator, status: "not_started" }, stages: { preflight: { status: "not_started" }, deployment: { status: "not_started" }, initialization: { status: "not_started" }, postflight: { status: "not_started" } }, writesAttempted: false };
  if (previousReportArchive) report.previousReportArchive = previousReportArchive;
  if (mode === "prepare") { report.status = "prepared"; report.stages.preflight = { status: "not_run_in_prepare_mode" }; await writeReport(reportPath, report); console.log("Preparation complete. No NEAR CLI or signing operation was invoked."); process.exit(0); }
  if (mode === "verify") {
    report.writesAttempted = false; report.deploymentTransactionHash = env("NEAR_DEPLOYMENT_TRANSACTION_HASH") ?? null; report.initializationTransactionHash = env("NEAR_INITIALIZATION_TRANSACTION_HASH") ?? null;
    if (!report.deploymentTransactionHash || !report.initializationTransactionHash) fail("Verification requires NEAR_DEPLOYMENT_TRANSACTION_HASH and NEAR_INITIALIZATION_TRANSACTION_HASH; hashes are never invented");
    report.chainVerification = await verifyNetworkAndAccount(settings, true); report.stages.postflight = { status: "succeeded", completedAt: new Date().toISOString() }; report.status = "verified_read_only"; await writeReport(reportPath, report); process.exit(0);
  }
  if (env("ATTESTRA_DEPLOY_AUTHORIZATION") !== REQUIRED_AUTHORIZATION) fail(`Deployment requires ATTESTRA_DEPLOY_AUTHORIZATION=${REQUIRED_AUTHORIZATION}`);
  report.stages.preflight = { status: "submitted", startedAt: new Date().toISOString() }; await writeReport(reportPath, report);
  let before;
  try { before = await verifyNetworkAndAccount(settings); } catch (error) { report.stages.preflight = { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Preflight failed" }; report.status = "preflight_failed"; await writeReport(reportPath, report); throw error; }
  if (before.contractAccount.codeHash && !/^1+$/.test(before.contractAccount.codeHash)) { report.stages.preflight = { status: "failed", completedAt: new Date().toISOString(), error: "Contract account already contains code; refusing to redeploy silently" }; report.status = "preflight_failed"; await writeReport(reportPath, report); fail("Contract account already contains code; refusing to redeploy silently"); }
  if (env("NEAR_CLI_MODE") !== "classic") { report.stages.preflight = { status: "failed", completedAt: new Date().toISOString(), error: "NEAR_CLI_MODE must be classic" }; report.status = "preflight_failed"; await writeReport(reportPath, report); fail("Set NEAR_CLI_MODE=classic after reviewing the documented near-cli command syntax"); }
  report.preDeploymentChainState = before; report.writesAttempted = true; report.stages.preflight = { status: "succeeded", completedAt: new Date().toISOString() }; report.stages.deployment = { status: "submitted", startedAt: new Date().toISOString() }; report.status = "deployment_submitted"; await writeReport(reportPath, report);
  let deploy;
  try { deploy = runNear(["deploy", settings.contract, WASM_PATH, "--networkId", "testnet"]); } catch (error) { report.stages.deployment = { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Deployment failed" }; report.status = "deployment_failed"; await writeReport(reportPath, report); throw error; }
  report.deployCliOutput = deploy.stdout; report.deploymentTransactionHash = transactionHash(deploy.stdout) ?? null; report.stages.deployment = { status: "succeeded", completedAt: new Date().toISOString(), transactionHash: report.deploymentTransactionHash }; report.status = "deployment_succeeded"; await writeReport(reportPath, report);
  const initArgs = JSON.stringify({ administrator: settings.administrator, verifier: settings.verifier });
  report.initialization.status = "submitted"; report.stages.initialization = { status: "submitted", startedAt: new Date().toISOString() }; report.status = "initialization_submitted"; await writeReport(reportPath, report);
  let initialize;
  try { initialize = runNear(["call", settings.contract, "new", initArgs, "--accountId", settings.administrator, "--amount", settings.initDeposit, "--networkId", "testnet"]); } catch (error) { report.initialization.status = "failed"; report.stages.initialization = { status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Initialization failed" }; report.status = "initialization_failed"; await writeReport(reportPath, report); throw error; }
  report.initializeCliOutput = initialize.stdout; report.initialization.status = "succeeded"; report.initializationTransactionHash = transactionHash(initialize.stdout) ?? null; report.stages.initialization = { status: "succeeded", completedAt: new Date().toISOString(), transactionHash: report.initializationTransactionHash }; report.postDeploymentChainState = await verifyNetworkAndAccount(settings, true); report.stages.postflight = { status: "succeeded", completedAt: new Date().toISOString() }; report.status = "writes_completed_requires_hash_review";
  await writeReport(reportPath, report);
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
