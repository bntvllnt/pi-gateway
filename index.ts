/**
 * pi-gateway pi-extension entry.
 *
 * Registers slash commands `/gateway:start`, `/gateway:stop`, `/gateway:status`,
 * LLM-callable tools `gateway_start` / `gateway_stop` / `gateway_status`, and a
 * footer status widget.
 *
 * `/gateway:start` spawns the standalone `pi-gateway` binary as a DETACHED
 * child process so the daemon survives pi session shutdown. The detached child
 * writes the PID to `~/.pi/agent/gateway.pid` (atomic O_CREAT|O_EXCL). All
 * status / stop operations read that machine-scoped PID file — never a
 * session-scoped cache — so behavior is correct across pi restarts.
 *
 * Binary resolution: `new URL("dist/cli.js", import.meta.url)`. NEVER walks
 * $PATH (the package's bin symlink is not on the shell PATH when installed via
 * pi's settings.json packages array).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const require = createRequire(import.meta.url);

const PID_PATH = path.join(homedir(), ".pi", "agent", "gateway.pid");
const DEFAULT_PORT = 4000;
const DEFAULT_BIND = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 1500;

/**
 * Resolve the source entry of the standalone daemon. We prefer the built
 * `dist/cli.js` when present (faster startup, no jiti). Otherwise we fall back
 * to spawning `src/cli.ts` through jiti so the pi-installed package works
 * without an explicit `pnpm run build` step (mirrors pi-claude-code).
 */
function resolveDaemonEntry():
  | {
      entry: string;
      mode: "compiled";
    }
  | {
      entry: string;
      jitiCli: string;
      mode: "jiti";
    }
  | null {
  const compiled = fileURLToPath(new URL("dist/cli.js", import.meta.url));
  if (existsSync(compiled)) {
    return { entry: compiled, mode: "compiled" };
  }
  const sourceEntry = fileURLToPath(new URL("src/cli.ts", import.meta.url));
  if (!existsSync(sourceEntry)) return null;
  const candidates: string[] = [];
  try {
    const localJiti = require.resolve("@mariozechner/jiti/package.json");
    candidates.push(path.join(path.dirname(localJiti), "lib", "jiti-cli.mjs"));
  } catch {
    /* ignore */
  }
  try {
    const pcaPkg =
      require.resolve("@mariozechner/pi-coding-agent/package.json");
    candidates.push(
      path.join(
        path.dirname(pcaPkg),
        "node_modules",
        "@mariozechner",
        "jiti",
        "lib",
        "jiti-cli.mjs",
      ),
    );
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      return { entry: sourceEntry, jitiCli: c, mode: "jiti" };
    }
  }
  return null;
}

function readPid(): number | null {
  try {
    if (!existsSync(PID_PATH)) return null;
    const raw = readFileSync(PID_PATH, "utf8").trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

interface DaemonStatus {
  detail?: string;
  modelCount?: number;
  pid?: number;
  state: "running" | "stopped" | "stale";
  url?: string;
}

async function probeStatus(
  url: string,
): Promise<{ healthy: boolean; modelCount?: number }> {
  const healthy = await ping(`${url}/healthz`).catch(() => false);
  if (!healthy) return { healthy: false };
  const modelCount = await fetchModelCount(`${url}/v1/models`).catch(
    () => undefined,
  );
  return { healthy: true, modelCount };
}

function ping(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        method: "GET",
        path: u.pathname + u.search,
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
      },
    );
    req.on("error", () => {
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function fetchModelCount(url: string): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        method: "GET",
        path: u.pathname + u.search,
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as { data?: unknown[] };
            resolve(
              Array.isArray(parsed.data) ? parsed.data.length : undefined,
            );
          } catch {
            resolve(undefined);
          }
        });
        res.on("error", () => {
          resolve(undefined);
        });
      },
    );
    req.on("error", () => {
      resolve(undefined);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

function defaultGatewayUrl(): string {
  try {
    const cfgPath = path.join(homedir(), ".pi", "agent", "gateway.json");
    if (existsSync(cfgPath)) {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        bindAddress?: string;
        port?: number;
      };
      const port = parsed.port ?? DEFAULT_PORT;
      const bind = parsed.bindAddress ?? DEFAULT_BIND;
      return `http://${bind}:${port}`;
    }
  } catch {
    /* ignore */
  }
  return `http://${DEFAULT_BIND}:${DEFAULT_PORT}`;
}

async function getStatus(): Promise<DaemonStatus> {
  const pid = readPid();
  const url = defaultGatewayUrl();
  if (pid === null) {
    const { healthy, modelCount } = await probeStatus(url);
    if (healthy) {
      return {
        detail: "running (no pid file)",
        modelCount,
        state: "running",
        url,
      };
    }
    return { state: "stopped", url };
  }
  if (!isAlive(pid)) {
    try {
      unlinkSync(PID_PATH);
    } catch {
      /* ignore */
    }
    return { detail: `cleaned stale pid ${pid}`, pid, state: "stale", url };
  }
  const { healthy, modelCount } = await probeStatus(url);
  if (healthy) {
    return { modelCount, pid, state: "running", url };
  }
  return {
    detail: "process alive but /healthz unreachable",
    pid,
    state: "running",
    url,
  };
}

function spawnDaemon():
  | { ok: true; pid: number }
  | { error: string; ok: false } {
  const target = resolveDaemonEntry();
  if (!target) {
    return {
      error: `Could not locate pi-gateway daemon entry. Looked for dist/cli.js and src/cli.ts under ${fileURLToPath(new URL(".", import.meta.url))}.`,
      ok: false,
    };
  }
  const args =
    target.mode === "compiled"
      ? [target.entry]
      : [target.jitiCli, target.entry];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      env: { ...process.env },
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) {
      return { error: "spawn returned no pid", ok: false };
    }
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { error: `spawn failed: ${String(error)}`, ok: false };
  }
}

async function startDaemon(): Promise<string> {
  const before = await getStatus();
  if (before.state === "running" && before.pid) {
    return `pi-gateway already running (pid ${before.pid}, ${before.url}).`;
  }
  const spawned = spawnDaemon();
  if (!spawned.ok) return `Failed to start pi-gateway: ${spawned.error}`;
  // Poll briefly for the child to become healthy.
  const url = defaultGatewayUrl();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(250);
    const { healthy, modelCount } = await probeStatus(url);
    if (healthy) {
      const live = readPid();
      return `pi-gateway started (pid ${live ?? spawned.pid}, ${url}, ${modelCount ?? "?"} models). Detached — survives pi exit.`;
    }
  }
  return `pi-gateway spawned (pid ${spawned.pid}) but did not become healthy within 8s. Check ${PID_PATH} and logs.`;
}

async function stopDaemon(): Promise<string> {
  const status = await getStatus();
  if (status.state === "stopped") return "pi-gateway is not running.";
  if (!status.pid)
    return "pi-gateway is running but has no recorded pid; cannot stop.";
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    return `Failed to SIGTERM pid ${status.pid}: ${String(error)}`;
  }
  // Wait for the daemon to exit (up to 6s).
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isAlive(status.pid)) {
      try {
        if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
      } catch {
        /* ignore */
      }
      return `pi-gateway stopped (was pid ${status.pid}).`;
    }
  }
  return `pi-gateway pid ${status.pid} did not exit within 6s; sent SIGTERM. Re-run /gateway:status to check.`;
}

async function formatStatus(): Promise<string> {
  const s = await getStatus();
  if (s.state === "running") {
    return `pi-gateway: running · ${s.url}${s.modelCount === undefined ? "" : ` · ${s.modelCount} models`}${s.pid ? ` · pid ${s.pid}` : ""}`;
  }
  if (s.state === "stale") {
    return `pi-gateway: stale pid file cleaned (${s.detail ?? ""}).`;
  }
  return `pi-gateway: stopped (${s.url}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function piGatewayExtension(pi: ExtensionAPI): void {
  // Commands
  pi.registerCommand("gateway:start", {
    description: "Start pi-gateway as a detached child process.",
    handler: async (_args, ctx) => {
      const msg = await startDaemon();
      ctx.ui.notify(msg, "info");
    },
  });
  pi.registerCommand("gateway:stop", {
    description: "Stop the running pi-gateway daemon (SIGTERM).",
    handler: async (_args, ctx) => {
      const msg = await stopDaemon();
      ctx.ui.notify(msg, "info");
    },
  });
  pi.registerCommand("gateway:status", {
    description: "Show pi-gateway daemon state.",
    handler: async (_args, ctx) => {
      const msg = await formatStatus();
      ctx.ui.notify(msg, "info");
    },
  });

  // LLM-callable tools (read-only by default; start/stop guarded by usage intent).
  pi.registerTool({
    description:
      "Report whether pi-gateway is running, its URL, model count, and PID. Read-only; never spawns or signals.",
    async execute() {
      const status = await getStatus();
      return {
        content: [{ text: JSON.stringify(status, null, 2), type: "text" }],
        details: status as unknown as Record<string, unknown>,
      };
    },
    label: "Gateway Status",
    name: "gateway_status",
    parameters: Type.Object({}, { additionalProperties: false }),
  });
  pi.registerTool({
    description:
      "Start pi-gateway as a detached child process if not already running.",
    async execute() {
      const text = await startDaemon();
      return {
        content: [{ text, type: "text" }],
        details: { action: "start" },
      };
    },
    label: "Gateway Start",
    name: "gateway_start",
    parameters: Type.Object({}, { additionalProperties: false }),
  });
  pi.registerTool({
    description: "Stop the running pi-gateway daemon via SIGTERM.",
    async execute() {
      const text = await stopDaemon();
      return { content: [{ text, type: "text" }], details: { action: "stop" } };
    },
    label: "Gateway Stop",
    name: "gateway_stop",
    parameters: Type.Object({}, { additionalProperties: false }),
  });

  // Footer widget: poll status every 5s and update the footer line.
  let pollTimer: NodeJS.Timeout | undefined;
  const FOOTER_KEY = "pi-gateway";
  const refreshFooter = async (ctx: {
    hasUI?: boolean;
    ui?: { setStatus?: (key: string, value: string | undefined) => void };
  }): Promise<void> => {
    if (!ctx.hasUI || !ctx.ui?.setStatus) return;
    try {
      const status = await getStatus();
      if (status.state === "running") {
        const suffix =
          status.modelCount === undefined
            ? ""
            : ` · ${status.modelCount} models`;
        ctx.ui.setStatus(
          FOOTER_KEY,
          `Gateway: running · ${status.url}${suffix}`,
        );
      } else {
        ctx.ui.setStatus(FOOTER_KEY, `Gateway: stopped`);
      }
    } catch {
      /* ignore */
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshFooter(ctx);
    pollTimer = setInterval(() => {
      void refreshFooter(ctx);
    }, 5000);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (
      (
        ctx as {
          hasUI?: boolean;
          ui?: { setStatus?: (k: string, v: string | undefined) => void };
        }
      ).hasUI
    ) {
      (
        ctx as { ui: { setStatus: (k: string, v: string | undefined) => void } }
      ).ui.setStatus(FOOTER_KEY, undefined);
    }
  });
}
