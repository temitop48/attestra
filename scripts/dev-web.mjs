import { open, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repositoryRoot, "apps/web");
const lockPath = resolve(webRoot, ".next-dev.lock");

async function readLockPid() {
  try {
    const value = await readFile(lockPath, "utf8");
    const pid = Number.parseInt(value.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireLock() {
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pid = await readLockPid();
    if (pid && processExists(pid)) {
      console.error(`ATTESTRA web dev server is already running (launcher PID ${pid}); refusing a second instance.`);
      process.exit(1);
    }
    await unlink(lockPath).catch(() => undefined);
    return acquireLock();
  }
}

await acquireLock();
let released = false;
async function releaseLock() {
  if (released) return;
  released = true;
  await unlink(lockPath).catch(() => undefined);
}

const child = spawn(process.execPath, [resolve(webRoot, "node_modules/next/dist/bin/next"), "dev", ...process.argv.slice(2)], {
  cwd: webRoot,
  env: process.env,
  stdio: "inherit",
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("exit", async (code, signal) => {
  await releaseLock();
  process.exit(code ?? (signal ? 1 : 0));
});

process.once("exit", () => {
  // Best-effort cleanup for normal launcher exit; stale PIDs are recovered on next start.
  void releaseLock();
});
