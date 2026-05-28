# pi-gateway

[![npm version](https://img.shields.io/npm/v/pi-gateway.svg)](https://www.npmjs.com/package/pi-gateway)
[![CI](https://github.com/bntvllnt/pi-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/bntvllnt/pi-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **OpenAI-compatible local API on top of [pi.dev](https://github.com/badlogic/pi-mono).**
> LiteLLM-shape stateless protocol translator. Re-exposes every model `pi` can reach (Anthropic, OpenAI, Google, Mistral, Bedrock, Vertex, **plus OAuth subscriptions** like Claude Pro / ChatGPT Codex / GitHub Copilot / Gemini CLI) through `POST /v1/chat/completions` + `GET /v1/models`, so Open WebUI / LibreChat / Cursor / Continue.dev / Cline can use them without re-entering credentials.

## Install

Two install paths from one package:

### 1. Standalone CLI (no pi required)

```bash
pnpm dlx pi-gateway --port 4000
# or globally
npm i -g pi-gateway && pi-gateway --port 4000
```

Runs in the foreground; Ctrl+C to stop.

### 2. Pi extension (recommended if you already use pi)

Add to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    "git:git@github.com:bntvllnt/pi-gateway"
  ]
}
```

Restart `pi`. Then inside pi:

```
/gateway:start    # spawn the daemon (detached, survives pi exit)
/gateway:status   # show url + pid + model count
/gateway:stop     # SIGTERM the daemon
```

## Wire your client

Point any OpenAI-compatible client at `http://127.0.0.1:4000/v1`. The API key field accepts any non-empty string on loopback.

<details>
<summary><b>Open WebUI</b></summary>

Settings → Connections → OpenAI API:
- **Base URL:** `http://127.0.0.1:4000/v1`
- **API key:** `pi-gateway` (any non-empty string)

Model dropdown populates from `GET /v1/models`.
</details>

<details>
<summary><b>LibreChat</b></summary>

```yaml
# librechat.yaml
endpoints:
  custom:
    - name: "pi-gateway"
      baseURL: "http://127.0.0.1:4000/v1"
      apiKey: "pi-gateway"
      models:
        fetch: true
```
</details>

<details>
<summary><b>Cursor</b></summary>

Settings → Models → "Override OpenAI Base URL" → `http://127.0.0.1:4000/v1`.

Cursor may need a bare model id alias (it can be strict about slashes). Add aliases under Settings → Models → Add Model, e.g. `claude-sonnet-4-5` → `anthropic/claude-sonnet-4-5`.
</details>

<details>
<summary><b>Continue.dev</b></summary>

```json
{
  "models": [{
    "provider": "openai",
    "apiBase": "http://127.0.0.1:4000/v1",
    "apiKey": "pi-gateway",
    "model": "anthropic/claude-sonnet-4-5",
    "title": "Claude via pi-gateway"
  }]
}
```
</details>

<details>
<summary><b>Cline (VS Code)</b></summary>

API Provider → OpenAI Compatible.
- **Base URL:** `http://127.0.0.1:4000/v1`
- **API key:** any non-empty string
- **Model:** `provider/model-id` (e.g., `openai/gpt-4o`, `anthropic/claude-sonnet-4-5`)
</details>

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/healthz` | Liveness; returns `{ ok, uptimeMs }` |
| `GET`  | `/v1/models` | OpenAI list payload; `id: "provider/model-id"` |
| `POST` | `/v1/chat/completions` | Stream + non-stream Chat Completions |

Out of scope for v1: `/v1/responses`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/*`, `/v1/messages` (Anthropic Messages format).

## What pi-gateway is — and isn't

**Is:** a stateless HTTP frontend. Validates → resolves model → resolves auth → calls `pi-ai.complete()` or `pi-ai.stream()` → translates back into OpenAI Chat Completions shape (JSON or SSE).

**Is not:**

- ❌ A pi agent. No pi `AgentSession` is created.
- ❌ A prompt injector. What the client sends is what pi-ai sees — no system prompt, no tools, no skills are added.
- ❌ A tool runner. `tools` and `tool_choice` are forwarded; the client executes and posts `role: "tool"` results.
- ❌ A conversation store. Each `POST /v1/chat/completions` is independent.

## CLI flags

| Flag | Default | Notes |
|------|---------|-------|
| `--port N` | `4000` | `0` = OS-assigned |
| `--bind HOST` | `127.0.0.1` | Non-loopback requires `apiKey` in config file |
| `--config PATH` | — | Extra JSON layered after `~/.pi/agent/gateway.json` |
| `--auth-dir PATH` | `~/.pi/agent` | Where to find `auth.json` and `models.json` |
| `--allow-origin ORIGIN` | empty | Repeatable; `"*"` = any |
| `--log-level LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `--model-allowlist ID` | — | Repeatable; matches `provider/model-id` or bare id |
| `--model-denylist ID` | — | Repeatable |
| `--expose-oauth-subscriptions` | on loopback only | Expose Claude Pro / Codex / Copilot on non-loopback too |
| `--require-key-on-loopback` | off | Force bearer auth even on `127.0.0.1` |
| `--version` | — | Print version + exit |

> **No `--api-key` flag.** Argv leaks via `/proc/<pid>/cmdline` + `ps aux`. Set the key in `~/.pi/agent/gateway.json` (`{ "apiKey": "..." }`) or via `PI_GATEWAY_API_KEY` env var.

Subcommands:

```bash
pi-gateway models    # Print available models then exit
pi-gateway --help
pi-gateway --version
```

## Security defaults

- **Default bind: `127.0.0.1`.** `server.address()` is asserted after `listening` so a refactor can't silently bind `0.0.0.0`.
- **Non-loopback bind requires `apiKey` in the config file.** CLI flag is refused.
- **PID lockfile** at `~/.pi/agent/gateway.pid` via atomic `O_CREAT|O_EXCL`. Single instance enforced; stale files cleaned automatically.
- **OAuth subscriptions default-allow on loopback** (so Claude Pro / Codex work from Open WebUI), **default-deny on non-loopback** unless `--expose-oauth-subscriptions`.
- **Access log** redacts everything outside a hardcoded allowlist (`content-type`, `content-length`, `user-agent`, `accept`, `accept-encoding`, `host`). No `authorization` / token / key headers in logs.

## Programmatic SDK

```ts
import { startServer, stopServer } from "pi-gateway";
import { DEFAULT_CONFIG } from "pi-gateway/config";  // future export

const handle = await startServer({
  config: { ...DEFAULT_CONFIG, port: 0, bindAddress: "127.0.0.1" },
});

const url = `http://${handle.address.address}:${handle.address.port}`;
const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", /* ... */ });

await stopServer(handle);
```

Used by the test suite to bind real listeners on `127.0.0.1:0` without invoking the binary.

## Development

```bash
git clone https://github.com/bntvllnt/pi-gateway.git
cd pi-gateway
pnpm install
pnpm run check   # lint + typecheck + build + smoke + e2e + contract
```

Quality gates:

| Gate | Command |
|------|---------|
| Lint | `pnpm run lint` |
| Typecheck | `pnpm run typecheck` |
| Build | `pnpm run build` |
| Smoke | `node tests/smoke.mjs` |
| E2E | `node tests/extension-e2e.mjs` |
| **Contract** | `node tests/contract.mjs` — ajv field-by-field validation against the pinned OpenAPI doc + Chat Completions schemas |

All gates run on `pre-commit` and CI.

## Schemas

`schemas/openresponses.openapi.json` pins https://www.openresponses.org/openapi/openapi.json (OpenAI API v2.3.0, 108 component schemas) in-repo to avoid drift. The contract test loads this file and rejects any response that doesn't match.

## License

[MIT](LICENSE) © [bntvllnt](https://github.com/bntvllnt)

## See also

- [CHANGELOG.md](CHANGELOG.md) — release notes; tags link to the matching section
- [llms.txt](llms.txt) — short hub for AI consumption
- [llms-full.txt](llms-full.txt) — full reference for AI consumption
- [CLAUDE.md](CLAUDE.md) — project rules + contract guarantees
- [pi.dev](https://github.com/badlogic/pi-mono) — the underlying agent runtime
- [pi-claude-code](https://github.com/bntvllnt/pi-claude-code), [pi-git-worktrees](https://github.com/bntvllnt/pi-git-worktrees) — sibling pi extensions
