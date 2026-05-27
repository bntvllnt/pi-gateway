# pi-gateway

OpenAI-compatible local API on top of [pi.dev](https://github.com/badlogic/pi-mono). LiteLLM-shape: a stateless protocol translator that re-exposes every model pi can reach (Anthropic, OpenAI, Google, Mistral, Groq, Bedrock, Vertex, plus OAuth subscriptions like Claude Pro / ChatGPT Codex / GitHub Copilot / Gemini CLI) via `POST /v1/chat/completions` and `GET /v1/models` — so Open WebUI, LibreChat, Cursor, Continue.dev, Cline, or any OpenAI-compat client can use them without re-entering credentials.

The package ships in two shapes from the same repo:

1. **Pi extension** (recommended) — add to `~/.pi/agent/settings.json` `packages` and use `/gateway:start` from inside pi. The slash command spawns the binary as a **detached child** so the daemon survives pi session shutdown.
2. **Standalone CLI** — run `pi-gateway --port 4000` directly; Ctrl+C to stop.

## Non-goals

- Not an agent: no pi `AgentSession` is created, no system prompt is injected, no tools are executed by pi-gateway (tools are forwarded; the client executes and posts `role: "tool"` results).
- No conversation memory: every request is independent.

## Install — via pi (recommended)

```bash
# 1) Clone & install
git clone git@github.com:bntvllnt/pi-gateway.git ~/dev/pi-gateway
cd ~/dev/pi-gateway
pnpm install
pnpm run build

# 2) Wire it into ~/.pi/agent/settings.json
#    Add to the "packages" array:
#      "git:git@github.com:bntvllnt/pi-gateway"
#    Pi auto-clones to ~/.pi/agent/git/github.com/bntvllnt/pi-gateway/ on next session start.
```

Inside pi:

```
/gateway:start    # spawn the daemon (detached, survives pi exit)
/gateway:status   # show URL + model count + pid
/gateway:stop     # SIGTERM the daemon
```

The footer shows `Gateway: running · http://127.0.0.1:4000 · N models` while the daemon is up.

## Install — standalone

```bash
git clone git@github.com:bntvllnt/pi-gateway.git
cd pi-gateway
pnpm install && pnpm run build
node dist/cli.js --port 4000
# or, after `npm i -g .`:
pi-gateway --port 4000
```

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

**No `--api-key` flag.** Argv leaks via `/proc/<pid>/cmdline` + `ps aux`. Set the key in `~/.pi/agent/gateway.json` (`{ "apiKey": "..." }`) or via `PI_GATEWAY_API_KEY` env var.

## Wiring an OpenAI-compat client

### Open WebUI

Settings → Connections → OpenAI API:

- Base URL: `http://127.0.0.1:4000/v1`
- API key: any non-empty string (e.g. `pi-gateway`) — Open WebUI requires the field be non-empty even on loopback.

### LibreChat

```yaml
# librechat.yaml
endpoints:
  custom:
    - name: "pi-gateway"
      baseURL: "http://127.0.0.1:4000/v1"
      apiKey: "pi-gateway"
      models:
        default: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-1.5-pro"]
        fetch: true
```

### Cursor

Settings → Models → Override OpenAI Base URL → `http://127.0.0.1:4000/v1`. Cursor's model field may need a bare id alias (it can be strict about slashes in some versions); add aliases under Settings → Models → Add Model.

### Continue.dev

```json
{
  "models": [{
    "provider": "openai",
    "apiBase": "http://127.0.0.1:4000/v1",
    "apiKey": "pi-gateway",
    "model": "anthropic/claude-sonnet-4-5",
    "title": "Claude (via pi-gateway)"
  }]
}
```

## OAuth-subscription posture

OAuth-backed providers (Claude Pro/Max, ChatGPT Plus/Pro Codex, GitHub Copilot, Google Gemini CLI, Google Antigravity) are **default-allowed on loopback** because loopback access ≈ same-user pi CLI access. They are **default-denied on non-loopback** unless `--expose-oauth-subscriptions` (or `exposeOAuthSubscriptions: true` in config) is set, because re-exposing personal-use subscriptions to LAN clients may violate provider ToS.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET`  | `/healthz` | Liveness; returns `{ ok: true, uptimeMs }`. |
| `GET`  | `/v1/models` | Lists every available model as `data[].id = "provider/model-id"`. |
| `POST` | `/v1/chat/completions` | Stream + non-stream Chat Completions. |

Out of scope for v1: `POST /v1/responses`, `POST /v1/embeddings`, `POST /v1/images/generations`, `POST /v1/messages` (Anthropic Messages format).

## Troubleshooting

- **Pi auto-clone fails for a private repo.** The `git:git@github.com:...` form is SSH; verify `ssh -T git@github.com` returns your username. If not, add an SSH key at github.com/settings/keys.
- **`gh repo create` fails.** Confirm `gh auth status` lists `repo` scope. If not: `gh auth refresh -s repo`.
- **Cursor says "model not found".** Cursor's URL builder may strip the slash; add an alias mapping `claude-sonnet-4-5` → `anthropic/claude-sonnet-4-5`.
- **Open WebUI shows truncated reply with no error.** Likely an SSE buffering issue behind nginx. pi-gateway sets `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`; verify the proxy is honoring them.

## Architecture

```
client (Open WebUI / Cursor / etc.)
        │ POST /v1/chat/completions
        ▼
┌──────────────────────────────────────────────┐
│ pi-gateway (node:http daemon)                │
│   validate (Typebox)                          │
│   resolve Model via ModelRegistry             │
│   translate OAI → pi-ai Context               │
│   stream/complete (pi-ai)                     │
│   translate pi-ai → SSE / JSON                │
└──────────────────────────────────────────────┘
        │ uses as libraries
        ▼
@mariozechner/pi-coding-agent  AuthStorage, ModelRegistry
@mariozechner/pi-ai            complete(), stream()
~/.pi/agent/auth.json          reused (no duplication)
```

## License

Private — owned by [bntvllnt](https://github.com/bntvllnt).
