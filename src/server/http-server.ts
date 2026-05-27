/**
 * pi-gateway HTTP server. node:http only; no Express/Fastify.
 *
 * Routes:
 *   - OPTIONS *                  CORS preflight
 *   - GET     /healthz           liveness
 *   - GET     /v1/models         OpenAI-compat models list
 *   - POST    /v1/chat/completions  OpenAI-compat chat completions (stream + non-stream)
 *
 * Auth gate: bearer Authorization header required unless bind is loopback
 * (and `requireKeyOnLoopback` is false). Constant-time compare.
 *
 * Access log: structured JSON to stderr; hardcoded redaction allowlist for
 * safe headers (`content-type`, `content-length`, `user-agent`, `accept`,
 * `accept-encoding`). Everything else is redacted.
 */
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { complete, stream as piStream } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import type { GatewayConfig } from "../config.js";
import { ChatCompletionRequest } from "../protocol/chat-completions.js";
import { buildModelsList } from "../protocol/models-list.js";
import { resolveModel } from "../translate/model-id.js";
import { translateRequest } from "../translate/openai-to-pi.js";
import {
  newChatCompletionId,
  nowSeconds,
  pipeStreamToSse,
  type SseEmitter,
  translateResponse,
} from "../translate/pi-to-openai.js";

const SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "accept-encoding",
  "host",
]);

export interface HttpServerDeps {
  config: GatewayConfig;
  log: (
    level: "debug" | "info" | "warn" | "error",
    payload: Record<string, unknown>,
  ) => void;
  modelRegistry: ModelRegistry;
}

export interface RunningServer {
  abortAllStreams(): void;
  activeStreamCount(): number;
  server: Server;
}

export function createHttpServer(deps: HttpServerDeps): RunningServer {
  const inFlightAborts = new Set<AbortController>();
  const isLoopback =
    deps.config.bindAddress === "127.0.0.1" ||
    deps.config.bindAddress === "::1" ||
    deps.config.bindAddress === "localhost";

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      deps.log("error", {
        error: String(error),
        msg: "unhandled handler error",
      });
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      } else {
        sendJson(res, 500, {
          error: {
            code: "internal_error",
            message: "internal server error",
            type: "server_error",
          },
        });
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const safeHeaders = pickSafeHeaders(req);

    setCors(req, res, deps.config.allowedOrigins);

    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      logRequest(deps, "info", {
        durationMs: Date.now() - started,
        method,
        safeHeaders,
        status: 204,
        url,
      });
      return;
    }

    // Auth gate: required when bind is non-loopback, OR when
    // requireKeyOnLoopback is true.
    const needsAuth =
      (!isLoopback || deps.config.requireKeyOnLoopback) &&
      typeof deps.config.apiKey === "string" &&
      deps.config.apiKey.length > 0;
    if (needsAuth) {
      const provided = parseBearer(req.headers.authorization);
      if (!provided || !constantTimeCompare(provided, deps.config.apiKey!)) {
        sendJson(res, 401, {
          error: {
            code: "invalid_api_key",
            message: "Missing or invalid bearer token.",
            type: "authentication_error",
          },
        });
        logRequest(deps, "warn", {
          durationMs: Date.now() - started,
          method,
          safeHeaders,
          status: 401,
          url,
        });
        return;
      }
    }

    if (method === "GET" && (url === "/healthz" || url === "/health")) {
      sendJson(res, 200, {
        ok: true,
        uptimeMs: Math.round(process.uptime() * 1000),
      });
      logRequest(deps, "info", {
        durationMs: Date.now() - started,
        method,
        safeHeaders,
        status: 200,
        url,
      });
      return;
    }

    if (method === "GET" && (url === "/v1/models" || url === "/models")) {
      const list = buildModelsList({
        allowlist: deps.config.modelAllowlist,
        denylist: deps.config.modelDenylist,
        exposeOAuthSubscriptions: deps.config.exposeOAuthSubscriptions,
        isLoopback,
        isUsingOAuth: (m) => deps.modelRegistry.isUsingOAuth(m),
        models: deps.modelRegistry.getAvailable(),
      });
      sendJson(res, 200, { data: list, object: "list" });
      logRequest(deps, "info", {
        count: list.length,
        durationMs: Date.now() - started,
        method,
        safeHeaders,
        status: 200,
        url,
      });
      return;
    }

    if (
      method === "POST" &&
      (url === "/v1/chat/completions" || url === "/chat/completions")
    ) {
      await handleChatCompletions(req, res, started, safeHeaders);
      return;
    }

    sendJson(res, 404, {
      error: {
        code: "endpoint_not_found",
        message: `Unknown endpoint: ${method} ${url}`,
        param: null,
        type: "invalid_request_error",
      },
    });
    logRequest(deps, "info", {
      durationMs: Date.now() - started,
      method,
      safeHeaders,
      status: 404,
      url,
    });
  }

  async function handleChatCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    started: number,
    safeHeaders: Record<string, string>,
  ): Promise<void> {
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: {
          code: "body_read_error",
          message: `Failed to read request body: ${String(error)}`,
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 400,
        url: req.url ?? "",
      });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, {
        error: {
          code: "invalid_json",
          message: "Request body is not valid JSON",
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 400,
        url: req.url ?? "",
      });
      return;
    }

    // Lazy import @sinclair/typebox's Value for fast guard (we already imported
    // the schema for types). Use TypeBox Value at runtime.
    const { Value } = await import("@sinclair/typebox/value");
    if (!Value.Check(ChatCompletionRequest, body)) {
      const errors = [...Value.Errors(ChatCompletionRequest, body)].slice(0, 5);
      sendJson(res, 400, {
        error: {
          code: "schema_validation_failed",
          details: errors.map((e) => ({ message: e.message, path: e.path })),
          message: "Request does not match the OpenAI Chat Completions schema",
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 400,
        url: req.url ?? "",
      });
      return;
    }

    const parsed = body as {
      messages: unknown[];
      model: string;
      stream?: boolean;
      tools?: unknown;
    };

    const isUsingOAuthGate = (provider: string): boolean => {
      // Check membership; the lookup is also done in models-list.ts.
      const oauthSet = new Set([
        "anthropic",
        "claude-code",
        "openai-codex",
        "github-copilot",
        "google-gemini-cli",
        "google-antigravity",
      ]);
      return oauthSet.has(provider);
    };

    const model = resolveModel(deps.modelRegistry, parsed.model);
    if (!model) {
      sendJson(res, 404, {
        error: {
          code: "model_not_found",
          message: `Unknown model '${parsed.model}'. Hit GET /v1/models for the available list.`,
          param: "model",
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 404,
        url: req.url ?? "",
      });
      return;
    }

    // OAuth-subscription gate on non-loopback.
    if (
      !isLoopback &&
      !deps.config.exposeOAuthSubscriptions &&
      (isUsingOAuthGate(model.provider) ||
        deps.modelRegistry.isUsingOAuth(model))
    ) {
      sendJson(res, 403, {
        error: {
          code: "subscription_exposure_disabled",
          message: `Provider '${model.provider}' is an OAuth subscription. Non-loopback binds require --expose-oauth-subscriptions or exposeOAuthSubscriptions: true in config.`,
          type: "permission_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 403,
        url: req.url ?? "",
      });
      return;
    }

    // Resolve auth.
    const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      sendJson(res, 401, {
        error: {
          code: "no_credentials",
          message: `No credentials for provider '${model.provider}': ${auth.error}`,
          type: "authentication_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status: 401,
        url: req.url ?? "",
      });
      return;
    }

    const translated = translateRequest({
      messages: parsed.messages as never,
      tools: parsed.tools as never,
    });

    const controller = new AbortController();
    inFlightAborts.add(controller);
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const wantsStream = parsed.stream === true;
    const id = newChatCompletionId();
    const modelLabel = `${model.provider}/${model.id}`;

    try {
      if (!wantsStream) {
        const result = await complete(model, translated.context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
        });
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          const status = result.stopReason === "aborted" ? 499 : 502;
          sendJson(res, status, {
            error: {
              code:
                result.stopReason === "aborted"
                  ? "client_disconnected"
                  : "provider_error",
              message:
                result.errorMessage ??
                `Upstream returned ${result.stopReason} with no content`,
              type:
                result.stopReason === "aborted"
                  ? "request_aborted"
                  : "upstream_error",
            },
          });
          logRequest(deps, "warn", {
            durationMs: Date.now() - started,
            method: "POST",
            model: modelLabel,
            safeHeaders,
            status,
            url: req.url ?? "",
          });
          return;
        }
        const payload = translateResponse({ id, message: result, modelLabel });
        sendJson(res, 200, payload);
        logRequest(deps, "info", {
          durationMs: Date.now() - started,
          method: "POST",
          model: modelLabel,
          safeHeaders,
          status: 200,
          url: req.url ?? "",
        });
        return;
      }

      // Streaming response.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const sseEmitter = makeSseEmitter(res);

      // Heartbeat during silent periods (e.g., Claude extended-thinking).
      const heartbeatTimer = setInterval(() => {
        if (res.writableEnded) return;
        try {
          res.write(`: heartbeat\n\n`);
        } catch {
          /* socket closed */
        }
      }, deps.config.heartbeatIntervalMs);

      let upstream: AssistantMessageEventStream | null = null;
      try {
        upstream = piStream(model, translated.context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
        });
        await pipeStreamToSse(
          { created: nowSeconds(), id, modelLabel },
          upstream,
          sseEmitter,
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.writableEnded) {
          sseEmitter.emitError({
            code: controller.signal.aborted
              ? "client_disconnected"
              : "provider_error",
            message,
            type: controller.signal.aborted
              ? "request_aborted"
              : "upstream_error",
          });
        }
      } finally {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      }
      logRequest(deps, "info", {
        durationMs: Date.now() - started,
        method: "POST",
        model: modelLabel,
        safeHeaders,
        status: 200,
        stream: true,
        url: req.url ?? "",
      });
    } finally {
      inFlightAborts.delete(controller);
    }
  }

  return {
    abortAllStreams: () => {
      for (const ctrl of inFlightAborts) ctrl.abort();
      inFlightAborts.clear();
    },
    activeStreamCount: () => inFlightAborts.size,
    server,
  };
}

function makeSseEmitter(res: ServerResponse): SseEmitter {
  return {
    done() {
      if (res.writableEnded) return;
      try {
        res.write(`data: [DONE]\n\n`);
      } catch {
        /* socket closed */
      }
    },
    emitError(error) {
      if (res.writableEnded) return;
      try {
        // OpenAI mid-stream error convention: emit error frame then close.
        // Do NOT emit `data: [DONE]\n\n` after — that would signal normal
        // completion to clients like Open WebUI.
        res.write(`data: ${JSON.stringify({ error })}\n\n`);
      } catch {
        /* socket closed */
      }
    },
    write(payload) {
      if (res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* socket closed */
      }
    },
    writeRaw(text) {
      if (res.writableEnded) return;
      try {
        res.write(text);
      } catch {
        /* socket closed */
      }
    },
  };
}

function setCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    return;
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, OpenAI-Beta",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseBearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

function constantTimeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function pickSafeHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (!SAFE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function logRequest(
  deps: HttpServerDeps,
  level: "debug" | "info" | "warn" | "error",
  payload: Record<string, unknown>,
): void {
  deps.log(level, { kind: "access", ...payload });
}
