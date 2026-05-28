#!/usr/bin/env node
/**
 * E2E: bind a real server on 127.0.0.1:0 with a deterministic `faux` model
 * and exercise /v1/chat/completions stream + non-stream + error paths.
 *
 * Network calls hit the in-process pi-ai `faux` provider only; no real LLM
 * calls are made.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import createJiti from "@mariozechner/jiti";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const FAUX_PROVIDER = "faux-e2e";
const FAUX_MODEL = "faux-chat";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fauxModelDefinition() {
  return {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: FAUX_MODEL,
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Faux E2E Model",
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

async function main() {
  const { configModule, serverModule } = await loadBuiltServerModules();
  const faux = registerFauxProvider({
    api: "faux-e2e-api",
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

  const config = {
    ...configModule.DEFAULT_CONFIG,
    bindAddress: "127.0.0.1",
    port: 0,
  };

  const handle = await serverModule.startServer({
    config,
    log: () => {},
    modelRegistry,
  });
  const base = `http://127.0.0.1:${handle.address.port}`;
  const model = `${FAUX_PROVIDER}/${FAUX_MODEL}`;

  try {
    {
      const r = await fetch(`${base}/healthz`);
      assert.equal(r.status, 200);
      log("PASS /healthz");
    }

    {
      const r = await fetch(`${base}/v1/models`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.object, "list");
      assert.deepEqual(
        body.data.map((entry) => entry.id),
        [model],
      );
      log(`PASS /v1/models (${body.data.length} models)`);
    }

    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 30,
          messages: [{ content: "Say OK", role: "user" }],
          model,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.choices[0].message.content, "OK");
      log("PASS non-stream chat completion");
    }

    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        body: JSON.stringify({
          max_tokens: 30,
          messages: [{ content: "Say STREAMOK", role: "user" }],
          model,
          stream: true,
          stream_options: { include_usage: true },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.match(text, /STREAMOK/);
      assert.match(text, /data: \[DONE\]/);
      log("PASS stream chat completion");
    }

    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "totally-bogus-99",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(r.status, 404);
      const body = await r.json();
      assert.equal(body.error?.code, "model_not_found");
      log("PASS unknown model → 404");
    }

    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      assert.equal(r.status, 400);
      log("PASS invalid JSON → 400");
    }

    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      assert.equal(r.status, 400);
      log("PASS schema mismatch → 400");
    }

    {
      const r = await fetch(`${base}/v1/responses`);
      assert.equal(r.status, 404);
      log("PASS unknown route → 404");
    }

    log("ALL E2E TESTS PASSED");
  } finally {
    await serverModule.stopServer(handle);
    faux.unregister();
  }
}

main().catch((err) => {
  process.stderr.write(`E2E FAILED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
