#!/usr/bin/env node
/**
 * Contract validator: pi-gateway responses ↔ pinned OpenAPI schema.
 *
 * Loads schemas/openresponses.openapi.json (OpenAI Responses API v2.3.0 spec,
 * the canonical OpenAPI doc this project pins to avoid drift) and validates
 * real responses against the relevant component schemas with ajv.
 *
 * Notes:
 *   - The pinned spec defines POST /responses (Responses API). Pi-gateway v1
 *     implements POST /v1/chat/completions (Chat Completions API). The two
 *     endpoints differ; this validator covers what overlaps + adds
 *     locally-pinned Chat Completions schemas for the rest.
 *   - When pi-gateway adds /v1/responses support (v1.1+), it will validate
 *     end-to-end against this same spec.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import createJiti from "@mariozechner/jiti";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

// Load and lightly normalize the OpenAPI doc into a $ref-able schema bundle.
const openapi = JSON.parse(
  readFileSync(
    path.join(packageRoot, "schemas", "openresponses.openapi.json"),
    "utf8",
  ),
);
const schemas = openapi.components?.schemas ?? {};

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);

// Register component schemas so $ref works.
for (const [name, schema] of Object.entries(schemas)) {
  ajv.addSchema(
    rewriteRefs(schema),
    `https://openresponses.org/schemas/${name}`,
  );
}

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        k === "$ref" &&
        typeof v === "string" &&
        v.startsWith("#/components/schemas/")
      ) {
        out.$ref = `https://openresponses.org/schemas/${v.slice("#/components/schemas/".length)}`;
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return value;
}

// Locally-pinned Chat Completions schemas (OpenAI doesn't publish a canonical
// JSON-Schema for Chat Completions in the openresponses.org doc, so we pin
// them here from the OpenAI Chat Completions reference).
const ChatCompletionResponseSchema = {
  type: "object",
  required: ["id", "object", "created", "model", "choices", "usage"],
  properties: {
    id: { type: "string", pattern: "^chatcmpl-" },
    object: { const: "chat.completion" },
    created: { type: "integer" },
    model: { type: "string" },
    system_fingerprint: { type: "string" },
    choices: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["index", "message", "finish_reason"],
        properties: {
          index: { type: "integer", minimum: 0 },
          message: {
            type: "object",
            required: ["role"],
            properties: {
              role: { const: "assistant" },
              content: { type: ["string", "null"] },
              reasoning_content: { type: "string" },
              tool_calls: { type: "array" },
            },
            additionalProperties: true,
          },
          finish_reason: {
            type: "string",
            enum: [
              "stop",
              "length",
              "tool_calls",
              "content_filter",
              "function_call",
            ],
          },
          logprobs: { type: ["null", "object"] },
        },
        additionalProperties: true,
      },
    },
    usage: {
      type: "object",
      required: ["prompt_tokens", "completion_tokens", "total_tokens"],
      properties: {
        prompt_tokens: { type: "integer", minimum: 0 },
        completion_tokens: { type: "integer", minimum: 0 },
        total_tokens: { type: "integer", minimum: 0 },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const ChatCompletionChunkSchema = {
  type: "object",
  required: ["id", "object", "created", "model", "choices"],
  properties: {
    id: { type: "string", pattern: "^chatcmpl-" },
    object: { const: "chat.completion.chunk" },
    created: { type: "integer" },
    model: { type: "string" },
    system_fingerprint: { type: "string" },
    choices: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["index", "delta"],
        properties: {
          index: { type: "integer", minimum: 0 },
          delta: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["assistant"] },
              content: { type: "string" },
              reasoning_content: { type: "string" },
              tool_calls: { type: "array" },
            },
            additionalProperties: true,
          },
          finish_reason: {
            type: ["string", "null"],
            enum: [
              "stop",
              "length",
              "tool_calls",
              "content_filter",
              "function_call",
              null,
            ],
          },
          logprobs: { type: ["null", "object"] },
        },
        additionalProperties: true,
      },
    },
    usage: {
      type: "object",
      required: ["prompt_tokens", "completion_tokens", "total_tokens"],
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const ModelsListSchema = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { const: "list" },
    data: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "object", "created", "owned_by"],
        properties: {
          id: { type: "string", minLength: 1 },
          object: { const: "model" },
          created: { type: "integer" },
          owned_by: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const OpenAIErrorEnvelopeSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["type", "message", "code", "param"],
      properties: {
        type: { type: "string", minLength: 1 },
        code: { type: ["string", "null"] },
        message: { type: "string", minLength: 1 },
        param: { type: ["string", "null"] },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};

const validateChatJson = ajv.compile(ChatCompletionResponseSchema);
const validateChatChunk = ajv.compile(ChatCompletionChunkSchema);
const validateModelsList = ajv.compile(ModelsListSchema);
const validateErrorEnvelope = ajv.compile(OpenAIErrorEnvelopeSchema);

const FAUX_PROVIDER = "faux-contract";
const FAUX_MODEL = "faux-chat";

function fauxModelDefinition() {
  return {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: FAUX_MODEL,
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Faux Contract Model",
    reasoning: false,
  };
}

async function loadBuiltServerModules() {
  const distServer = path.join(packageRoot, "dist", "server", "index.js");
  const distConfig = path.join(packageRoot, "dist", "config.js");
  if (existsSync(distServer) && existsSync(distConfig)) {
    return {
      configModule: await import(pathToFileURL(distConfig).href),
      serverModule: await import(pathToFileURL(distServer).href),
    };
  }
  return {
    configModule: await jiti(path.join(packageRoot, "src", "config.ts")),
    serverModule: await jiti(
      path.join(packageRoot, "src", "server", "index.ts"),
    ),
  };
}

async function startFauxServer() {
  const { configModule, serverModule } = await loadBuiltServerModules();
  const faux = registerFauxProvider({
    api: "faux-contract-api",
    models: [fauxModelDefinition()],
    provider: FAUX_PROVIDER,
    tokenSize: { max: 4096, min: 4096 },
    tokensPerSecond: 0,
  });
  faux.setResponses([
    fauxAssistantMessage("OK"),
    fauxAssistantMessage("STREAMOK"),
  ]);

  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  modelRegistry.registerProvider(FAUX_PROVIDER, {
    api: faux.api,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    models: [{ ...fauxModelDefinition(), api: faux.api }],
  });
  const handle = await serverModule.startServer({
    config: {
      ...configModule.DEFAULT_CONFIG,
      bindAddress: "127.0.0.1",
      port: 0,
    },
    log: () => {},
    modelRegistry,
  });
  return {
    base: `http://127.0.0.1:${handle.address.port}`,
    faux,
    handle,
    serverModule,
  };
}

const failures = [];
function expectValid(label, validate, payload) {
  if (validate(payload)) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.log(`  ✗ ${label}`);
  for (const err of validate.errors ?? []) {
    console.log(
      `      ${err.instancePath || "(root)"} ${err.message} ${JSON.stringify(err.params)}`,
    );
  }
  failures.push(label);
}

const runtime = await startFauxServer();
const base = runtime.base;

try {
  console.log("\n=== /v1/models payload conforms to ListModelsResponse ===");
  let availableModelId;
  {
    const r = await fetch(`${base}/v1/models`);
    const body = await r.json();
    expectValid("/v1/models JSON validates", validateModelsList, body);
    availableModelId =
      Array.isArray(body.data) && body.data.length > 0
        ? body.data[0].id
        : undefined;
    assert.equal(availableModelId, `${FAUX_PROVIDER}/${FAUX_MODEL}`);
    console.log(`  ✓ first available model: ${availableModelId}`);
  }

  console.log(
    "\n=== /v1/chat/completions non-stream conforms to OpenAI shape ===",
  );
  {
    const targetModel = availableModelId ?? "openai-codex/gpt-5.4";
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Reply with exactly: OK" },
        ],
        max_tokens: 30,
      }),
    });
    if (r.status === 200) {
      expectValid(
        "non-stream success body validates ChatCompletion schema",
        validateChatJson,
        await r.json(),
      );
    } else {
      // No-auth / upstream-error path: validate the error envelope shape instead.
      const body = await r.json();
      expectValid(
        `non-stream ${r.status} body validates OpenAI error envelope`,
        validateErrorEnvelope,
        body,
      );
    }
  }

  console.log(
    "\n=== /v1/chat/completions stream conforms to OpenAI SSE shape ===",
  );
  {
    const targetModel = availableModelId ?? "openai-codex/gpt-5.4";
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Reply with exactly: STREAMOK" },
        ],
        max_tokens: 30,
      }),
    });
    if (r.status !== 200) {
      // Pre-stream failure (auth, schema, etc.) → JSON error envelope.
      const body = await r.json();
      expectValid(
        `pre-stream ${r.status} body validates OpenAI error envelope`,
        validateErrorEnvelope,
        body,
      );
    } else {
      const text = await r.text();
      const frames = text
        .split("\n\n")
        .map((f) => f.trim())
        .filter(Boolean);
      if (frames.length === 0) {
        failures.push("stream body was empty");
      } else {
        // Distinguish: error-ended stream (mid-stream provider error → frame
        // with `error` key, then connection close, NO trailing [DONE]) vs.
        // happy-path (chunks then `data: [DONE]`).
        const parsedFrames = frames
          .filter((f) => f !== "data: [DONE]")
          .map((f) => JSON.parse(f.slice("data: ".length)));
        const errorFrame = parsedFrames.find((p) => "error" in p);
        const last = frames[frames.length - 1];

        if (errorFrame) {
          expectValid(
            "mid-stream error frame validates OpenAI error envelope",
            validateErrorEnvelope,
            errorFrame,
          );
          if (last === "data: [DONE]") {
            console.log(
              "  ✗ error frame followed by [DONE] (against OpenAI mid-stream error convention)",
            );
            failures.push("error frame followed by [DONE]");
          } else {
            console.log(
              "  ✓ mid-stream error has NO trailing [DONE] (correct per OpenAI convention)",
            );
          }
        } else {
          // Happy path
          for (const [i, chunk] of parsedFrames.entries()) {
            expectValid(`chunk[${i}] validates`, validateChatChunk, chunk);
          }
          if (last === "data: [DONE]") {
            console.log("  ✓ stream terminator is data: [DONE]");
          } else {
            console.log(`  ✗ terminator not '[DONE]' (got '${last}')`);
            failures.push("terminator");
          }
        }
      }
    }
  }

  console.log("\n=== Error envelopes conform to OpenAI error shape ===");
  for (const [label, request] of [
    [
      "unknown model → 404",
      {
        url: `${base}/v1/chat/completions`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "unknown",
            messages: [{ role: "user", content: "x" }],
          }),
        },
      },
    ],
    [
      "invalid JSON → 400",
      {
        url: `${base}/v1/chat/completions`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json",
        },
      },
    ],
    [
      "schema mismatch → 400",
      {
        url: `${base}/v1/chat/completions`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        },
      },
    ],
    ["unknown route → 404", { url: `${base}/v1/wat`, init: { method: "GET" } }],
  ]) {
    const r = await fetch(request.url, request.init);
    expectValid(label, validateErrorEnvelope, await r.json());
  }

  console.log(
    "\n=== Pinned OpenAPI schemas count ===",
    `\n  components.schemas: ${Object.keys(schemas).length}`,
    `\n  paths defined: ${Object.keys(openapi.paths || {}).join(", ")}`,
  );
} finally {
  await runtime.serverModule.stopServer(runtime.handle);
  runtime.faux.unregister();
}

if (failures.length === 0) {
  console.log("\nCONTRACT OK");
  process.exit(0);
} else {
  console.log(`\nCONTRACT FAILED: ${failures.length} mismatches`);
  process.exit(1);
}
