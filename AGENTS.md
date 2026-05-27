# AGENTS.md

## Pi documentation

All Pi documentation is in:

- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs

## Architecture

Pi-gateway is a **stateless OpenAI-compatible HTTP frontend** to pi.dev's multi-provider routing. Two install paths:

1. **Standalone CLI** — `dist/cli.js` runs a foreground daemon (`pi-gateway --port 4000`); uses `@earendil-works/pi-coding-agent` (`AuthStorage` + `ModelRegistry`) and `@earendil-works/pi-ai` (`complete` / `stream`) as libraries; never creates a pi `AgentSession`.
2. **Pi extension** — `index.ts` registers `/gateway:*` slash commands + footer status widget + LLM-callable tools. Slash commands spawn the standalone binary as a detached child via `process.execPath` + `child.unref()` (pattern from `/home/ubuntu/pi-claude-code/index.ts:187 launchDetachedRunner`). The detached child's PID is recorded in `~/.pi/agent/gateway.pid` (single-instance lockfile, atomic `fs.openSync(path, 'wx')`).

## Non-goals

- No pi agent session is created by the daemon.
- No system prompt, tools, or skills are injected by pi-gateway.
- Tools are forwarded only; clients execute tool calls and post `role: "tool"` results.
- No conversation memory; each `POST /v1/chat/completions` is independent.

## Testing

- Smoke test jiti-loads `index.ts` and asserts registrations without binding any port.
- E2E test spawns the built binary against a `faux` pi-ai provider on `127.0.0.1:0` and exercises real HTTP.
