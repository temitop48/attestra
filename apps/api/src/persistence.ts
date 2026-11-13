import { access, chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return resolve(env.DATABASE_URL);
  return resolve(env.ATTESTRA_DATA_DIR ?? ".data", "executions.json");
}

export async function preparePersistentStorage(databasePath: string): Promise<void> {
  const directory = dirname(resolve(databasePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try { await access(directory, constants.R_OK | constants.W_OK); } catch { throw new Error(`Persistent storage directory is not readable and writable: ${directory}`); }
  try { await chmod(resolve(databasePath), 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function acquireSingleWriterLock(databasePath: string): Promise<() => Promise<void>> {
  const lockPath = `${resolve(databasePath)}.lock`;
  await preparePersistentStorage(databasePath);
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8"); await handle.close();
    return async () => { await unlink(lockPath).catch(() => undefined); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid = "";
    try { pid = (await readFile(lockPath, "utf8")).trim(); } catch { /* lock is being replaced */ }
    throw new Error(`Another ATTESTRA API instance owns the persistent storage lock${pid ? ` (pid ${pid})` : ""}`);
  }
}
