#!/usr/bin/env node
/**
 * pi-gateway standalone CLI entry.
 *
 * Usage:
 *   pi-gateway [--port N] [--bind HOST] [--config PATH] [--auth-dir PATH]
 *              [--allow-origin ORIGIN]... [--log-level LEVEL]
 *              [--model-allowlist ID]... [--model-denylist ID]...
 *              [--expose-oauth-subscriptions | --no-expose-oauth-subscriptions]
 *              [--require-key-on-loopback]
 *
 *   pi-gateway models       Print available models and exit
 *   pi-gateway --version    Print version and exit
 *   pi-gateway --help       Print this message
 *
 * Security: NO `--api-key` flag. Argv leaks via /proc/<pid>/cmdline + ps aux.
 * Set the key in `~/.pi/agent/gateway.json` or `PI_GATEWAY_API_KEY` env.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { type CliConfigOverrides, resolveConfig } from "./config.js";
import {
  claimPidLockfile,
  installSignalHandlers,
  releasePidLockfile,
} from "./lifecycle.js";
import { buildModelsList } from "./protocol/models-list.js";
import { startServer } from "./server/index.js";

const USAGE = `pi-gateway — OpenAI-compatible local API on top of pi.dev

Usage:
  pi-gateway [options]                Run the gateway in the foreground
  pi-gateway models                   List available models and exit
  pi-gateway --version                Print version and exit
  pi-gateway --help                   Show this help

Options:
  --port N                            HTTP listen port (default 4000; 0 = OS-assigned)
  --bind HOST                         Bind address (default 127.0.0.1)
  --config PATH                       Extra JSON config layered after ~/.pi/agent/gateway.json
  --auth-dir PATH                     Override pi auth directory (default ~/.pi/agent)
  --allow-origin ORIGIN               CORS allow-list entry (repeatable; "*" = any)
  --log-level LEVEL                   debug|info|warn|error (default info)
  --model-allowlist ID                Only expose these provider/model-ids (repeatable)
  --model-denylist ID                 Hide these provider/model-ids (repeatable)
  --expose-oauth-subscriptions        Expose Claude Pro / Codex / Copilot / Gemini CLI on non-loopback
  --no-expose-oauth-subscriptions     Hide OAuth-subscription providers on non-loopback (default off-loopback)
  --require-key-on-loopback           Require bearer auth even when bound to 127.0.0.1
  --version                           Print version and exit
  --help                              Show this help

NOTE: there is intentionally no --api-key flag (argv leak via /proc/<pid>/cmdline + ps aux).
Set the key in ~/.pi/agent/gateway.json ({"apiKey":"..."}) or via PI_GATEWAY_API_KEY env var.
`;

interface ParsedArgs {
  apiKeyFlagAttempted: boolean;
  cli: CliConfigOverrides;
  showHelp: boolean;
  showVersion: boolean;
  subcommand?: "models";
}

function parseArgs(argv: string[]): ParsedArgs {
  const cli: CliConfigOverrides = {};
  const allowOrigins: string[] = [];
  const allowlist: string[] = [];
  const denylist: string[] = [];
  let showHelp = false;
  let showVersion = false;
  let subcommand: "models" | undefined;
  let apiKeyFlagAttempted = false;

  const args = [...argv];

  if (args[0] && !args[0].startsWith("-")) {
    switch (args[0]) {
      case "models":
        subcommand = "models";
        args.shift();

        break;

      case "help":
        showHelp = true;
        args.shift();

        break;

      case "version":
        showVersion = true;
        args.shift();

        break;

      // No default
    }
  }

  while (args.length > 0) {
    const arg = args.shift()!;
    switch (arg) {
      case "--help":
      case "-h":
        showHelp = true;
        break;
      case "--version":
      case "-v":
        showVersion = true;
        break;
      case "--port": {
        const next = args.shift();
        if (next !== undefined) cli.port = Number(next);
        break;
      }
      case "--bind": {
        const next = args.shift();
        if (next !== undefined) cli.bindAddress = next;
        break;
      }
      case "--config": {
        const next = args.shift();
        if (next !== undefined) cli.configPath = next;
        break;
      }
      case "--auth-dir": {
        const next = args.shift();
        if (next !== undefined) cli.authDir = next;
        break;
      }
      case "--allow-origin": {
        const next = args.shift();
        if (next !== undefined) allowOrigins.push(next);
        break;
      }
      case "--log-level": {
        const next = args.shift();
        if (
          next === "debug" ||
          next === "info" ||
          next === "warn" ||
          next === "error"
        ) {
          cli.logLevel = next;
        }
        break;
      }
      case "--model-allowlist": {
        const next = args.shift();
        if (next !== undefined) allowlist.push(next);
        break;
      }
      case "--model-denylist": {
        const next = args.shift();
        if (next !== undefined) denylist.push(next);
        break;
      }
      case "--expose-oauth-subscriptions":
        cli.exposeOAuthSubscriptions = true;
        break;
      case "--no-expose-oauth-subscriptions":
        cli.exposeOAuthSubscriptions = false;
        break;
      case "--require-key-on-loopback":
        cli.requireKeyOnLoopback = true;
        break;
      case "--api-key":
      case "--apikey":
        apiKeyFlagAttempted = true;
        // Discard the value, but record the attempt so we exit cleanly.
        args.shift();
        break;
      default:
        // Unknown flag; ignored to stay lenient.
        break;
    }
  }

  if (allowOrigins.length > 0) cli.allowedOrigins = allowOrigins;
  if (allowlist.length > 0) cli.modelAllowlist = allowlist;
  if (denylist.length > 0) cli.modelDenylist = denylist;

  return { apiKeyFlagAttempted, cli, showHelp, showVersion, subcommand };
}

function readPackageVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 5; i += 1) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          version?: string;
        };
        return pkg.version ?? "0.0.0";
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

async function runModelsSubcommand(parsed: ParsedArgs): Promise<number> {
  const resolution = resolveConfig({ cli: parsed.cli });
  if (!resolution.ok) {
    process.stderr.write(`${resolution.message}\n`);
    return resolution.exitCode;
  }
  const authStorage = parsed.cli.authDir
    ? AuthStorage.create(path.join(parsed.cli.authDir, "auth.json"))
    : AuthStorage.create();
  const registry = parsed.cli.authDir
    ? ModelRegistry.create(
        authStorage,
        path.join(parsed.cli.authDir, "models.json"),
      )
    : ModelRegistry.create(authStorage);
  const list = buildModelsList({
    allowlist: resolution.config.modelAllowlist,
    denylist: resolution.config.modelDenylist,
    exposeOAuthSubscriptions: resolution.config.exposeOAuthSubscriptions,
    isLoopback: true,
    isUsingOAuth: (m) => registry.isUsingOAuth(m),
    models: registry.getAvailable(),
  });
  if (list.length === 0) {
    process.stderr.write(
      `No models available. Configure pi auth first (e.g. /login or ANTHROPIC_API_KEY).\n`,
    );
    return 1;
  }
  for (const entry of list) {
    process.stdout.write(`${entry.id}\t${entry.owned_by}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.showHelp) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.showVersion) {
    process.stdout.write(`pi-gateway ${readPackageVersion()}\n`);
    return 0;
  }
  if (parsed.apiKeyFlagAttempted) {
    process.stderr.write(
      `The --api-key flag is refused. Argv leaks via /proc/<pid>/cmdline and ps aux.\n` +
        `Set the key in ~/.pi/agent/gateway.json ({"apiKey":"..."}) or via PI_GATEWAY_API_KEY.\n`,
    );
    return 2;
  }
  if (parsed.subcommand === "models") {
    return runModelsSubcommand(parsed);
  }

  const resolution = resolveConfig({ cli: parsed.cli });
  if (!resolution.ok) {
    process.stderr.write(`${resolution.message}\n`);
    return resolution.exitCode;
  }
  const config = resolution.config;

  // PID lockfile.
  const pid = claimPidLockfile();
  if (!pid.ok) {
    process.stderr.write(`${pid.message}\n`);
    return pid.reason === "alive" ? 3 : 1;
  }

  let handle: Awaited<ReturnType<typeof startServer>> | null = null;
  const onShutdown = (): void => {
    process.stderr.write(`pi-gateway stopping...\n`);
  };

  try {
    handle = await startServer({ config });

    installSignalHandlers({
      controller: {
        abortAllStreams: () => handle?.abortAllStreams(),
        flushSockets: (timeoutMs) =>
          new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(timeoutMs, 5000)),
          ),
      },
      forceAbortTimeoutMs: config.forceAbortTimeoutMs,
      onShuttingDown: onShutdown,
      serverClose: () => handle?.close() ?? Promise.resolve(),
    });

    const addr = handle.address;
    const url = `http://${addr.address}:${addr.port}`;
    const modelCount = handle.modelCount;
    process.stdout.write(
      `pi-gateway listening on ${url} — ${modelCount} models available — Ctrl+C to stop\n`,
    );
    process.stdout.write(`  /v1/models  /v1/chat/completions  /healthz\n`);
    process.stdout.write(
      `  config sources: ${resolution.configSources.join(", ")}\n`,
    );
    if (!resolution.isLoopback) {
      process.stdout.write(
        `  WARNING: bound non-loopback (${config.bindAddress}); bearer auth enforced.\n`,
      );
    }

    // Block until a signal arrives.
    await new Promise<void>(() => {
      /* never resolves */
    });
    return 0;
  } catch (error) {
    process.stderr.write(`pi-gateway failed to start: ${String(error)}\n`);
    releasePidLockfile();
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`fatal: ${String(error)}\n`);
    releasePidLockfile();
    process.exit(1);
  });
