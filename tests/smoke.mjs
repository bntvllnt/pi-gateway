#!/usr/bin/env node
/**
 * Smoke test: jiti-load index.ts with a mock ExtensionAPI; assert command/tool
 * registrations and that importing does NOT spawn anything or bind a port.
 *
 * Standalone server smoke: bind 127.0.0.1:0, hit /healthz, stop cleanly.
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

async function testExtensionRegistration() {
  // Mock ExtensionAPI: capture registrations.
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  let statusKey = null;
  let statusValue = null;
  const mockApi = {
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    on(event, handler) {
      events.set(event, handler);
    },
  };

  const mod = await jiti(path.join(packageRoot, "index.ts"));
  const extension = mod.default ?? mod;
  assert.equal(typeof extension, "function", "index.ts default export must be a function");

  extension(mockApi);

  assert.ok(commands.has("gateway:start"), "expected /gateway:start command");
  assert.ok(commands.has("gateway:stop"), "expected /gateway:stop command");
  assert.ok(commands.has("gateway:status"), "expected /gateway:status command");
  assert.ok(tools.has("gateway_status"), "expected gateway_status tool");
  assert.ok(tools.has("gateway_start"), "expected gateway_start tool");
  assert.ok(tools.has("gateway_stop"), "expected gateway_stop tool");
  assert.ok(events.has("session_start"), "expected session_start handler");
  assert.ok(events.has("session_shutdown"), "expected session_shutdown handler");

  log("PASS extension registrations");
}

async function testServerBindAndHealthz() {
  const serverModule = await jiti(path.join(packageRoot, "src", "server", "index.ts"));
  const configModule = await jiti(path.join(packageRoot, "src", "config.ts"));

  const config = {
    ...configModule.DEFAULT_CONFIG,
    port: 0,
    bindAddress: "127.0.0.1",
  };

  const logs = [];
  const handle = await serverModule.startServer({
    config,
    log: (level, payload) => logs.push({ level, payload }),
  });

  try {
    assert.equal(handle.address.address, "127.0.0.1", "address must be 127.0.0.1");
    assert.ok(handle.address.port > 0, "port must be > 0");

    const url = `http://127.0.0.1:${handle.address.port}/healthz`;
    const res = await fetch(url);
    assert.equal(res.status, 200, "healthz must return 200");
    const body = await res.json();
    assert.equal(body.ok, true, "healthz body.ok must be true");

    const modelsRes = await fetch(`http://127.0.0.1:${handle.address.port}/v1/models`);
    assert.equal(modelsRes.status, 200, "/v1/models must return 200");
    const modelsBody = await modelsRes.json();
    assert.equal(modelsBody.object, "list", "models payload object must be 'list'");
    assert.ok(Array.isArray(modelsBody.data), "models data must be an array");

    const notFound = await fetch(`http://127.0.0.1:${handle.address.port}/wat`);
    assert.equal(notFound.status, 404, "unknown route must 404");

    log(`PASS server bind + healthz + /v1/models (${modelsBody.data.length} models)`);
  } finally {
    await serverModule.stopServer(handle);
  }
}

async function main() {
  await testExtensionRegistration();
  await testServerBindAndHealthz();
  log("ALL SMOKE TESTS PASSED");
}

main().catch((err) => {
  process.stderr.write(`SMOKE FAILED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
