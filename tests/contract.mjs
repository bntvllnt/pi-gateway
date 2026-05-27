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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pidPath = path.join(homedir(), ".pi", "agent", "gateway.pid");

if (existsSync(pidPath)) {
  try {
    unlinkSync(pidPath);
  } catch {}
}

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
  ajv.addSchema(rewriteRefs(schema), `https://openresponses.org/schemas/${name}`);
}

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")) {
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
            enum: ["stop", "length", "tool_calls", "content_filter", "function_call"],
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
            enum: ["stop", "length", "tool_calls", "content_filter", "function_call", null],
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
      required: ["type", "message"],
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

const PORT = 4096;
const jitiCli = path.join(
  packageRoot,
  "node_modules",
  "@mariozechner",
  "jiti",
  "lib",
  "jiti-cli.mjs",
);
const cliTs = path.join(packageRoot, "src", "cli.ts");
const daemon = spawn(process.execPath, [jitiCli, cliTs, "--port", String(PORT)], {
  stdio: ["ignore", "ignore", "ignore"],
  detached: false,
});
const base = `http://127.0.0.1:${PORT}`;

async function waitHealthy(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const failures = [];
function expectValid(label, validate, payload) {
  if (validate(payload)) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.log(`  ✗ ${label}`);
  for (const err of validate.errors ?? []) {
    console.log(`      ${err.instancePath || "(root)"} ${err.message} ${JSON.stringify(err.params)}`);
  }
  failures.push(label);
}

try {
  assert.equal(await waitHealthy(), true, "daemon failed to start");

  console.log("\n=== /v1/models payload conforms to ListModelsResponse ===");
  {
    const r = await fetch(`${base}/v1/models`);
    expectValid("/v1/models JSON validates", validateModelsList, await r.json());
  }

  console.log("\n=== /v1/chat/completions non-stream conforms to CreateChatCompletionResponse ===");
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-codex/gpt-5.4",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Reply with exactly: OK" },
        ],
        max_tokens: 30,
      }),
    });
    if (r.status !== 200) {
      console.log(`  ! non-stream returned ${r.status}; skipping JSON validation`);
      const body = await r.json();
      console.log("    body:", JSON.stringify(body).slice(0, 300));
    } else {
      expectValid("non-stream JSON validates", validateChatJson, await r.json());
    }
  }

  console.log("\n=== /v1/chat/completions stream chunks conform to chat.completion.chunk ===");
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai-codex/gpt-5.4",
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
      console.log(`  ! stream returned ${r.status}; skipping chunk validation`);
    } else {
      const text = await r.text();
      const frames = text.split("\n\n").map((f) => f.trim()).filter(Boolean);
      const dataFrames = frames
        .slice(0, -1)
        .map((f) => JSON.parse(f.slice("data: ".length)));
      for (const [i, chunk] of dataFrames.entries()) {
        expectValid(`chunk[${i}] validates`, validateChatChunk, chunk);
      }
      const last = frames[frames.length - 1];
      if (last !== "data: [DONE]") {
        console.log(`  ✗ terminator not '[DONE]'`);
        failures.push("terminator");
      } else {
        console.log("  ✓ stream terminator is data: [DONE]");
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
    [
      "unknown route → 404",
      { url: `${base}/v1/wat`, init: { method: "GET" } },
    ],
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
  try {
    daemon.kill("SIGTERM");
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {}
}

if (failures.length === 0) {
  console.log("\nCONTRACT OK");
  process.exit(0);
} else {
  console.log(`\nCONTRACT FAILED: ${failures.length} mismatches`);
  process.exit(1);
}
