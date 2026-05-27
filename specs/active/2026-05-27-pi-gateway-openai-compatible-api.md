---
title: Pi Gateway — OpenAI-Compatible Local API (LiteLLM-style daemon)
status: active
created: 2026-05-27
estimate: 16h
tier: standard
---

# Pi Gateway — OpenAI-Compatible Local API

## Context

`@mariozechner/pi-coding-agent` already brokers every popular LLM provider (Anthropic, OpenAI, Google, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, Hugging Face, ZAI, MiniMax, OpenCode, OpenCode Go, Kimi For Coding, Bedrock, Vertex, Azure OpenAI Responses) and resolves API keys / OAuth tokens / token refresh through `AuthStorage` + `ModelRegistry`. It also handles OAuth subscriptions for Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot, Google Gemini CLI, Google Antigravity — none of which are reachable via LiteLLM today. Pi-ai exposes `complete()` / `stream()` against any `Model`.

Build a **standalone Node.js CLI daemon** named `pi-gateway` that:

- runs in the foreground like LiteLLM / uvicorn / vLLM (`pi-gateway --port 4000`),
- serves an OpenAI-compatible HTTP API faithful to what Open WebUI / LibreChat / LiteLLM / Cursor / Continue.dev / Cline actually call: `POST /v1/chat/completions`, `GET /v1/models`, `GET /healthz`,
- uses `@mariozechner/pi-coding-agent` ONLY as a library for `AuthStorage` + `ModelRegistry`, and `@mariozechner/pi-ai` ONLY for `complete()` / `stream()` against a `Model`,
- never creates a pi `AgentSession`, never loads tools/skills/extensions, never injects a system prompt, never persists conversation state.

Each request is independent: validate Chat Completions schema → resolve `Model` via `ModelRegistry.find(provider, id)` → translate OpenAI messages into pi-ai `Context` → resolve auth via `modelRegistry.getApiKeyAndHeaders(model)` → call `stream(model, ctx, { apiKey, headers, signal })` or `complete(...)` → translate the pi-ai assistant message / event stream back into OpenAI Chat Completions JSON or SSE → write the response.

**Design center**: simplest viable shape that is *faithful enough to ship as a drop-in OpenAI base URL* for the open-source clients listed above. Two install paths:

1. **Standalone** (primary, no pi required) — `pnpm dlx github:bntvllnt/pi-gateway --port 4000`. Run as a foreground process, Ctrl+C to stop.
2. **Pi-managed dogfood** (secondary, when pi is in active use) — repo ships a thin pi-extension wrapper at `./index.ts` that registers `/gateway:start`, `/gateway:stop`, `/gateway:status` slash commands + a footer status widget + LLM-callable tools (`gateway_start`, `gateway_status`, `gateway_stop`). Slash commands spawn the standalone `pi-gateway` binary as a **detached child process** (pi-claude-code's pattern — see `/home/ubuntu/pi-claude-code/index.ts` line 187, `launchDetachedRunner`), so the daemon's lifecycle is independent of the pi session. The extension wrapper never starts an HTTP server in-process inside pi and never creates a pi `AgentSession`.

The package layout style mirrors `/home/ubuntu/pi-claude-code` and `/home/ubuntu/pi-git-worktrees` exactly: pnpm@10.28.2, `@vllnt/eslint-config`, `@vllnt/typescript`, `simple-git-hooks` pre-commit, GitHub Actions CI on `pnpm run check` + `pnpm run build`, `AGENTS.md` pointer to pi docs, `private: true` in `package.json`, `pi.extensions: ["./index.ts"]` declaration so installing the repo as a pi package via `~/.pi/agent/settings.json` auto-loads the slash commands. Confirmed prior-art check: `https://www.openresponses.org/llms.txt` is a vendor-neutral spec only (single `POST /v1/responses` endpoint); pi-coding-agent's RPC mode is JSONL over stdio (not HTTP); pi's custom-provider system only *consumes* OpenAI-compat APIs. No example extension or shipping pi feature exposes pi auth through HTTP. Net-new.

**Security posture**: explicit, scoped to local-machine use. Default bind `127.0.0.1`. Non-loopback bind requires `apiKey` in config file (the `--api-key` CLI flag is **refused** because it leaks via `/proc/<pid>/cmdline` / `ps aux`). OAuth-subscription providers default-**allow** on loopback (loopback access ≈ pi CLI access for the same user on the same machine — exposing them via Open WebUI is the primary feature, not a footgun) and default-deny on non-loopback. User is responsible for the security posture of the machine running the daemon; pi-gateway does not add body-size caps, supply-chain pinning, or reverse-proxy boundary collapse warnings.

## Codebase Impact (MANDATORY)

| Area | Impact | Detail |
|------|--------|--------|
| `package.json` | CREATE | `name: "pi-gateway"`, `private: true`, `version: "0.0.0"`, `type: "module"`, `packageManager: "pnpm@10.28.2"`. Both `bin: { "pi-gateway": "dist/cli.js" }` for standalone CLI use AND `pi: { extensions: ["./index.ts"] }` for pi-package install via settings.json. Scripts: `prepare` (setup-git-hooks), `lint`, `typecheck`, `build` (build-check.mjs), `test` (smoke + e2e), `check` (lint+typecheck+build+test). Keywords: `["pi-package", "pi-extension", "openai", "litellm", "gateway", "pi"]`. peerDependencies: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`. dependencies (runtime): `@sinclair/typebox`. devDependencies match sibling repos exactly (`@mariozechner/jiti`, `@types/node`, `@vllnt/eslint-config`, `@vllnt/typescript`, `eslint`, `prettier`, `simple-git-hooks`, `typescript`). `simple-git-hooks: { "pre-commit": "pnpm run check && pnpm run build" }`. |
| `pnpm-lock.yaml` | CREATE | Lock dependency graph under pnpm. |
| `tsconfig.json` | CREATE | Extend `@vllnt/typescript/node-library.json`. Emit to `dist/` for the `bin` CLI; `noEmit` for the extension entry (jiti-loaded at pi runtime, same as sibling repos). |
| `eslint.config.js` | CREATE | `@vllnt/eslint-config/nodejs` strict defaults. |
| `AGENTS.md` | CREATE | Short pointer for future agents — same shape as `/home/ubuntu/pi-claude-code/AGENTS.md` (pi-docs link + repo-specific testing notes). |
| `index.ts` | CREATE | **Pi-extension entry** (jiti-loaded by pi at session start). Registers slash commands `/gateway:start`, `/gateway:stop`, `/gateway:status`, footer status widget (`Gateway: running · http://127.0.0.1:4000 · 17 models`), and LLM-callable tools `gateway_start` / `gateway_status` / `gateway_stop`. `/gateway:start` spawns the standalone `pi-gateway` binary as a **detached child** with `stdio: "ignore"` + `child.unref()` (mirrors `/home/ubuntu/pi-claude-code/index.ts:187 launchDetachedRunner`). Writes spawned PID to the session-scoped store. Health check is `GET http://<bind>/healthz` polled every 5s while the widget is visible. Never starts an HTTP server in-process inside pi. Never creates a pi `AgentSession`. |
| `src/cli.ts` | CREATE | Binary entry compiled to `dist/cli.js`. Parses argv (`--port`, `--bind`, `--config`, `--auth-dir`, `--allow-origin`, `--log-level`, `--model-allowlist`, `--model-denylist`, `--id-style`, `--expose-oauth-subscriptions`, `--version`, `--help`). **No `--api-key` flag** — security: argv leaks. SIGINT/SIGTERM wired BEFORE `listen()`. `pi-gateway models` subcommand prints model list and exits. |
| `src/config.ts` | CREATE | Merge precedence: CLI flags > `$PI_GATEWAY_*` env > `--config` file > `~/.pi/agent/gateway.json` > defaults. Typebox-validated. Refuses non-loopback bind without `apiKey` (config-file only, never CLI). Asserts `server.address().address` matches resolved host AFTER `listening` event (Node's `listen(port)` default is `0.0.0.0`, not loopback — verify post-bind). |
| `src/server/http-server.ts` | CREATE | `node:http` server. Inline: CORS preflight (default allowlist empty → loopback-only behavior), bearer auth check (skipped on loopback unless `requireKeyOnLoopback: true`), structured JSON access log to stderr with hardcoded redaction allowlist (`content-type`, `content-length`, `user-agent`, `accept`, `accept-encoding` only; everything else redacted including `authorization`, anything matching `*token*` / `*key*` / `*secret*` case-insensitive). Routes `OPTIONS *`, `GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`. SSE responses set `X-Accel-Buffering: no` + `Cache-Control: no-cache, no-transform` and emit `: heartbeat\n\n` every 15s during silent periods (Claude extended-thinking can be 30s+ before first text delta; Open WebUI behind nginx times out at 60s without this). Wires `request.on('close')` → `AbortController.abort()` for upstream cancellation. |
| `src/protocol/chat-completions.ts` | CREATE | Typebox schemas for OpenAI Chat Completions request (`messages`, `tools`, `tool_choice`, `stream`, `temperature`, `top_p`, `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `response_format`, `seed`, `user`, `stream_options`); accept extras but emit a debug log naming the ignored fields. |
| `src/protocol/models-list.ts` | CREATE | Translate `ModelRegistry.getAvailable()` (filtered by config allow/deny) into `{ object: "list", data: [{ id: "provider/model-id", object: "model", created, owned_by: "provider" }, ...] }`. **`id` is always `provider/model-id`** (Open WebUI / LiteLLM / OpenRouter convention; Cursor users add an alias in their own config — documented in README). Deterministic sort. |
| `src/translate/openai-to-pi.ts` | CREATE | OpenAI message array → pi-ai `Context`: system → `systemPrompt`; user/assistant; `image_url` parts → pi-ai image content; `tool_calls` from assistant turn → pi-ai `ToolCall` (parse `function.arguments` JSON string → object); inbound `role: "tool"` → pi-ai `ToolResultMessage` with `toolName` recovered by looking up `tool_call_id` in the preceding assistant turn's `tool_calls[].id → name` (stateless per-request lookup against the `messages` array). Pass `temperature`/`max_tokens`/etc. through `ProviderStreamOptions`. **No pi-gateway system prompt injection, no skill injection, no tool injection.** |
| `src/translate/pi-to-openai.ts` | CREATE | `AssistantMessage` → Chat Completions JSON envelope; `AssistantMessageEventStream` → SSE chunks. Specifications: <br>• Single `id: chatcmpl-<ulid>` generated at request start, reused across every SSE chunk AND the non-stream envelope. <br>• Multi-block content merge rule: thinking blocks NEVER appear in non-stream `choices[].message.content` (which is a string); during streaming, `thinking_delta` events emit as `delta.reasoning_content` (OpenRouter/Ollama convention); multiple text blocks concatenated with `\n\n` in non-stream. <br>• Tool calls: pi-ai `arguments` (object) → `function.arguments` (JSON string via `JSON.stringify`). <br>• `finish_reason` map: pi-ai `"stop"` → `"stop"`; `"length"` → `"length"`; `"toolUse"` → `"tool_calls"`; `"error"` → `"stop"` (error carried in mid-stream `data: {"error":...}\n\n` frame, OpenAI mid-stream convention); `"aborted"` → `"stop"`. <br>• Mid-stream errors: emit `data: {"error":{type,code,message}}\n\n` then close — **NO trailing `[DONE]`**, per OpenAI's mid-stream convention (Open WebUI / Cursor render errors only when shaped this way; the previous `pi_gateway.error` extension + trailing `[DONE]` is wrong and clients hide it). <br>• `usage` block emitted on final pre-`[DONE]` chunk unconditionally (not gated on `stream_options.include_usage` — documented deviation). Field map: pi-ai `input` → `prompt_tokens`, `output` → `completion_tokens`, sum → `total_tokens`. |
| `src/translate/model-id.ts` | CREATE | Parse `provider/model-id`, bare `model-id` (resolved to first available match with disambiguation rules), and `model-id:thinking` formats; clear 404 when ambiguous or unknown. |
| `src/lifecycle.ts` | CREATE | Owns the daemon state machine and PID lockfile at `~/.pi/agent/gateway.pid`. On start: writes PID file if absent; refuses start if PID file exists and the recorded PID is still alive (`process.kill(pid, 0)` probes); cleans up stale PID file when recorded PID is dead. SIGINT/SIGTERM handlers registered BEFORE `listen()`. 5s `forceAbortTimeout` on shutdown — in-flight streams are aborted *immediately* via `AbortSignal`, not drained; the 5s is only the window for the TCP socket to flush the final SSE frame. Aborts pi-ai streams via `AbortController`. PID file removed on clean exit. |
| `tests/smoke.mjs` | CREATE | Import `startServer({...})` and `stopServer()` exports, assert clean bind on `127.0.0.1:0` + clean stop + no PID file leak. |
| `tests/extension-e2e.mjs` | CREATE | Real `127.0.0.1:0` daemon, real `fetch` client (Node 22+ native), `faux` provider from `@mariozechner/pi-ai` as upstream stub. Covers `GET /v1/models`, non-stream + stream `POST /v1/chat/completions`, abort propagation, auth gate, multi-block content merge, tool round-trip, mid-stream error frame, SSE heartbeat, PID lockfile dual-bind refusal, OAuth-subscription loopback-allow / non-loopback-deny gate. (Filename retains `extension-e2e.mjs` for consistency with sibling repos; harness uses HTTP.) |
| `.githooks/pre-commit` | CREATE | Local pre-commit entrypoint running `pnpm run check`. |
| `scripts/setup-git-hooks.mjs` | CREATE | Safe hook installer (no-op outside git). |
| `scripts/build-check.mjs` | CREATE | Confirms `dist/cli.js` builds and the `bin` shebang is preserved. |
| `.github/workflows/ci.yml` | CREATE | GitHub Actions running `pnpm run check`. |
| `README.md` | CREATE | **Two install paths**: (1) Standalone: `pnpm dlx github:bntvllnt/pi-gateway --port 4000`. (2) Dogfood via pi: add `"git:git@github.com:bntvllnt/pi-gateway"` to `~/.pi/agent/settings.json` `packages` array, restart pi, run `/gateway:start`. CLI flags table, config file schema, Open WebUI / LibreChat / LiteLLM / Cursor / Continue.dev / Cline wiring examples (Cursor needs `provider/model-id` aliased to bare id in user config), supported and unsupported request fields, troubleshooting, explicit non-goals (no agent, no skills, no session persistence). |

**Files:** 20 create | 0 modify | 0 affected
**Reuse:** Package layout / dev-dep strategy / pre-commit / CI from `/home/ubuntu/pi-claude-code` + `/home/ubuntu/pi-git-worktrees`. `AuthStorage` + `ModelRegistry` from `@mariozechner/pi-coding-agent` (exported per `dist/index.d.ts`). `complete()` / `stream()` + `Model` + `Context` from `@mariozechner/pi-ai` (per `dist/stream.d.ts`; pattern from `examples/extensions/qna.ts`). Typebox for schemas. `node:http` for the server.
**Breaking changes:** none — net-new package.
**New dependencies:** runtime: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@sinclair/typebox`. No other runtime deps. Dev: mirror sibling packages.

## User Journey (MANDATORY)

### Primary Journey

ACTOR: Solo developer who already configured pi auth (env var, `~/.pi/agent/auth.json`, or `/login` OAuth subscription) and wants a local OpenAI-compatible endpoint for Open WebUI / LibreChat / LiteLLM-style consumers / Cursor / Continue.dev / Cline.
GOAL: Run a single foreground command that exposes every model pi knows about over `/v1/chat/completions`, point the third-party UI at it, stop with Ctrl+C.
PRECONDITION: `pi-gateway` installed; at least one provider has credentials reachable through `AuthStorage`.

1. User runs `pi-gateway --port 4000`
   → System parses flags + env + config + `~/.pi/agent/gateway.json`, validates security rules (non-loopback requires `apiKey` in config file, NOT a CLI flag), writes PID lockfile (refuses start if another live daemon owns it), loads `AuthStorage`, instantiates `ModelRegistry`, registers SIGINT/SIGTERM, opens `node:http` on the resolved address, asserts `server.address().address` matches intent, prints `pi-gateway listening on http://127.0.0.1:4000 — N models available — Ctrl+C to stop`. Process stays in foreground.

2. User points Open WebUI Settings → Connections → OpenAI API at `http://127.0.0.1:4000/v1`. Key field requires non-empty string (Open WebUI quirk); type any value like `pi-gateway` — documented in README.
   → Open WebUI calls `GET /v1/models`; system answers with `ModelRegistry.getAvailable()` filtered by allow/deny + non-loopback OAuth-subscription deny (loopback default-ALLOWS subscriptions because loopback access ≈ same-user pi CLI access). `id` is always `provider/model-id`.

3. User sends a chat message in Open WebUI with `stream: true`
   → System validates the request, resolves `Model` via `modelRegistry.find(provider, id)`, translates messages to pi-ai `Context` (no system prompt, no tools, no skills added by pi-gateway), resolves auth via `modelRegistry.getApiKeyAndHeaders(model)`, calls `stream(model, ctx, { apiKey, headers, signal })`, pipes events to SSE chunks shaped as `chat.completion.chunk` — text → `delta.content`, thinking → `delta.reasoning_content`, tool calls → `delta.tool_calls[].function.arguments` (JSON-string-encoded). Emits `: heartbeat\n\n` every 15s during silent periods (Claude extended-thinking). Final chunk carries `finish_reason` + `usage`. Terminates with `data: [DONE]\n\n`.

4. User asks the model to call a function; client sends follow-up `messages` containing `role: "tool"` with `tool_call_id` and `content`
   → System parses prior assistant turn to recover `toolName` from `tool_calls[].id → function.name`, builds a pi-ai `ToolResultMessage`, completes the round trip.

5. User closes the Open WebUI tab during generation
   → System detects `request.on('close')` (bounded by Node's keep-alive timeout, typically <5s), calls `controller.abort()`. Pi-ai providers honor `signal.aborted` at their next yield boundary (poll-based — not literally "one tick", which is structurally unachievable when providers do blocking network reads). Active request counter decrements. Access log line written with `status=499, abort=true`.

6. User presses Ctrl+C
   → System catches SIGINT, transitions to `STOPPING`, aborts every in-flight stream immediately via `AbortSignal`, allows up to 5s for sockets to flush final SSE error/`[DONE]` frames, removes PID lockfile, prints `pi-gateway stopped`, exits code 0.

POSTCONDITION: No background process, no orphaned port, no leftover PID file, no credentials leaked into logs, no pi session was ever created.

### Error Journeys

E1. Port already in use
   1. `pi-gateway --port 4000` → `listen()` fails with `EADDRINUSE` → exit code 1, stderr names the port + suggests `--port 0`.

E2. Non-loopback bind without API key (config file only)
   1. `--bind 0.0.0.0` or non-loopback in config, no `apiKey` in `~/.pi/agent/gateway.json` → refused before opening any socket → exit code 2, stderr names the security rule.

E3. `--api-key` CLI flag passed
   1. `pi-gateway --api-key sk-...` → refused immediately with explanation that argv-resolved secrets leak via `/proc/<pid>/cmdline` and `ps aux` → exit code 2, stderr names the safer alternatives (env var or config file).

E4. PID lockfile owned by live daemon
   1. Second `pi-gateway` invocation while another is running → refused → exit code 3, stderr names the existing PID and the `~/.pi/agent/gateway.pid` path; if the recorded PID is dead, the stale file is cleaned automatically.

E5. Unknown model id from client
   1. `model: "gpt-bogus-9000"` → HTTP 404 `{ error: { type: "invalid_request_error", code: "model_not_found", param: "model", message: "..." } }` → no provider call, no auth load.

E6. No credentials for requested model's provider
   1. Anthropic model requested, no Anthropic auth → HTTP 401 `{ error: { type: "authentication_error", code: "no_credentials", message: "..." } }` → never reaches provider.

E7. OAuth-subscription model requested on non-loopback bind
   1. `anthropic/claude-pro-...` over non-loopback without `--expose-oauth-subscriptions` → HTTP 403 `subscription_exposure_disabled`.

E8. Provider stream errors mid-response
   1. Pi-ai stream throws after deltas emitted → emit `data: {"error":{type,code,message}}\n\n` then close socket. **NO trailing `[DONE]`** (OpenAI mid-stream convention; trailing `[DONE]` after error confuses Open WebUI / Cursor into rendering truncated text as a successful completion).

E9. Client disconnects mid-stream
   1. SSE socket closes → `request.on('close')` fires → `controller.abort()` → pi-ai stops at next yield boundary.

### Edge Cases

EC1. Image inputs (`image_url` parts) on a non-image model → HTTP 400 `invalid_request_error`.
EC2. `tools` round-trip is FULL (Must Have, see AC-7): outbound translates `tool_calls`; inbound `role: "tool"` recovers `toolName` from prior assistant turn — stateless lookup, no session state.
EC3. `response_format: { type: "json_object" | "json_schema" }` forwarded as-is; provider 400 propagates (no v1 capability flag on `Model` for structured output; documented).
EC4. OAuth-subscription providers (Claude Pro/Max, ChatGPT Plus/Pro Codex, GitHub Copilot, Google Gemini CLI, Google Antigravity): **default-ALLOW on loopback** (loopback access ≈ same-user pi CLI access on the same machine — exposing them via Open WebUI is the primary feature). Default-DENY on non-loopback; opt-in via `--expose-oauth-subscriptions` or config. Startup log prints `M of N models exposed (K OAuth subscriptions enabled on loopback)` so users see exactly what's reachable.
EC5. Concurrent requests share no mutable state; per-provider auth refresh relies on `ModelRegistry.getApiKeyAndHeaders` serialization. Covered in tests (one canonical row).
EC6. Multi-block assistant content (Claude 3.7+ thinking + text): thinking NEVER appears in non-stream `choices[].message.content`; surfaced only during streaming as `delta.reasoning_content`. Text blocks concatenated with `\n\n` in non-stream `content`.
EC7. SSE heartbeat: emits `: heartbeat\n\n` every 15s during silent periods so nginx-fronted Open WebUI deployments don't time out on Claude extended-thinking responses.
EC8. `pi-gateway models` subcommand prints the resolvable model list and exits without binding.

## Acceptance Criteria (MANDATORY)

### Must Have (BLOCKING — all must pass to ship)

- [ ] AC-1: GIVEN at least one provider has credentials WHEN the user runs `pi-gateway --port 0` THEN the process binds an HTTP listener on `127.0.0.1`, writes `~/.pi/agent/gateway.pid`, prints the URL + model count + OAuth-subscription summary, and stays in the foreground.
- [ ] AC-2: GIVEN the daemon is running WHEN a client calls `GET /v1/models` THEN the response is a valid OpenAI list payload; `data[].id` is always `provider/model-id`; allow/deny lists + non-loopback OAuth-subscription deny applied; stable sort.
- [ ] AC-3: GIVEN the daemon is running WHEN a client calls `POST /v1/chat/completions` with `stream: false` against a known model THEN the response matches the OpenAI envelope; `content` is a string with multi-block merge rule applied (thinking dropped, text blocks concatenated with `\n\n`); `usage` field map: `input→prompt_tokens`, `output→completion_tokens`; pi-gateway never added a system prompt, tool, or skill.
- [ ] AC-4: GIVEN the daemon is running WHEN a client calls `POST /v1/chat/completions` with `stream: true` THEN the response is `text/event-stream` with `X-Accel-Buffering: no` + `Cache-Control: no-cache, no-transform` headers; `id` is a single `chatcmpl-<ulid>` reused across every chunk; `delta.content` carries text; `delta.reasoning_content` carries thinking; `delta.tool_calls[].function.arguments` is a JSON string; `: heartbeat\n\n` is emitted every 15s during silent periods; final chunk carries `finish_reason` + `usage`; terminator is `data: [DONE]\n\n`.
- [ ] AC-5: GIVEN the daemon is bound non-loopback WHEN any request lacks a matching `Authorization: Bearer <apiKey>` THEN HTTP 401 and no pi-ai call. AND given `--api-key` is passed as a CLI flag, the daemon refuses to start with an explicit security message.
- [ ] AC-6: GIVEN the daemon is running WHEN SIGINT or SIGTERM is received THEN handlers (registered before `listen()`) run; in-flight pi-ai streams are aborted via `AbortSignal` immediately; sockets get up to 5s to flush final frames; PID lockfile is removed; exit code 0.
- [ ] AC-7: GIVEN tool-calling `tools` + `tool_choice` are present in a request AND the resolved model supports tools WHEN the gateway forwards them THEN `tool_calls.function.arguments` is emitted as a JSON string in SSE deltas and the non-stream envelope; AND given a follow-up request with `role: "tool"` and `tool_call_id`, the gateway recovers `toolName` from the prior assistant turn's `tool_calls[].id → function.name` and builds a valid pi-ai `ToolResultMessage` — pi-gateway never executes the tool itself.
- [ ] AC-8: GIVEN a streaming response is in progress WHEN the client disconnects OR the upstream errors mid-stream THEN: (a) on client disconnect, `request.on('close')` triggers `controller.abort()` and pi-ai stops at its next yield boundary (poll-based — bounded by provider read-loop iteration and `keepAliveTimeout`, not literally one tick); (b) on upstream error, the daemon emits `data: {"error":{type,code,message}}\n\n` and closes WITHOUT a trailing `[DONE]` (OpenAI mid-stream convention).

### Error Criteria (BLOCKING — all must pass)

- [ ] AC-E1: Port collision exits code 1 with actionable error.
- [ ] AC-E2: Non-loopback bind without `apiKey` exits code 2 before opening any socket.
- [ ] AC-E3: `--api-key` CLI flag refused with explicit security message, exit code 2.
- [ ] AC-E4: Stale PID lockfile cleaned automatically; live PID lockfile refuses second start, exit code 3.
- [ ] AC-E5: Unknown model returns 404 `model_not_found` before any provider/auth call.
- [ ] AC-E6: Missing credentials return 401 `no_credentials` before any provider call; access log redacts auth headers.
- [ ] AC-E7: OAuth-subscription model over non-loopback without opt-in returns 403 `subscription_exposure_disabled`.

### Should Have (ship without, fix soon)

- [ ] AC-9: GIVEN `response_format` is in the request THEN it is forwarded to pi-ai as-is; upstream 400 propagates unchanged.
- [ ] AC-10: GIVEN the package is used inside a git repository WHEN a commit or PR validation runs THEN a local pre-commit hook and CI workflow both run `pnpm run check` + `pnpm run build`.
- [ ] AC-11 (dogfood): GIVEN the repo is installed as a pi package via `~/.pi/agent/settings.json` `packages` array WHEN pi starts THEN the extension entry `./index.ts` loads, registers `/gateway:start` `/gateway:stop` `/gateway:status` slash commands + `gateway_start` / `gateway_status` / `gateway_stop` tools + footer status widget, and `/gateway:start` spawns the standalone `pi-gateway` binary as a detached child process whose lifecycle survives pi session shutdown.

## Scope

- [ ] 1. Bootstrap standalone CLI package (`bin: pi-gateway`, pnpm, strict `@vllnt/*` config, deps on `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` + `@sinclair/typebox`, `dist/` build, install/check scripts). → AC-1, AC-2, AC-3, AC-4, AC-5, AC-6
- [ ] 2. Implement `config.ts` (CLI flags → env → `--config` → `~/.pi/agent/gateway.json` → defaults; Typebox-validated; refuses non-loopback bind without config-file `apiKey`; refuses `--api-key` CLI flag; default-allow OAuth subscriptions on loopback). → AC-1, AC-5, AC-7, AC-E2, AC-E3, AC-E7
- [ ] 3. Implement `http-server.ts` with `node:http`, inline router/auth/CORS/logger (hardcoded header redaction allowlist), SSE heartbeat + anti-buffering headers, post-listen `server.address()` assertion. → AC-1, AC-2, AC-4, AC-5, AC-6, AC-E1, AC-E2
- [ ] 4. Implement `lifecycle.ts` (state machine, SIGINT/SIGTERM handlers registered BEFORE `listen()`, PID lockfile at `~/.pi/agent/gateway.pid` with stale-cleanup, 5s force-abort window). → AC-1, AC-6, AC-E1, AC-E4
- [ ] 5. Implement `protocol/chat-completions.ts` + `protocol/models-list.ts` Typebox schemas. → AC-2, AC-3, AC-4, AC-E5
- [ ] 6. Implement `translate/openai-to-pi.ts` + `translate/pi-to-openai.ts` + `translate/model-id.ts` covering: multi-block content merge rule, `delta.reasoning_content` for thinking, tool_calls full round-trip (arguments JSON-string, toolName recovery from prior turn), `finish_reason` map, OpenAI mid-stream error convention, single-`id` reuse across stream, `usage` field name mapping. → AC-3, AC-4, AC-7, AC-8, AC-E5, AC-E6
- [ ] 7. Implement `cli.ts` argv + `pi-gateway models` subcommand. → AC-1
- [ ] 8. Implement `index.ts` pi-extension wrapper (slash commands `/gateway:*`, footer status widget, LLM-callable tools, detached-child spawn pattern from `/home/ubuntu/pi-claude-code/index.ts:187`). → AC-11
- [ ] 9. Add smoke + real-HTTP E2E tests against `faux` pi-ai provider on `127.0.0.1:0`, plus a smoke test that jiti-loads `index.ts` and asserts commands/tools/widget register without binding any port. → all ACs
- [ ] 10. Document **dogfood install** in README: `gh repo create bntvllnt/pi-gateway --private --source=. --remote=origin --push`, then add `"git:git@github.com:bntvllnt/pi-gateway"` to `~/.pi/agent/settings.json` packages array; pi auto-clones to `~/.pi/agent/git/github.com/bntvllnt/pi-gateway/` on next session start. Plus standalone install / CLI flags / config schema / Open WebUI / LibreChat / Cursor / Continue.dev / Cline / LiteLLM wiring / OAuth-subscription posture / non-goals. → all ACs
- [ ] 11. Add local pre-commit + GitHub Actions CI for `pnpm run check` + `pnpm run build` (matches sibling repos' `.github/workflows/ci.yml` exactly). → AC-10

### Out of Scope

- `POST /v1/responses` (OpenAI Responses API / openresponses.org spec). Should Have at most; flagged as a 6-month forward-compat risk (Cursor / Codex CLI / ChatGPT desktop migrating). README's positioning must reflect this — not marketed as "drop-in for any OpenAI-compat client" without the caveat.
- `POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/audio/*` — pi-ai is text-first.
- Anthropic Messages-format passthrough at `/v1/messages`.
- TLS termination (use Caddy / Tailscale Funnel / ngrok as a fronting proxy).
- Multi-tenant accounting, rate limiting, Prometheus metrics, K8s probes.
- Loading pi extensions, skills, prompt templates, or context files — pi-gateway is intentionally not an agent.
- Conversation memory / session persistence.
- Tool *execution* — tools are forwarded; clients execute and send `role: "tool"` results.
- Request body size cap, supply-chain dep pinning, reverse-proxy boundary warnings — user is responsible for the security of the machine running the daemon.
- Spike of `AbortSignal` propagation against all providers up front — skipped per user direction; document caveats in AC-8 instead.

## Dogfood / Local Development

This repo dogfoods the same install flow as `/home/ubuntu/pi-claude-code` and `/home/ubuntu/pi-git-worktrees`.

### One-time GitHub repo creation (private)

After scope item 1 (`pnpm install` succeeds locally):

```bash
cd /home/ubuntu/pi-gateway
git init && git add -A && git commit -m "feat: initial pi-gateway scaffold"
gh repo create bntvllnt/pi-gateway \
  --private \
  --source=. \
  --remote=origin \
  --description "OpenAI-compatible local API on top of pi.dev (LiteLLM-shape)" \
  --push
```

### Install into pi via `~/.pi/agent/settings.json`

Add to the `packages` array (preserving the existing entries):

```jsonc
{
  "packages": [
    "npm:@tintinweb/pi-subagents",
    "npm:pi-web-access",
    "npm:@tintinweb/pi-tasks",
    "npm:@aliou/pi-processes",
    "npm:pi-mcp-adapter",
    "git:git@github.com:bntvllnt/pi-claude-code",
    "git:git@github.com:bntvllnt/pi-git-worktrees",
    "git:git@github.com:bntvllnt/pi-gateway"
  ]
}
```

Restart `pi`. The package manager auto-clones to `~/.pi/agent/git/github.com/bntvllnt/pi-gateway/`, runs `pnpm install`, and loads `index.ts` as an extension. Verify with `/gateway:status` — expect `stopped`.

### Run the daemon from inside pi

```
/gateway:start
```

Spawns the standalone binary as a detached child. Footer status updates to `Gateway: running · http://127.0.0.1:4000 · <N> models`. Run `/gateway:stop` to SIGTERM it (or just close everything — the daemon will outlive the pi session by design).

### Run the daemon standalone (no pi)

```bash
pnpm dlx github:bntvllnt/pi-gateway --port 4000
# or, after `npm i -g github:bntvllnt/pi-gateway`:
pi-gateway --port 4000
```

### Point Open WebUI at it

Settings → Connections → OpenAI API:
- Base URL: `http://127.0.0.1:4000/v1`
- API key: any non-empty string (e.g. `pi-gateway` — Open WebUI requires the field be non-empty even when the gateway doesn't require auth on loopback)

Model dropdown populates from `GET /v1/models` (`provider/model-id` shape). For Cursor users, add an alias in Cursor's settings to map `claude-sonnet-4-5` → `anthropic/claude-sonnet-4-5` etc.

## Quality Checklist

### Blocking (must pass to ship)

- [ ] All Must Have ACs passing
- [ ] All Error Criteria ACs passing
- [ ] All scope items implemented
- [ ] No regressions in existing tests
- [ ] Every documented Error Journey has a matching E2E test
- [ ] No hardcoded secrets, no logging of any header not on the safe allowlist, no logging of request bodies beyond a length integer
- [ ] Default bind is loopback-only; `server.address().address` asserted post-listen; non-loopback bind without `apiKey` (config file only) refused before `listen()`
- [ ] `--api-key` CLI flag refused (BLOCKING — argv leak)
- [ ] SIGINT / SIGTERM handlers registered BEFORE `listen()`; abort signal propagates immediately to in-flight pi-ai streams; PID file removed on clean exit
- [ ] OAuth-subscription providers default-allow on loopback, default-deny on non-loopback
- [ ] **No pi `AgentSession` is created at any point in the request path** — only `AuthStorage`, `ModelRegistry`, and pi-ai's `complete`/`stream` are touched
- [ ] **No system prompt, tools, or skills are added by pi-gateway** — what the client sends is exactly what pi-ai sees (modulo schema-level translation)
- [ ] SSE response sets `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`; `: heartbeat\n\n` emitted every 15s during silent periods
- [ ] SSE mid-stream errors follow OpenAI's `data: {"error":{...}}\n\n` then-close convention (NO trailing `[DONE]`)
- [ ] Single `chatcmpl-<ulid>` reused across every chunk AND the non-stream envelope
- [ ] Multi-block content merge rule applied: thinking → `delta.reasoning_content` (streaming only), text blocks concatenated with `\n\n` in non-stream `content`
- [ ] `tool_calls.function.arguments` is a JSON string in every wire emission
- [ ] `usage` field map is `input→prompt_tokens`, `output→completion_tokens`, sum → `total_tokens`

### Advisory (should pass, not blocking)

- [ ] `pi-gateway --help` prints a one-page reference matching the README CLI flags section
- [ ] `pi-gateway models` exits 0 when at least one provider has credentials
- [ ] Local pre-commit hook and CI both run the same `pnpm run check`
- [ ] Backpressure on SSE writes considered (pause iteration on `res.write() === false`, resume on `drain`); ship without if it complicates the simplest shape

## Test Strategy (MANDATORY)

### Test Environment

| Component | Status | Detail |
|-----------|--------|--------|
| Test runner | not configured | Create `pnpm test` around node `.mjs` harnesses matching `/home/ubuntu/pi-claude-code/tests/*.mjs`. |
| E2E framework | not configured | Harness imports `startServer({ ... })` API, binds `127.0.0.1:0`, drives real HTTP via Node 22+ native `fetch` (fallback `undici.fetch`). |
| Test DB | none | Not applicable. |
| Mock inventory | 0 existing mocks | Real `node:http`, real loopback `fetch`, pi-ai `faux` provider as upstream stub. No HTTP/auth mocks. |

### AC → Test Mapping

| AC | Test Type | Test Intention |
|----|-----------|----------------|
| AC-1 | E2E | Start on `127.0.0.1:0`, assert stdout URL + model count + OAuth-subscription summary, `GET /healthz` returns 200, SIGINT cleanly exits, PID file removed. |
| AC-2 | E2E | `GET /v1/models` payload shape; `data[].id` is `provider/model-id`; allow/deny + non-loopback OAuth-deny applied; stable sort. |
| AC-3 | E2E | Non-stream `POST /v1/chat/completions`: envelope shape; thinking dropped from `content`, text blocks `\n\n`-joined; `usage` field names correct; faux provider received exactly what the client sent (no system prompt / tools / skills injection). |
| AC-4 | E2E | Stream: anti-buffering headers present; single `id` reused; `delta.content` text, `delta.reasoning_content` for thinking; tool_call arguments as JSON string; heartbeat every 15s when faux provider stalls; final chunk has `finish_reason` + `usage`; terminator is `[DONE]`. |
| AC-5 | E2E | Non-loopback bind without `Authorization` → 401; correct key → 200. `--api-key` flag refused. |
| AC-6 | E2E | SIGINT during long stream: abort propagates within bounded time, PID file removed, exit 0. |
| AC-7 | E2E | Send `tools` + assistant tool_call, assert `arguments` is a JSON string in both stream and non-stream. Follow up with `role: "tool"` + `tool_call_id`, assert toolName is recovered and pi-ai receives a valid `ToolResultMessage`. Assert pi-gateway never executes the tool itself. |
| AC-8 | E2E | (a) Client `fetch` abort mid-stream → faux provider records abort; (b) faux provider throws after deltas → daemon emits `data: {"error":{...}}\n\n` then closes WITHOUT `[DONE]`. |
| AC-E1 | E2E | Pre-bind on the chosen port → process exits code 1, stderr names port. |
| AC-E2 | E2E | `--bind 0.0.0.0` with no config `apiKey` → exit code 2, port never opened. |
| AC-E3 | E2E | `pi-gateway --api-key foo` → exit code 2, stderr explains argv leak. |
| AC-E4 | E2E | First daemon running; second start refused with exit code 3. Kill first uncleanly (SIGKILL), restart cleans stale PID file automatically. |
| AC-E5 | E2E | Unknown model id → 404 + `model_not_found`, faux provider not invoked. |
| AC-E6 | E2E | Provider with no credentials → 401 + `no_credentials`, faux provider not invoked; access log redacts auth headers. |
| AC-E7 | E2E | OAuth-subscription model over `--bind 0.0.0.0` without `--expose-oauth-subscriptions` → 403; `--expose-oauth-subscriptions` flips to 200. |
| AC-9 | E2E | `response_format: { type: "json_object" }` forwarded; faux provider responds normally; provider 400 propagates unchanged. |
| AC-10 | Smoke | `package.json`, pre-commit, CI workflow all run `pnpm run check` + `pnpm run build`; hook install is a no-op outside git. |
| AC-11 | Smoke | jiti-load `index.ts` via a harness that mocks `ExtensionAPI`; assert `/gateway:start`, `/gateway:stop`, `/gateway:status` register, plus `gateway_start` / `gateway_status` / `gateway_stop` tools, plus the footer widget; assert importing the file does NOT spawn any process or bind any port. (Real detached-child spawn is exercised manually during dogfood.) |

### Failure Mode Tests (MANDATORY)

| Source | ID | Test Intention | Priority |
|--------|----|----------------|----------|
| Error Journey | E1-E9 | One E2E per journey, per above mapping | BLOCKING (all journeys) |
| Edge Case | EC1 | Image part on non-image model → 400 | Advisory |
| Edge Case | EC4 | OAuth-subscription loopback-allow / non-loopback-deny gate | BLOCKING |
| Edge Case | EC5 | 20 concurrent streams: no shared state, one abort does not affect another, OAuth refresh under burst returns 401 cleanly without daemon crash | BLOCKING |
| Edge Case | EC6 | Claude multi-block content (faux producing thinking+text) → non-stream `content` is text-only string, stream emits `delta.reasoning_content` | BLOCKING |
| Edge Case | EC7 | Faux provider stalls 30s before first text delta → client receives heartbeat comments at 15s intervals, no timeout | BLOCKING |
| Edge Case | EC8 | `pi-gateway models` subcommand lists models and exits 0 | Advisory |
| Failure Hypothesis | FH-1 (HIGH) | Every request log line excludes `Authorization` and any header matching `*token*` / `*key*` / `*secret*` (case-insensitive) | BLOCKING |
| Failure Hypothesis | FH-2 (HIGH) | Default config without `--bind` never binds to anything other than `127.0.0.1` / `::1`; `server.address().address` asserted | BLOCKING |
| Failure Hypothesis | FH-3 (HIGH) | A request flowing through pi-gateway reaches pi-ai with EXACTLY the messages the client sent — no extra system prompt, no extra tools, no skills injection | BLOCKING |
| Failure Hypothesis | FH-4 (HIGH) | Single `chatcmpl-<ulid>` reused across every chunk + non-stream envelope; never regenerated mid-stream | BLOCKING |
| Failure Hypothesis | FH-5 (MED) | Pi-ai per-provider OAuth refresh still works under gateway-driven requests (use a fake-expired token in test AuthStorage) | Advisory |

### Mock Boundary

| Dependency | Strategy | Justification |
|------------|----------|---------------|
| `node:http` | Real local listener bound to `127.0.0.1:0` | Server behavior is the system under test. |
| pi-ai upstream providers | `faux` provider from `@mariozechner/pi-ai` | Translator + SSE framing under test, not provider intelligence. |
| `AuthStorage` / `ModelRegistry` | Real instances against a temp `--auth-dir` seeded with controlled fixtures | Auth gating is a hard security boundary. |
| HTTP client | Native `fetch` (Node 22+) or `undici.fetch` | Closer to real third-party UI behavior. |

### TDD Commitment

All tests written BEFORE implementation (RED → GREEN → REFACTOR).

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Translator drift between OpenAI Chat Completions and pi-ai's internal Context shape (roles, tool calls, multi-block content, finish_reason mapping, usage field names) | HIGH | HIGH | Translators isolated in `src/translate/*.ts`; full role/multi-block matrix covered in E2E against `faux`; FH-3 enforces zero side-channel additions; FH-4 enforces single `chatcmpl-<ulid>`. |
| SSE framing bugs (non-standard error frame, missing heartbeat, wrong `delta.reasoning_content` field, missing single-id rule) silently break Open WebUI / LibreChat / Cursor / Cline | HIGH | HIGH | Dedicated framing test parses every chunk as JSON, verifies single id, verifies heartbeat cadence, verifies OpenAI mid-stream error convention; documented in AC-4 + AC-8. |
| Pi-ai `AbortSignal` propagation may not be uniform across all providers | MED | MED | Spike SKIPPED per user direction; AC-8 reframes the guarantee as "bounded by provider read-loop iteration + `keepAliveTimeout`"; document per-provider caveats in README; kill criteria stands. |
| Re-exposing OAuth-backed subscriptions over non-loopback may violate provider ToS | HIGH | LOW (loopback default-allow is per-user; non-loopback default-deny) | Default-allow on loopback (same-user same-machine ≈ pi CLI), default-deny on non-loopback unless explicit opt-in; README documents the posture. |
| `provider/model-id` ID format breaks Cursor users | MED | HIGH | Documented Cursor workaround in README (user adds alias in their own config); `--id-style` flag considered but kept out of v1 to ship simpler. |
| No `/v1/responses` cost increases over 2026 (Cursor / Codex CLI / ChatGPT desktop migrating) | MED | MED | Out of Scope for v1; README does NOT claim "drop-in for any OpenAI-compat client" — claims "drop-in for Chat Completions clients (Open WebUI, LibreChat, Cursor, Continue.dev, Cline, LiteLLM consumers)"; add `/v1/responses` in v2. |

**Kill criteria:** If pi-ai's `AbortSignal` plumbing cannot propagate client-disconnect aborts to ANY production provider that pi-gateway exposes by default, drop streaming from v1 and ship non-stream only behind a feature flag, with a clear README note. Do not fake abort propagation.

## State Machine

┌───────────┐      start       ┌────────────┐   listen ok    ┌────────────┐
│  STOPPED  │─────────────────▶│  STARTING  │───────────────▶│  RUNNING   │
└─────┬─────┘                  └─────┬──────┘                └─────┬──────┘
      ▲                              │ listen err / config err     │ SIGINT / SIGTERM
      │                              │ / pid conflict              │
      │                              ▼                              ▼
      │                        ┌────────────┐                ┌────────────┐
      │                        │   ERROR    │                │  STOPPING  │
      │                        └─────┬──────┘                └─────┬──────┘
      │                              │ exit nonzero                │ aborts ≤5s
      └──────────────────────────────┴─────────────────────────────┘
                                                                     ▼
                                                              exit 0 (STOPPED)

States:
- `STOPPED` — process not started, or post-exit; PID file absent or stale
- `STARTING` — config resolved + validated; PID lockfile claimed; SIGINT/SIGTERM handlers registered; about to `listen()`
- `RUNNING` — listener bound (post-`address()` assertion); accepting requests
- `STOPPING` — `server.close()` called; in-flight pi-ai streams aborted via `AbortSignal`; ≤5s for sockets to flush
- `ERROR` — fatal startup failure (bind error, security preflight refused, PID conflict, invalid config); exits non-zero

Transitions:
- `STOPPED → STARTING` on `pi-gateway` invocation, after PID claim and signal handlers wired
- `STARTING → RUNNING` on `server.listening` AND `server.address().address` matches resolved host
- `STARTING → ERROR` on listen error / config invalid / PID conflict / security refusal / `--api-key` flag
- `RUNNING → STOPPING` on SIGINT / SIGTERM (latch handles signal during `STARTING` window by deferring)
- `STOPPING → exit 0` after abort + ≤5s drain + PID file removed
- `ERROR → exit non-zero` deterministically

Race conditions handled:
- SIGINT during `STARTING`: handler is already registered before `listen()`; latch a `pendingShutdown` flag, transition straight to `STOPPING` once listener attaches.
- Client disconnect during `STOPPING`: idempotent; abort fires; counter decrements; exit proceeds.

Complexity: LOW (5 states, 7 transitions). Plain in-memory; no state-machine library.

## Analysis

### Assumptions Challenged (spec-review applied 2026-05-27)

| # | Assumption | Verdict | Action Taken |
|---|------------|---------|--------------|
| 1 | 8h estimate is realistic | UNDERESTIMATED 2x | Re-estimated to 16h. |
| 2 | OAuth-subscription default-deny was the safe posture | OVER-CAUTIOUS for loopback | Flipped to default-allow on loopback (the primary differentiator), keep deny on non-loopback. |
| 3 | `data[].id = "provider/model-id"` works for all clients | RISKY for Cursor | Kept `provider/model-id` (OpenWebUI/LiteLLM/OpenRouter convention); documented Cursor alias workaround in README. |
| 4 | `AbortSignal` propagates "within one event-loop tick" | WRONG | Reframed AC-8 as "bounded by provider read-loop iteration + `keepAliveTimeout`". |
| 5 | `--api-key` CLI flag is safe | WRONG (argv leak via `/proc/<pid>/cmdline`) | Flag refused; config file or env only. |
| 6 | `node:http` `listen(port)` defaults to `127.0.0.1` | WRONG (Node default is `0.0.0.0`) | Assert `server.address().address` post-listen. |
| 7 | Multi-block content (Claude 3.7+ thinking + text) maps trivially to OpenAI `content: string` | WRONG | Specified merge rule: thinking → `delta.reasoning_content` (streaming only); text blocks `\n\n`-joined in non-stream. |
| 8 | SSE error frame using `finish_reason: "error"` + trailing `[DONE]` works | WRONG | Aligned with OpenAI mid-stream convention: `data: {"error":{...}}\n\n` then close, NO `[DONE]`. |
| 9 | `thinking_delta` SSE field name can be invented | RISKY | Picked `delta.reasoning_content` (OpenRouter/Ollama convention). |
| 10 | Tools as Should Have is acceptable | WRONG (Cursor/Cline/Continue.dev primary use case) | Promoted to Must Have with full round-trip translator. |
| 11 | Pi-ai `Usage` field names map directly to OpenAI's | WRONG (different names) | Specified `input→prompt_tokens`, `output→completion_tokens`, sum → `total_tokens`. |
| 12 | SSE `id` is per-chunk | WRONG | Single `chatcmpl-<ulid>` reused across every chunk and non-stream envelope. |
| 13 | Open WebUI / nginx handle silent SSE indefinitely | WRONG (60s timeout) | Heartbeat every 15s + `X-Accel-Buffering: no` + `Cache-Control: no-cache, no-transform`. |
| 14 | 5s "drain" window means streams complete naturally | AMBIGUOUS | Renamed semantics: streams abort immediately via `AbortSignal`; 5s is only the socket-flush window. |
| 15 | Reverse-proxy boundary collapse is pi-gateway's problem | OUT OF SCOPE | User's machine security is user's concern (per direction); not addressed. |
| 16 | Request body size cap is required | OUT OF SCOPE | Not addressed (per direction); user's concern. |
| 17 | Supply chain pinning is required | OUT OF SCOPE | Not addressed (per direction); user's concern. |
| 18 | Spike abort-signal first | SKIPPED | Per user direction: build and see; kill criteria stands. |

### Blind Spots Now Addressed

1. **[contract]** Multi-block content merge rule — specified (EC6, AC-3).
2. **[contract]** SSE error frame format — aligned with OpenAI mid-stream convention (AC-8).
3. **[contract]** `thinking_delta` SSE field — `delta.reasoning_content` (AC-4).
4. **[contract]** Tool calling full round-trip including `toolName` recovery — Must Have (AC-7).
5. **[contract]** Single `chatcmpl-<ulid>` reuse — FH-4 (AC-4).
6. **[contract]** `usage` field name mapping — specified.
7. **[client-ux]** SSE heartbeat for slow first-token + anti-buffering headers — AC-4, EC7.
8. **[client-ux]** Open WebUI key-field UX hint — README; OAuth-subscription summary printed at startup.
9. **[client-ux]** Cursor `provider/model-id` workaround documented in README.
10. **[reliability]** SIGINT registration before `listen()` — `lifecycle.ts`, FH-A converted to acceptance criterion in AC-6.
11. **[reliability]** PID lockfile — added (`lifecycle.ts`, AC-E4).
12. **[reliability]** AbortSignal timing guarantee reframed — AC-8.
13. **[security]** `--api-key` flag refused — AC-E3.
14. **[security]** `node:http` default-`0.0.0.0` trap — `server.address()` assertion (FH-2).

### Blind Spots Deliberately Not Addressed (per user direction "user handles his machine")

1. **[security]** Reverse-proxy boundary collapse — no warning, no `requireKeyOnLoopback` recommendation.
2. **[security]** Request body size cap — none.
3. **[security]** Supply-chain pinning + integrity check on `@mariozechner/*` — none.
4. **[reliability]** SSE backpressure on `res.write()` — advisory only, not enforced.
5. **[security]** Browser/Electron same-host client mitigations — documented in README, not enforced.

### Failure Hypotheses (Updated)

| IF | THEN | BECAUSE | Severity | Mitigation |
|----|------|---------|----------|------------|
| Translator emits `tool_calls.function.arguments` as object instead of JSON string | Cline / Continue.dev fail silently | OpenAI contract requires JSON-string `arguments` | HIGH | AC-7 enforces string serialization. |
| SSE error frame ships with trailing `[DONE]` after error | Open WebUI shows truncated text and treats it as success | OpenAI mid-stream convention is no `[DONE]` after error | HIGH | AC-8. |
| Multi-block Claude assistant content hits non-stream response with `content` as concatenated thinking+text | Clients display reasoning as final answer (privacy + UX regression) | OpenAI `content` is string; spec must merge | HIGH | EC6 + AC-3. |
| Pi-ai per-chunk `id` regeneration | Client deduplication breaks; LangChain JS / Open WebUI misattribute chunks across reconnects | OpenAI requires stable `id` | HIGH | FH-4. |
| SSE heartbeat absent on slow first-token | Open WebUI / nginx-fronted clients time out at 60s on Claude extended-thinking | No heartbeat → silent socket | HIGH | AC-4 + EC7. |
| credentials end up in access logs or error responses | tokens leak to shell scrollback | a debug print included headers or bodies | HIGH | FH-1: hardcoded redaction allowlist. |
| default config binds outside loopback | LAN-reachable port serves any caller | bindAddress defaulted to `0.0.0.0` for convenience | HIGH | FH-2: `server.address()` assertion. |
| pi-gateway silently injects a system prompt or tools | client-controlled behavior broken | translator helpfulness leaked into the request path | HIGH | FH-3: zero side-channel additions. |
| SIGINT during `STARTING` window | process exits dirty, port may leak | handler registered after `listen()` | HIGH | Handlers registered BEFORE `listen()` in `lifecycle.ts`. |
| PID file leaked after crash | Second start refuses indefinitely | stale-cleanup missing | MED | `process.kill(pid, 0)` probe in `lifecycle.ts`; stale file cleaned. |
| client disconnect does not propagate as abort within `keepAliveTimeout` | upstream provider keeps generating | `AbortSignal` not wired or provider doesn't honor it | MED | AC-8 wires it; kill criteria covers per-provider failure. |
| `pi-gateway models` with empty AuthStorage exits 0 | confusing for shell scripting | should signal "no models available" | LOW | Exits 1 with clear message (Advisory). |

### The Real Question

The real question stays: "What is the smallest stateless protocol translator that lets the clients which already speak `POST /v1/chat/completions` + `GET /v1/models` use pi's existing multi-provider auth and routing, without inheriting any agent semantics?"

After review, the simplest viable answer is: **9 source files + 2 test files + the package shell**. Translator round-trips (multi-block content, tool calls with `toolName` recovery, finish_reason mapping, SSE single-id and OpenAI mid-stream error convention) are the actual core of the value — not the HTTP server or the auth gate. Pi-ai + pi-coding-agent give us the routing for free; pi-gateway's job is being faithful to the OpenAI wire format for the listed open-source clients.

### Open Items

- [risk] `provider/model-id` requires Cursor users to add an alias in their config; document clearly. → update spec (DONE in README scope item) and watch for support issues post-launch.
- [risk] Skipped abort-signal spike — kill criteria stands; if real-world testing reveals propagation failure on a major provider, fall back to non-stream-only mode and document. → no action yet
- [improvement] `/v1/responses` adoption pressure increases through 2026 (Cursor / Codex CLI / ChatGPT desktop migrating). Add as v2 milestone with the same `node:http` instance hosting both endpoints. → no action yet
- [improvement] `--id-style` config (slash | flat | configurable) considered for v2 if Cursor users complain. → no action yet
- [improvement] SSE backpressure handling (`res.write() === false` pause + drain) deferred to v2 unless real-world tests reveal memory growth under slow consumers. → no action yet

## Notes

Naming decision: `pi-gateway` confirmed. Industry-aligned with LiteLLM ("LLM Gateway"); explicit LiteLLM-shape (stateless protocol translation only, not a pi-extension or agent wrapper).

Architectural commitment: pi-gateway is **stateless protocol translation only**. It does NOT create a pi `AgentSession`, load extensions/skills/prompt templates, inject system prompts, execute tools, persist conversation state, or run a TUI. It DOES read `~/.pi/agent/auth.json` via `AuthStorage`, resolve models via `ModelRegistry`, translate Chat Completions ↔ pi-ai `Context` shapes (with the specific merge / round-trip / framing rules in `src/translate/*.ts`), call `complete()` / `stream()` from `pi-ai`, and serve HTTP on a configurable bind with hardcoded credential redaction and OAuth-subscription loopback-allow-only-non-loopback-deny.

Spec review applied 2026-05-27: 5 perspectives (Security Engineer, API Contract Reviewer, Reliability/Concurrency Engineer, Client Integrator, Skeptic) surfaced ~36 findings. User direction: simplest viable shape, faithful to open-source clients (Open WebUI / LibreChat / LiteLLM / Cursor / Continue.dev / Cline), user handles machine-level security. Merged: 14 of 18 challenged assumptions resolved with concrete spec changes; 4 deliberately not addressed per user direction (reverse-proxy warnings, body size cap, supply-chain pinning, backpressure enforcement). Tools promoted from Should Have to Must Have. Estimate revised 8h → 16h.

## Progress

| # | Scope Item | Status | Iteration |
|---|-----------|--------|-----------|
| 1 | Bootstrap package skeleton (bin CLI + pi.extensions hook, sibling-repo parity) | not started | 0 |
| 2 | Implement config layering + security preflight + `--api-key` refusal | not started | 0 |
| 3 | Implement http-server (inline router/auth/CORS/logger) + SSE heartbeat | not started | 0 |
| 4 | Implement lifecycle (SIGINT before listen, PID lockfile, 5s force-abort) | not started | 0 |
| 5 | Implement chat-completions + models-list schemas | not started | 0 |
| 6 | Implement openai↔pi translators (multi-block merge, tool full round-trip, SSE conventions, usage map, single chatcmpl-id) | not started | 0 |
| 7 | Implement cli.ts argv + `pi-gateway models` | not started | 0 |
| 8 | Implement index.ts pi-extension wrapper (slash commands, footer widget, LLM tools, detached-child spawn) | not started | 0 |
| 9 | Add smoke + real-HTTP E2E tests | not started | 0 |
| 10 | Document install (standalone + dogfood) / usage / wiring / OAuth posture / non-goals | not started | 0 |
| 11 | Add pre-commit + CI for `pnpm run check` + `pnpm run build` | not started | 0 |

## Timeline

| Action | Timestamp | Duration | Notes |
|--------|-----------|----------|-------|
| plan | 2026-05-27T00:00:00Z | - | Created |
| revise-spec | 2026-05-27T00:30:00Z | - | Reframed pi-extension → LiteLLM-shape standalone daemon |
| spec-review | 2026-05-27T01:00:00Z | - | 5 perspectives, ~36 findings |
| revise-spec | 2026-05-27T01:30:00Z | - | Merged validated findings: estimate 8h→16h; OAuth loopback default-allow; tools Must Have w/ full round-trip; multi-block merge rule; OpenAI mid-stream error convention; delta.reasoning_content; single chatcmpl-id; SSE heartbeat + anti-buffering; --api-key flag refused; PID lockfile; node:http 0.0.0.0 trap guard. Deferred (per direction): reverse-proxy warnings, body cap, supply-chain pin, abort-spike, backpressure enforcement. |
| revise-spec | 2026-05-27T02:00:00Z | - | Added pi-extension wrapper (`./index.ts`) + dogfood section. Repo now ships BOTH a standalone `bin: pi-gateway` CLI AND a `pi.extensions` hook (slash commands `/gateway:*`, footer status widget, LLM-callable tools). Package layout aligns exactly with `/home/ubuntu/pi-claude-code` + `/home/ubuntu/pi-git-worktrees` (pnpm@10.28.2, `@vllnt/*`, simple-git-hooks, GitHub Actions, AGENTS.md, `private: true`). Dogfood install: `gh repo create bntvllnt/pi-gateway --private` → add `git:git@github.com:bntvllnt/pi-gateway` to `~/.pi/agent/settings.json` packages → pi auto-clones and loads. |
