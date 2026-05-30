# Changelog

All notable changes to **pi-gateway** are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released entry is linked from the matching git tag on GitHub. The release workflow (`.github/workflows/publish.yml`) extracts the section for the version being released and uses it as the GitHub Release body.

## [Unreleased]

## [0.2.0] - 2026-05-30

### Added

- Request body size cap (16 MB) — oversized `POST /v1/chat/completions` payloads return HTTP 413 (#14).
- Loopback `Host` header validation — requests to a loopback bind with an unexpected `Host` return HTTP 403 `invalid_host`, guarding against DNS-rebinding from browser-based clients (#14).
- HTTP server timeouts: headers 30s, request 120s, keep-alive 5s (#14).
- Deterministic contract + E2E test coverage using pi-ai's `faux` provider; added lifecycle and security tests (#14).
- Side-effect-labeled extension tool descriptions (`gateway_start` / `gateway_stop` note "Side effect: …"; `gateway_status` notes "Read-only") (#14).
- `pi-package` keyword in `package.json` so the package is indexed by the [pi.dev package gallery](https://pi.dev/packages), which lists only npm packages tagged with that exact keyword.
- `CHANGELOG.md`. The release workflow extracts the version's section as the GitHub Release body.

### Changed

- Migrated pi runtime dependencies from the deprecated `@mariozechner/pi-*` namespace to `@earendil-works/pi-*` at `^0.75.4` (latest mature version under the 7-day minimum-release-age policy). No public API changes.
- Supported OpenAI request parameters are forwarded to pi-ai; unsupported parameters (`frequency_penalty`, `presence_penalty`, `response_format`, `seed`, `stop`, `top_p`, `user`) are now rejected deterministically rather than silently ignored, so clients get an explicit error instead of unexpected output (#14).
- Centralized config security validation (`validateGatewayConfigSecurity`) and assert the bound address after `listen()` (#14).
- Extension daemon: log to a file, sanitize the detached child's environment, and cap the footer health-probe response body (#14).
- Contract test validates the OpenAI error envelope on non-200 responses and on mid-stream error frames (which correctly omit the trailing `data: [DONE]` per OpenAI's mid-stream error convention). CI passes without provider auth.
- Publish workflow's canary job gated on `vars.ENABLE_CANARY == 'true'`; enabled per push to `main` once npm trusted-publishing is configured.

### Fixed

- Hardened auth/bind invariants and OpenAI error envelopes across the request path (#14, closes #6–#13).
- Contract test no longer fails when no provider auth is configured (CI environment).

### Security

- Loopback `Host`-header guard prevents DNS-rebinding access from browser-based clients on the same machine (#14).

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

[Unreleased]: https://github.com/bntvllnt/pi-gateway/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bntvllnt/pi-gateway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bntvllnt/pi-gateway/releases/tag/v0.1.0
