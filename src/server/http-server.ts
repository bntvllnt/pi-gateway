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

import type {
  AssistantMessageEventStream,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { complete, stream as piStream } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { type GatewayConfig, isLoopbackHost } from "../config.js";
import { ChatCompletionRequest } from "../protocol/chat-completions.js";
import {
  buildModelsList,
  OAUTH_SUBSCRIPTION_PROVIDERS,
} from "../protocol/models-list.js";
import { resolveModel } from "../translate/model-id.js";
import {
  RequestTranslationError,
  translateRequest,
} from "../translate/openai-to-pi.js";
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

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const SERVER_HEADERS_TIMEOUT_MS = 30_000;
const SERVER_REQUEST_TIMEOUT_MS = 120_000;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5000;
const UNSUPPORTED_CHAT_PARAMETERS = [
  "frequency_penalty",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "top_p",
  "user",
] as const;

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
  const isLoopback = isLoopbackHost(deps.config.bindAddress);

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
            param: null,
            type: "server_error",
          },
        });
      }
    });
  });
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const safeHeaders = pickSafeHeaders(req);

    setCors(req, res, deps.config.allowedOrigins);

    if (isLoopback && !isAllowedLoopbackHost(req.headers.host)) {
      sendJson(res, 403, {
        error: {
          code: "invalid_host",
          message: "Invalid Host header for loopback pi-gateway request.",
          param: "host",
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method,
        safeHeaders,
        status: 403,
        url,
      });
      return;
    }

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
            param: null,
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
      const tooLarge = error instanceof RequestBodyTooLargeError;
      const status = tooLarge ? 413 : 400;
      if (tooLarge) req.resume();
      sendJson(res, status, {
        error: {
          code: tooLarge ? "request_body_too_large" : "body_read_error",
          message: tooLarge
            ? `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`
            : `Failed to read request body: ${String(error)}`,
          param: null,
          type: "invalid_request_error",
        },
      });
      logRequest(deps, "warn", {
        durationMs: Date.now() - started,
        method: "POST",
        safeHeaders,
        status,
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
          param: null,
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
          param: null,
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
      max_completion_tokens?: number;
      max_tokens?: number;
      messages: unknown[];
      model: string;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
      temperature?: number;
      tool_choice?: unknown;
      tools?: unknown;
    };

    const unsupportedParam = findUnsupportedParameter(body);
    if (unsupportedParam) {
      sendJson(res, 400, {
        error: {
          code: "unsupported_parameter",
          message: `OpenAI parameter '${unsupportedParam}' is not supported by pi-gateway yet.`,
          param: unsupportedParam,
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

    const generationOptions = buildGenerationOptions(parsed);

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
      (OAUTH_SUBSCRIPTION_PROVIDERS.has(model.provider) ||
        deps.modelRegistry.isUsingOAuth(model))
    ) {
      sendJson(res, 403, {
        error: {
          code: "subscription_exposure_disabled",
          message: `Provider '${model.provider}' is an OAuth subscription. Non-loopback binds require --expose-oauth-subscriptions or exposeOAuthSubscriptions: true in config.`,
          param: "model",
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
          param: "model",
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

    let translated: ReturnType<typeof translateRequest>;
    try {
      translated = translateRequest({
        messages: parsed.messages as never,
        tools: parsed.tools as never,
      });
    } catch (error) {
      if (!(error instanceof RequestTranslationError)) throw error;
      sendJson(res, 400, {
        error: {
          code: error.code,
          message: error.message,
          param: error.param,
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
          ...generationOptions,
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
              param: null,
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
          ...generationOptions,
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
        });
        await pipeStreamToSse(
          {
            created: nowSeconds(),
            id,
            includeUsage: parsed.stream_options?.include_usage === true,
            modelLabel,
          },
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
            param: null,
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

function findUnsupportedParameter(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const param of UNSUPPORTED_CHAT_PARAMETERS) {
    if (record[param] !== undefined) return param;
  }
  const toolChoice = record.tool_choice;
  if (
    toolChoice !== undefined &&
    toolChoice !== "auto" &&
    toolChoice !== "none" &&
    toolChoice !== "required"
  ) {
    return "tool_choice";
  }
  return null;
}

function buildGenerationOptions(input: {
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  tool_choice?: unknown;
}): ProviderStreamOptions {
  const options: ProviderStreamOptions = {};
  if (input.temperature !== undefined) options.temperature = input.temperature;
  const maxTokens = input.max_completion_tokens ?? input.max_tokens;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  if (input.tool_choice !== undefined) options.toolChoice = input.tool_choice;
  return options;
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

function isAllowedLoopbackHost(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  const host = parseHostName(raw);
  return host !== null && isLoopbackHost(host);
}

function parseHostName(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    return stripTrailingDot(value.slice(1, end));
  }
  const colon = value.indexOf(":");
  const host = colon === -1 ? value : value.slice(0, colon);
  return stripTrailingDot(host);
}

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

class RequestBodyTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    readonly receivedBytes: number,
  ) {
    super(
      `Request body exceeds ${limitBytes} bytes (${receivedBytes} received)`,
    );
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        settleReject(
          new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES, receivedBytes),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error): void => {
      settleReject(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function logRequest(
  deps: HttpServerDeps,
  level: "debug" | "info" | "warn" | "error",
  payload: Record<string, unknown>,
): void {
  deps.log(level, { kind: "access", ...payload });
}
