# Changelog

## Unreleased

- Breaking: CLI runtime routing now uses `--session`/`OPENSTEER_SESSION` instead
  of `--name`/cwd/active-session fallback.
- Breaking: non-interactive CLI calls now require explicit runtime identity via
  `--session`, `OPENSTEER_SESSION`, or `OPENSTEER_CLIENT_ID`.
- Added `OPENSTEER_CLIENT_ID` support for stable client-scoped default session
  binding.
- CLI `--name` is now selector-cache namespace only and no longer controls
  daemon/browser routing.
- Added per-session daemon startup locking + stale-lock recovery and ping-based
  health checks to remove startup races across concurrent commands.
- Added strict in-daemon request serialization for session commands, while
  keeping `ping` out of the queue for reliable liveness checks.
- Breaking: removed legacy `ai` config from `OpensteerConfig`; use top-level `model` instead.
- Breaking: `OPENSTEER_AI_MODEL` is no longer supported; use `OPENSTEER_MODEL`.
- Breaking: `OPENSTEER_RUNTIME` is no longer supported; use `OPENSTEER_MODE`.
- Breaking: constructor runtime selection now uses `cloud` (`cloud: true` or `cloud` options object); legacy `mode`/`remote` config is removed.
- Breaking: `OPENSTEER_MODE` now uses `local` or `cloud`; `remote` is no longer a supported value.
- Opensteer now enables built-in LLM resolve/extract by default with model `gpt-5.1`.
- Cloud mode now falls back to `OPENSTEER_API_KEY` when `cloud.apiKey` is omitted.
- Added automatic `.env` loading from `storage.rootDir` (default `process.cwd()`) so constructor config can consume env vars without requiring `import 'dotenv/config'`.
- `.env` autoload follows common precedence (`.env.<NODE_ENV>.local`, `.env.local`, `.env.<NODE_ENV>`, `.env`) with `.env.local` skipped in `test`, does not overwrite existing env values, and can be disabled via `OPENSTEER_DISABLE_DOTENV_AUTOLOAD`.
- Mutating actions now include smart best-effort post-action wait with per-action
  profiles and optional per-call overrides via `wait`.
- Added structured interaction diagnostics via `OpensteerActionError` for
  descriptor-aware interaction methods (`click`, `dblclick`, `rightclick`,
  `hover`, `input`, `select`, `scroll`, `uploadFile`).
- Added `ActionFailure` types (`ActionFailureCode`, `retryable`,
  `classificationSource`, optional `details`) to support programmatic handling
  of action failures.
- Added DOM actionability probe + Playwright call-log classification to report
  reasons like `BLOCKED_BY_INTERCEPTOR`, `NOT_VISIBLE`, `NOT_EDITABLE`, and
  timeout/stale-target cases more accurately.
- Added one-shot local selector self-healing for cached descriptor replay:
  when cached paths fail with `TARGET_NOT_FOUND`, Opensteer retries once with
  AI resolution from `description`, refreshes cache on success, and preserves
  the original failure if healing does not succeed.
- Added cached extraction replay self-healing: when persisted extraction paths
  are unresolved and `description` is provided, Opensteer performs one AI
  re-plan and refreshes persisted extraction paths.
- Cloud action failures now accept optional structured failure details and map
  them to `OpensteerActionError` when available.
- Docs: refreshed README and getting-started guidance to match current SDK/CLI
  behavior and env vars.
- Docs: added CLI reference and docs index.
- OSS community docs: expanded `CONTRIBUTING.md` and added `SECURITY.md` +
  `SUPPORT.md`.

## 0.1.0

- Initial open-source release.
