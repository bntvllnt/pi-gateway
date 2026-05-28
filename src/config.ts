/**
 * pi-gateway configuration.
 *
 * Resolution precedence (high → low):
 *   1. CLI flags (parsed in cli.ts)
 *   2. PI_GATEWAY_* env vars
 *   3. `--config <path>` JSON file
 *   4. `~/.pi/agent/gateway.json`
 *   5. Built-in defaults
 *
 * Security rules enforced at preflight:
 *   - Default bind is `127.0.0.1`.
 *   - Non-loopback bind requires `apiKey` in the config file (NEVER from a
 *     CLI flag; argv leaks via /proc/<pid>/cmdline + ps aux).
 *   - OAuth-subscription providers default-allow on loopback (so Claude Pro /
 *     ChatGPT Codex / Copilot / Gemini CLI are visible from Open WebUI), and
 *     default-deny on non-loopback unless explicitly opted in via
 *     `exposeOAuthSubscriptions: true`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const GatewayConfigSchema = Type.Object(
  {
    allowedOrigins: Type.Array(Type.String()),
    apiKey: Type.Optional(Type.String()),
    authDir: Type.Optional(Type.String()),
    bindAddress: Type.String(),
    exposeOAuthSubscriptions: Type.Boolean(),
    forceAbortTimeoutMs: Type.Integer({ minimum: 100 }),
    heartbeatIntervalMs: Type.Integer({ minimum: 1000 }),
    logLevel: Type.Union([
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
    ]),
    modelAllowlist: Type.Optional(Type.Array(Type.String())),
    modelDenylist: Type.Optional(Type.Array(Type.String())),
    port: Type.Integer({ maximum: 65_535, minimum: 0 }),
    requireKeyOnLoopback: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type GatewayConfig = Static<typeof GatewayConfigSchema>;

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "::ffff:127.0.0.1",
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export const DEFAULT_CONFIG: GatewayConfig = {
  allowedOrigins: [],
  apiKey: undefined,
  authDir: undefined,
  bindAddress: "127.0.0.1",
  exposeOAuthSubscriptions: true,
  forceAbortTimeoutMs: 5000,
  heartbeatIntervalMs: 15_000,
  logLevel: "info",
  modelAllowlist: undefined,
  modelDenylist: undefined,
  port: 4000,
  requireKeyOnLoopback: false,
};

export interface CliConfigOverrides {
  allowedOrigins?: string[];
  authDir?: string;
  bindAddress?: string;
  configPath?: string;
  exposeOAuthSubscriptions?: boolean;
  logLevel?: GatewayConfig["logLevel"];
  modelAllowlist?: string[];
  modelDenylist?: string[];
  port?: number;
  requireKeyOnLoopback?: boolean;
}

export interface ResolveConfigInput {
  cli: CliConfigOverrides;
}

export interface ResolveConfigResult {
  config: GatewayConfig;
  configSources: string[];
  isLoopback: boolean;
  ok: true;
}

export interface ResolveConfigError {
  exitCode: number;
  message: string;
  ok: false;
}

interface ReadConfigSuccess {
  config: Partial<GatewayConfig>;
  ok: true;
}

interface ReadConfigMissing {
  ok: false;
  reason: "missing";
}

interface ReadConfigInvalid {
  message: string;
  ok: false;
  reason: "invalid";
}

type ReadConfigResult =
  | ReadConfigInvalid
  | ReadConfigMissing
  | ReadConfigSuccess;

export function validateGatewayConfigSecurity(
  config: GatewayConfig,
): ResolveConfigError | null {
  const hasApiKey =
    typeof config.apiKey === "string" && config.apiKey.length > 0;
  if (!isLoopbackHost(config.bindAddress) && !hasApiKey) {
    return {
      exitCode: 2,
      message: `Non-loopback bind (${config.bindAddress}) requires \`apiKey\` in the config file (~/.pi/agent/gateway.json). The --api-key CLI flag is refused (argv leaks via /proc/<pid>/cmdline / ps aux).`,
      ok: false,
    };
  }
  if (config.requireKeyOnLoopback && !hasApiKey) {
    return {
      exitCode: 2,
      message:
        "requireKeyOnLoopback requires `apiKey` in ~/.pi/agent/gateway.json or PI_GATEWAY_API_KEY.",
      ok: false,
    };
  }
  return null;
}

export function resolveConfig(
  input: ResolveConfigInput,
): ResolveConfigResult | ResolveConfigError {
  const sources: string[] = ["defaults"];
  let merged: GatewayConfig = { ...DEFAULT_CONFIG };

  // Layer 1: ~/.pi/agent/gateway.json
  const piConfigPath = path.join(homedir(), ".pi", "agent", "gateway.json");
  const piConfig = readJsonIfExists(piConfigPath);
  if (piConfig.ok) {
    merged = mergeConfig(merged, piConfig.config);
    sources.push(piConfigPath);
  } else if (piConfig.reason === "invalid") {
    return { exitCode: 2, message: piConfig.message, ok: false };
  }

  // Layer 2: --config <path>
  if (input.cli.configPath) {
    const cliConfig = readJsonIfExists(input.cli.configPath);
    if (!cliConfig.ok) {
      return {
        exitCode: 2,
        message:
          cliConfig.reason === "missing"
            ? `Config file not found: ${input.cli.configPath}`
            : cliConfig.message,
        ok: false,
      };
    }
    merged = mergeConfig(merged, cliConfig.config);
    sources.push(input.cli.configPath);
  }

  // Layer 3: env vars
  const envOverrides = readEnvOverrides();
  if (Object.keys(envOverrides).length > 0) {
    merged = mergeConfig(merged, envOverrides);
    sources.push("env:PI_GATEWAY_*");
  }

  // Layer 4: CLI flags (highest priority)
  const cliOverrides = stripUndefined({
    allowedOrigins: input.cli.allowedOrigins,
    authDir: input.cli.authDir,
    bindAddress: input.cli.bindAddress,
    exposeOAuthSubscriptions: input.cli.exposeOAuthSubscriptions,
    logLevel: input.cli.logLevel,
    modelAllowlist: input.cli.modelAllowlist,
    modelDenylist: input.cli.modelDenylist,
    port: input.cli.port,
    requireKeyOnLoopback: input.cli.requireKeyOnLoopback,
  });
  if (Object.keys(cliOverrides).length > 0) {
    merged = mergeConfig(merged, cliOverrides);
    sources.push("cli");
  }

  const schemaError = validateGatewayConfigSchema(merged);
  if (schemaError) return schemaError;

  const securityError = validateGatewayConfigSecurity(merged);
  if (securityError) return securityError;

  const isLoopback = isLoopbackHost(merged.bindAddress);

  return { config: merged, configSources: sources, isLoopback, ok: true };
}

function validateGatewayConfigSchema(
  config: GatewayConfig,
): ResolveConfigError | null {
  if (Value.Check(GatewayConfigSchema, config)) return null;
  const errors = [...Value.Errors(GatewayConfigSchema, config)].slice(0, 5);
  const details = errors
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  return {
    exitCode: 2,
    message: `Invalid pi-gateway config: ${details}`,
    ok: false,
  };
}

function readJsonIfExists(filePath: string): ReadConfigResult {
  try {
    const raw = readFileSync(filePath, "utf8");
    return { config: JSON.parse(raw) as Partial<GatewayConfig>, ok: true };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, reason: "missing" };
    return {
      message: `Config file not readable or valid JSON: ${filePath}: ${e.message}`,
      ok: false,
      reason: "invalid",
    };
  }
}

function readEnvOverrides(): Partial<GatewayConfig> {
  const env = process.env;
  const out: Partial<GatewayConfig> = {};
  if (env.PI_GATEWAY_PORT) out.port = Number(env.PI_GATEWAY_PORT);
  if (env.PI_GATEWAY_BIND) out.bindAddress = env.PI_GATEWAY_BIND;
  if (env.PI_GATEWAY_API_KEY) out.apiKey = env.PI_GATEWAY_API_KEY;
  if (env.PI_GATEWAY_AUTH_DIR) out.authDir = env.PI_GATEWAY_AUTH_DIR;
  if (env.PI_GATEWAY_LOG_LEVEL) {
    const level = env.PI_GATEWAY_LOG_LEVEL.toLowerCase();
    if (
      level === "debug" ||
      level === "info" ||
      level === "warn" ||
      level === "error"
    ) {
      out.logLevel = level;
    }
  }
  if (env.PI_GATEWAY_EXPOSE_OAUTH) {
    out.exposeOAuthSubscriptions = env.PI_GATEWAY_EXPOSE_OAUTH === "true";
  }
  return out;
}

function mergeConfig(
  base: GatewayConfig,
  overrides: Partial<GatewayConfig>,
): GatewayConfig {
  const clean = stripUndefined(overrides) as Partial<GatewayConfig>;
  return { ...base, ...clean };
}

function stripUndefined<T extends Record<string, unknown>>(
  input: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
