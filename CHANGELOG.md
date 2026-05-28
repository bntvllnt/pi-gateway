# Changelog

All notable changes to **pi-gateway** are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released entry is linked from the matching git tag on GitHub. The release workflow (`.github/workflows/publish.yml`) extracts the section for the version being released and uses it as the GitHub Release body.

## [Unreleased]

### Changed

- Migrated pi runtime dependencies from the deprecated `@mariozechner/pi-*` namespace to `@earendil-works/pi-*` at `^0.75.4` (latest mature version under the 7-day minimum-release-age policy). No public API changes.
- Contract test now validates the OpenAI error envelope on non-200 responses and on mid-stream error frames (which correctly omit the trailing `data: [DONE]` per OpenAI's mid-stream error convention). CI passes without provider auth.
- Publish workflow's canary job gated on `vars.ENABLE_CANARY == 'true'`. Set via `gh variable set ENABLE_CANARY --body 'true' --repo bntvllnt/pi-gateway` once npm trusted-publisher is configured.

### Fixed

- Contract test no longer fails when no provider auth is configured (CI environment).

### Added

- `CHANGELOG.md` (this file). Release workflow now extracts the version's section as the GitHub Release body.

## [0.1.0] - 2026-05-27

### Added

- Initial public release.
- **Standalone CLI daemon** (`pi-gateway --port 4000`) implementing OpenAI Chat Completions on top of pi.dev's multi-provider routing.
- **Pi extension wrapper** (`/gateway:start`, `/gateway:stop`, `/gateway:status` slash commands; footer status widget; LLM-callable tools) that spawns the daemon as a detached child process surviving pi session shutdown.
- **Endpoints**: `GET /healthz`, `GET /v1/models` (with `provider/model-id` naming), `POST /v1/chat/completions` (stream + non-stream).
- **Stream conventions**: single `chatcmpl-<id>` reused across every SSE chunk; `logprobs: null` and `system_fingerprint: fp_pi_<hex>` per OpenAI shape; `delta.reasoning_content` for thinking blocks (OpenRouter / Ollama convention); multi-block content merge rule (thinking dropped from non-stream `content`); OpenAI mid-stream error convention (no trailing `[DONE]` after error frame); heartbeat `: heartbeat\n\n` every 15s; anti-buffering headers (`X-Accel-Buffering: no`).
- **Security defaults**: `127.0.0.1` bind only; non-loopback requires `apiKey` in the config file (CLI flag refused); PID lockfile at `~/.pi/agent/gateway.pid` with atomic `O_CREAT|O_EXCL`; SIGINT/SIGTERM handlers registered before `listen()`; access log redacts everything outside an allowlist.
- **OAuth-subscription posture**: providers like Claude Pro / ChatGPT Codex / GitHub Copilot / Gemini CLI default-allow on loopback (so they appear in Open WebUI), default-deny on non-loopback unless `--expose-oauth-subscriptions`.
- **Schema validation**: ajv-driven contract test validates every response field-by-field against the pinned OpenAPI document (`schemas/openresponses.openapi.json`) plus locally-pinned Chat Completions schemas.
- **Programmatic SDK**: `startServer({...})` / `stopServer(handle)` exports from `pi-gateway` (`dist/server/index.js`).
- Project rules in `CLAUDE.md`; AI-consumption hubs in `llms.txt` + `llms-full.txt`; sibling-repo-aligned package layout (pnpm@10.28.2, `@vllnt/eslint-config`, `simple-git-hooks`, GitHub Actions CI on `pnpm run check`).
- MIT license.

[Unreleased]: https://github.com/bntvllnt/pi-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bntvllnt/pi-gateway/releases/tag/v0.1.0
