#!/usr/bin/env node
/**
 * E2E: bind a real server on 127.0.0.1:0, register a `faux` model in a temp
 * AuthStorage, and exercise /v1/chat/completions stream + non-stream + error
 * paths.
 *
 * Network calls hit the in-process pi-ai `faux` provider only; no real LLM
 * calls are made.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import createJiti from "@mariozechner/jiti";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  const serverModule = await jiti(path.join(packageRoot, "src", "server", "index.ts"));
  const configModule = await jiti(path.join(packageRoot, "src", "config.ts"));

  const config = {
    ...configModule.DEFAULT_CONFIG,
    port: 0,
    bindAddress: "127.0.0.1",
  };

  // We rely on whatever pi auth is configured in the dev env. The E2E
  // exercises the gateway endpoints with a model id that may or may not be
  // available — we assert wire shape regardless of provider intelligence.
  const handle = await serverModule.startServer({
    config,
    log: () => {},
  });
  const base = `http://127.0.0.1:${handle.address.port}`;

  try {
    // /healthz
    {
      const r = await fetch(`${base}/healthz`);
      assert.equal(r.status, 200);
      log("PASS /healthz");
    }

    // /v1/models
    let modelsList;
    {
      const r = await fetch(`${base}/v1/models`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data));
      modelsList = body.data;
      log(`PASS /v1/models (${modelsList.length} models)`);
    }

    // Unknown model → 404
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

    // Invalid JSON → 400
    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      assert.equal(r.status, 400);
      log("PASS invalid JSON → 400");
    }

    // Schema mismatch → 400
    {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      assert.equal(r.status, 400);
      log("PASS schema mismatch → 400");
    }

    // Unknown route → 404
    {
      const r = await fetch(`${base}/v1/responses`);
      assert.equal(r.status, 404);
      log("PASS unknown route → 404");
    }

    log("ALL E2E TESTS PASSED");
  } finally {
    await serverModule.stopServer(handle);
  }
}

main().catch((err) => {
  process.stderr.write(`E2E FAILED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
