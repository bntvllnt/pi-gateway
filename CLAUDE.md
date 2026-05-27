# CLAUDE.md — pi-gateway project rules

Project rules for AI assistants (Claude Code, Codex, etc.) working in this repository. Conventions are enforced by tests + lint + CI; AGENT-readable here so we don't drift.

## Mission

pi-gateway is a **stateless OpenAI-compatible HTTP frontend** on top of pi.dev's multi-provider routing. Open WebUI / LibreChat / LiteLLM consumers / Cursor / Continue.dev / Cline can point their OpenAI base URL at pi-gateway and use every model `pi` can reach (including OAuth subscriptions like Claude Pro / Codex / Copilot / Gemini CLI). Two install paths from one repo: standalone CLI (`pi-gateway --port 4000`) and pi-extension wrapper (`/gateway:start` from inside `pi`).

## Non-goals (BLOCKING — do NOT add)

1. No pi `AgentSession` is created at any point in the request path.
2. No system prompt, tools, or skills are injected by pi-gateway. What the client sends is exactly what pi-ai sees (modulo schema-level translation).
3. No tool *execution*. `tools` + `tool_choice` are forwarded; the client executes and posts `role: "tool"` results.
4. No conversation state. Each `POST /v1/chat/completions` is independent.
5. No TLS in-process. Front with Caddy / Tailscale Funnel / ngrok.
6. No `--api-key` CLI flag. Argv leaks via `/proc/<pid>/cmdline` + `ps aux`. Use `~/.pi/agent/gateway.json` or `PI_GATEWAY_API_KEY`.

## Source of truth — OpenAPI spec

`schemas/openresponses.openapi.json` is pinned in-repo (openresponses.org, OpenAI API v2.3.0). When adding endpoints / changing response shapes, **bring the validator in line first**, not the other way around. The contract test (`tests/contract.mjs`) loads this file and validates every response against ajv-compiled component schemas + locally-pinned Chat Completions schemas.

- The pinned spec defines `POST /responses` and `POST /responses/compact` only (the **Responses API**). Pi-gateway v1 implements `POST /v1/chat/completions` (**Chat Completions API**). Chat Completions schemas are pinned inline in `tests/contract.mjs` from the published OpenAI reference.
- When pi-gateway adds `/v1/responses` (v1.1+), the request/response validators come straight from the pinned OpenAPI doc.
- The pinned doc is updated by re-running `node -e "(async()=>{const r=await fetch('https://www.openresponses.org/openapi/openapi.json');require('fs').writeFileSync('schemas/openresponses.openapi.json', await r.text())})()"` from the repo root. Commit the diff. The contract test fails CI if the schemas drift away from what we serve.

## Hard contract rules (pi-gateway responses)

Every HTTP response MUST satisfy:

| Endpoint | Field | Rule |
|----------|-------|------|
| All errors | `error.type`, `error.message`, `error.code`, `error.param` | OpenAI-shape error envelope (matches `tests/contract.mjs` `OpenAIErrorEnvelopeSchema`). |
| `GET /v1/models` | `id` | Always `provider/model-id` (Open WebUI / LiteLLM / OpenRouter convention). Stable sort. |
| `GET /v1/models` | filtering | OAuth-subscription providers default-allow on loopback, default-deny on non-loopback. Override via `--expose-oauth-subscriptions`. |
| `POST /v1/chat/completions` (non-stream) | `id`, `object: "chat.completion"`, `system_fingerprint`, `choices[].logprobs: null`, `usage` | Required. |
| `POST /v1/chat/completions` (stream) | `id`, `object: "chat.completion.chunk"`, `system_fingerprint`, `choices[].logprobs: null` | Single `chatcmpl-<ulid>` reused across every chunk + the non-stream envelope. |
| `POST /v1/chat/completions` (stream) | SSE framing | `data: { ... }\n\n` per chunk; terminator `data: [DONE]\n\n`. NO `[DONE]` after a mid-stream error. |
| `POST /v1/chat/completions` (stream) | headers | `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Heartbeat `: heartbeat\n\n` every 15s during silent periods. |
| Mid-stream error | wire frame | `data: {"error":{...}}\n\n` then close. **NO trailing `data: [DONE]`.** (OpenAI mid-stream convention; clients render error only when shaped this way.) |
| Tool calls | `tool_calls.function.arguments` | Always a JSON string (NEVER an object). |
| Thinking content | `delta.reasoning_content` | OpenRouter / Ollama convention. NEVER in non-stream `choices[].message.content`. |
| Multi-block content | non-stream `content` | Concatenate text blocks with `\n\n`. Thinking blocks dropped (streamed only). |
| Usage | `prompt_tokens`, `completion_tokens`, `total_tokens` | Map from pi-ai `input` / `output` / sum. |
| Stop reason | `finish_reason` | Map: `stop`→`stop`, `length`→`length`, `toolUse`→`tool_calls`, `error`→5xx (not 200), `aborted`→`stop` (or 499 if non-stream). |

## Security defaults (BLOCKING)

- Default bind: `127.0.0.1`. Assert `server.address().address` matches resolved host AFTER `listening` event (Node's `listen(port)` default is `0.0.0.0`).
- Non-loopback bind requires `apiKey` in the config file. Never a CLI flag.
- PID lockfile at `~/.pi/agent/gateway.pid`, atomic `fs.openSync(path, "wx")` (`O_CREAT|O_EXCL`). On EEXIST probe liveness with `process.kill(pid, 0)`; stale → unlink + retry once.
- SIGINT/SIGTERM handlers registered BEFORE `listen()`. Abort in-flight pi-ai streams via `AbortSignal`. Allow up to `forceAbortTimeoutMs` (5s default) for sockets to flush final SSE frames.
- Hardcoded redaction allowlist for access-log headers: `content-type`, `content-length`, `user-agent`, `accept`, `accept-encoding`, `host`. Everything else (including `authorization`, anything matching `*token*` / `*key*` / `*secret*` case-insensitive) is omitted.

## Test gates (BLOCKING — run as `pnpm run check`)

1. `pnpm run lint` — eslint
2. `pnpm run typecheck` — tsc --noEmit
3. `pnpm run build` — emit `dist/cli.js` via `tsconfig.build.json`
4. `pnpm test` — three suites in order:
   - `tests/smoke.mjs` — jiti-load `index.ts` (mock ExtensionAPI); bind 127.0.0.1:0; assert /healthz + /v1/models
   - `tests/extension-e2e.mjs` — real HTTP against the bound server; error paths
   - `tests/contract.mjs` — ajv-validate every response shape against the pinned OpenAPI + Chat Completions schemas

All four gates must pass before any commit (`simple-git-hooks` pre-commit) and on CI.

## Architectural patterns

### Hybrid package (standalone CLI + pi extension)

| Surface | Entry | Loaded via |
|---------|-------|-----------|
| Standalone CLI | `dist/cli.js` (built from `src/cli.ts`) | `bin: pi-gateway` field in `package.json` |
| Pi extension | `index.ts` | `pi.extensions: ["./index.ts"]` field; jiti-loaded inside the pi runtime |

The extension spawns the standalone binary as a **detached child** via `process.execPath` + `child.unref()` (mirrors `/home/ubuntu/pi-claude-code/index.ts:187 launchDetachedRunner`). Binary resolution: prefer `dist/cli.js`; fall back to `src/cli.ts` via jiti when `dist/` is absent (pi's auto-install path doesn't build).

### Dependencies (NOT peer)

`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@sinclair/typebox` are **runtime dependencies** (not peerDeps) because the standalone CLI needs them at process start. Pi-managed installs also work because the same deps satisfy the pi runtime. Siblings (pi-claude-code, pi-git-worktrees) use peerDeps because they have no bin — pi-gateway differs by design.

### Programmatic API separate from CLI

`src/server/index.ts` exports `startServer({...})` / `stopServer(handle)` so tests can bind a real listener on `127.0.0.1:0` without invoking the self-executing `dist/cli.js`. The CLI imports from this module; never the other way around.

## When in doubt

1. **Adding an endpoint** → Add component schemas to the pinned `openresponses.openapi.json` (or `tests/contract.mjs`'s inline schemas) FIRST. Add the ajv validation in `tests/contract.mjs`. Then implement. Then `pnpm run check`.
2. **Changing a response shape** → Update the schema first. The contract test will fail until the implementation catches up. This is the desired direction.
3. **A test fails because the upstream provider needs something pi-gateway doesn't provide** → Surface the upstream error as HTTP 502 with the OpenAI error envelope. **Never** silently translate to 200 with empty content.
4. **Stuck on a translator detail** → Read the equivalent surface in pi-claude-code (`/home/ubuntu/pi-claude-code/`) or pi-git-worktrees (`/home/ubuntu/pi-git-worktrees/`). The package layout and conventions are aligned with those siblings.

## File layout

```
.
├── index.ts                  Pi-extension entry (slash commands, footer, tools, detached-child spawn)
├── src/
│   ├── cli.ts                Standalone CLI entry → dist/cli.js
│   ├── config.ts             Layered config (CLI → env → ~/.pi/agent/gateway.json → defaults)
│   ├── lifecycle.ts          State machine + atomic PID lockfile + signal wiring
│   ├── protocol/             Typebox schemas (chat-completions, models-list)
│   ├── translate/            openai-to-pi, pi-to-openai (multi-block merge, SSE conventions), model-id
│   └── server/
│       ├── index.ts          Programmatic API (startServer/stopServer) for tests
│       └── http-server.ts    node:http + inline router/auth/CORS/logger + SSE heartbeat
├── schemas/
│   └── openresponses.openapi.json   Pinned OpenAI Responses API v2.3.0 — single source of truth
├── tests/
│   ├── smoke.mjs             Registration + server bind + /healthz + /v1/models
│   ├── extension-e2e.mjs     Real HTTP against bound server; error paths
│   └── contract.mjs          ajv field-by-field schema validation against pinned spec
├── scripts/                  Build + git-hooks helpers
├── .github/workflows/ci.yml  pnpm run check on push + PR
└── .githooks/pre-commit      pnpm run check before every commit
```
