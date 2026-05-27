/**
 * Daemon lifecycle: state machine + atomic PID lockfile + signal wiring.
 *
 * PID lockfile invariant:
 *   - File path: `~/.pi/agent/gateway.pid`
 *   - Single-instance enforced via `fs.openSync(path, "wx")` (atomic
 *     O_CREAT|O_EXCL).
 *   - On EEXIST, probe the recorded PID with `process.kill(pid, 0)`. If dead,
 *     unlink + retry exclusive open ONCE. If still alive, refuse.
 *   - On clean shutdown, remove the file. On crash, the file is stale and the
 *     next start cleans it.
 *
 * Signals:
 *   - SIGINT / SIGTERM handlers are registered BEFORE `listen()` so that an
 *     interrupt during `STARTING` does not orphan the listener.
 *   - On shutdown: abort all in-flight pi-ai streams via AbortController.
 *     Allow up to `forceAbortTimeoutMs` for the TCP sockets to flush final
 *     SSE frames before closing the server.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const DEFAULT_PID_PATH = path.join(
  homedir(),
  ".pi",
  "agent",
  "gateway.pid",
);

export interface PidClaim {
  ok: true;
  path: string;
  pid: number;
}

export interface PidConflict {
  message: string;
  ok: false;
  ownerPid?: number;
  path: string;
  reason: "alive" | "io_error";
}

export type PidResult = PidClaim | PidConflict;

/**
 * Atomically claim the PID lockfile. Returns conflict if another live daemon
 * owns the file; cleans the file if the recorded PID is dead.
 */
export function claimPidLockfile(pidPath = DEFAULT_PID_PATH): PidResult {
  const pid = process.pid;
  try {
    const fd = openSync(pidPath, "wx");
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path: pidPath, pid };
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") {
      return {
        message: `Failed to write PID lockfile at ${pidPath}: ${e.message}`,
        ok: false,
        path: pidPath,
        reason: "io_error",
      };
    }
  }
  // EEXIST path: probe liveness.
  let recordedPid: number | undefined;
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      recordedPid = parsed;
    }
  } catch {
    // PID file unreadable — fall through to remove + retry.
  }
  if (recordedPid !== undefined) {
    const alive = isProcessAlive(recordedPid);
    if (alive) {
      return {
        message: `Another pi-gateway daemon (pid ${recordedPid}) is already running. PID lockfile: ${pidPath}`,
        ok: false,
        ownerPid: recordedPid,
        path: pidPath,
        reason: "alive",
      };
    }
  }
  // Stale file — clean and retry exclusive open.
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
  try {
    const fd = openSync(pidPath, "wx");
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path: pidPath, pid };
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    return {
      message: `Failed to claim PID lockfile after stale-cleanup: ${e.message}`,
      ok: false,
      path: pidPath,
      reason: "io_error",
    };
  }
}

export function releasePidLockfile(pidPath = DEFAULT_PID_PATH): void {
  try {
    if (!existsSync(pidPath)) return;
    const raw = readFileSync(pidPath, "utf8").trim();
    const parsed = Number(raw);
    if (parsed === process.pid) {
      unlinkSync(pidPath);
    }
  } catch {
    /* ignore */
  }
}

export function readPidLockfile(pidPath = DEFAULT_PID_PATH): number | null {
  try {
    if (!existsSync(pidPath)) return null;
    const raw = readFileSync(pidPath, "utf8").trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

export interface ShutdownController {
  abortAllStreams(): void;
  /** Wait up to `timeoutMs` for in-flight sockets to flush. */
  flushSockets(timeoutMs: number): Promise<void>;
}

export interface InstallSignalsOptions {
  controller: ShutdownController;
  forceAbortTimeoutMs: number;
  onShuttingDown?: () => void;
  pidPath?: string;
  serverClose: () => Promise<void>;
}

export function installSignalHandlers(
  options: InstallSignalsOptions,
): () => void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (options.onShuttingDown) options.onShuttingDown();
    void shutdown(signal);
  };
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    options.controller.abortAllStreams();
    await options.controller.flushSockets(options.forceAbortTimeoutMs);
    await options.serverClose();
    releasePidLockfile(options.pidPath);
    const exitCode = signal === "SIGTERM" ? 0 : 0;
    process.exit(exitCode);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
