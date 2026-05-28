#!/usr/bin/env node
/**
 * Security invariant tests for gateway startup surfaces.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import createJiti from "@mariozechner/jiti";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const gatewayEnvKeys = [
  "PI_GATEWAY_PORT",
  "PI_GATEWAY_BIND",
  "PI_GATEWAY_API_KEY",
  "PI_GATEWAY_AUTH_DIR",
  "PI_GATEWAY_LOG_LEVEL",
  "PI_GATEWAY_EXPOSE_OAUTH",
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const req = httpRequest(
      {
        headers: options.headers,
        hostname: "127.0.0.1",
        method: options.method ?? "GET",
        path: options.path ?? "/healthz",
        port,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function withIsolatedGatewayEnv(fn) {
  const oldHome = process.env.HOME;
  const oldEnv = new Map(gatewayEnvKeys.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(path.join(tmpdir(), "pi-gateway-home-"));
  process.env.HOME = home;
  for (const key of gatewayEnvKeys) delete process.env[key];
  try {
    await fn();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { force: true, recursive: true });
  }
}

async function testResolveConfigRequiresLoopbackKey() {
  const configModule = await jiti(path.join(packageRoot, "src", "config.ts"));
  await withIsolatedGatewayEnv(async () => {
    const result = configModule.resolveConfig({
      cli: { requireKeyOnLoopback: true },
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /requireKeyOnLoopback requires `apiKey`/);
  });
  await withIsolatedGatewayEnv(async () => {
    process.env.PI_GATEWAY_API_KEY = "test-key";
    const result = configModule.resolveConfig({
      cli: { requireKeyOnLoopback: true },
    });
    assert.equal(result.ok, true);
    assert.equal(result.config.apiKey, "test-key");
  });
  log("PASS requireKeyOnLoopback config preflight");
}

async function testInvalidConfigRejected() {
  const configModule = await jiti(path.join(packageRoot, "src", "config.ts"));
  await withIsolatedGatewayEnv(async () => {
    process.env.PI_GATEWAY_PORT = "not-a-number";
    const result = configModule.resolveConfig({ cli: {} });
    assert.equal(result.ok, false);
    assert.match(result.message, /Invalid pi-gateway config/);
    assert.match(result.message, /\/port/);
  });
  await withIsolatedGatewayEnv(async () => {
    const configPath = path.join(process.env.HOME, "bad.json");
    writeFileSync(configPath, "{not-json", "utf8");
    const result = configModule.resolveConfig({ cli: { configPath } });
    assert.equal(result.ok, false);
    assert.match(result.message, /Config file not readable or valid JSON/);
  });
  await withIsolatedGatewayEnv(async () => {
    const configDir = path.join(process.env.HOME, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "gateway.json"),
      JSON.stringify({ unknownKey: true }),
      "utf8",
    );
    const result = configModule.resolveConfig({ cli: {} });
    assert.equal(result.ok, false);
    assert.match(result.message, /Invalid pi-gateway config/);
    assert.match(result.message, /Unexpected property/);
  });
  log("PASS invalid config validation");
}

async function loadServerModules() {
  const serverModule = await jiti(
    path.join(packageRoot, "src", "server", "index.ts"),
  );
  const configModule = await jiti(path.join(packageRoot, "src", "config.ts"));
  return { configModule, serverModule };
}

async function testStartServerSecurityPreflight() {
  const { configModule, serverModule } = await loadServerModules();
  const baseConfig = {
    ...configModule.DEFAULT_CONFIG,
    apiKey: undefined,
    port: 0,
  };

  await assert.rejects(
    () =>
      serverModule.startServer({
        config: { ...baseConfig, bindAddress: "0.0.0.0" },
        log: () => {},
      }),
    /Non-loopback bind \(0\.0\.0\.0\) requires `apiKey`/,
  );

  await assert.rejects(
    () =>
      serverModule.startServer({
        config: { ...baseConfig, requireKeyOnLoopback: true },
        log: () => {},
      }),
    /requireKeyOnLoopback requires `apiKey`/,
  );

  const handle = await serverModule.startServer({
    config: { ...baseConfig, bindAddress: "127.0.0.1" },
    log: () => {},
  });
  try {
    assert.equal(handle.address.address, "127.0.0.1");
  } finally {
    await serverModule.stopServer(handle);
  }
  log("PASS startServer security preflight + bind assertion");
}

async function testLoopbackHostValidationAndTimeouts() {
  const { configModule, serverModule } = await loadServerModules();
  const handle = await serverModule.startServer({
    config: {
      ...configModule.DEFAULT_CONFIG,
      bindAddress: "127.0.0.1",
      port: 0,
    },
    log: () => {},
  });
  try {
    assert.equal(handle.server.headersTimeout, 30_000);
    assert.equal(handle.server.requestTimeout, 120_000);
    assert.equal(handle.server.keepAliveTimeout, 5_000);

    const rejected = await request(handle.address.port, {
      headers: { host: "evil.example" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(JSON.parse(rejected.body).error?.code, "invalid_host");

    const accepted = await request(handle.address.port, {
      headers: { host: `localhost:${handle.address.port}` },
    });
    assert.equal(accepted.status, 200);
  } finally {
    await serverModule.stopServer(handle);
  }
  log("PASS loopback Host validation + server timeouts");
}

async function testOversizedRequestBodyRejected() {
  const { configModule, serverModule } = await loadServerModules();
  const handle = await serverModule.startServer({
    config: {
      ...configModule.DEFAULT_CONFIG,
      bindAddress: "127.0.0.1",
      port: 0,
    },
    log: () => {},
  });
  try {
    const bigContent = "x".repeat(16 * 1024 * 1024);
    const response = await request(handle.address.port, {
      body: JSON.stringify({
        messages: [{ content: bigContent, role: "user" }],
        model: "totally-bogus-99",
      }),
      headers: {
        "content-type": "application/json",
        host: `127.0.0.1:${handle.address.port}`,
      },
      method: "POST",
      path: "/v1/chat/completions",
    });
    assert.equal(response.status, 413);
    assert.equal(
      JSON.parse(response.body).error?.code,
      "request_body_too_large",
    );
  } finally {
    await serverModule.stopServer(handle);
  }
  log("PASS oversized request body rejection");
}

async function testTranslationEdgeCases() {
  const { parseModelId } = await jiti(
    path.join(packageRoot, "src", "translate", "model-id.ts"),
  );
  const { RequestTranslationError, translateRequest } = await jiti(
    path.join(packageRoot, "src", "translate", "openai-to-pi.ts"),
  );
  assert.equal(parseModelId("provider/model:fp8").modelId, "model:fp8");
  assert.equal(parseModelId("provider/model:high").modelId, "model");
  assert.equal(parseModelId("provider/model:high").thinkingLevel, "high");

  const translated = translateRequest({
    messages: [
      {
        content: [
          { image_url: "data:text/plain,Hello%20world", type: "image_url" },
        ],
        role: "user",
      },
    ],
  });
  const content = translated.context.messages[0].content;
  assert.equal(content[0].data, Buffer.from("Hello world").toString("base64"));

  assert.throws(
    () =>
      translateRequest({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: "not-json", name: "bad" },
                id: "call_1",
                type: "function",
              },
            ],
          },
        ],
      }),
    RequestTranslationError,
  );
  log("PASS translation edge cases");
}

async function testUnsupportedOpenAIParametersRejected() {
  const { configModule, serverModule } = await loadServerModules();
  const handle = await serverModule.startServer({
    config: {
      ...configModule.DEFAULT_CONFIG,
      bindAddress: "127.0.0.1",
      port: 0,
    },
    log: () => {},
  });
  try {
    for (const param of ["stop", "response_format", "top_p"]) {
      const response = await request(handle.address.port, {
        body: JSON.stringify({
          [param]: param === "top_p" ? 1 : "x",
          messages: [{ content: "hi", role: "user" }],
          model: "totally-bogus-99",
        }),
        headers: {
          "content-type": "application/json",
          host: `127.0.0.1:${handle.address.port}`,
        },
        method: "POST",
        path: "/v1/chat/completions",
      });
      const body = JSON.parse(response.body);
      assert.equal(response.status, 400);
      assert.equal(body.error?.code, "unsupported_parameter");
      assert.equal(body.error?.param, param);
    }
  } finally {
    await serverModule.stopServer(handle);
  }
  log("PASS unsupported OpenAI parameter rejection");
}

function testCliInstallsSignalsBeforeListen() {
  const source = readFileSync(path.join(packageRoot, "src", "cli.ts"), "utf8");
  const installIndex = source.indexOf(
    "const removeSignalHandlers = installSignalHandlers",
  );
  const startIndex = source.indexOf("handle = await startServer");
  assert.notEqual(installIndex, -1, "CLI should install signal handlers");
  assert.notEqual(startIndex, -1, "CLI should start the server");
  assert.ok(
    installIndex < startIndex,
    "signal handlers must be installed before startServer/listen",
  );
  log("PASS CLI signal handler ordering");
}

async function main() {
  await testResolveConfigRequiresLoopbackKey();
  await testInvalidConfigRejected();
  await testStartServerSecurityPreflight();
  await testLoopbackHostValidationAndTimeouts();
  await testOversizedRequestBodyRejected();
  await testTranslationEdgeCases();
  await testUnsupportedOpenAIParametersRejected();
  testCliInstallsSignalsBeforeListen();
  log("ALL SECURITY TESTS PASSED");
}

main().catch((err) => {
  process.stderr.write(
    `SECURITY TESTS FAILED: ${err && err.stack ? err.stack : err}\n`,
  );
  process.exit(1);
});
