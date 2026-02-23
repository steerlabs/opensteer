# Changelog

## Unreleased

- Breaking: removed legacy `ai` config from `OpensteerConfig`; use top-level `model` instead.
- Breaking: `OPENSTEER_AI_MODEL` is no longer supported; use `OPENSTEER_MODEL`.
- Breaking: `OPENSTEER_RUNTIME` is no longer supported; use `OPENSTEER_MODE`.
- Breaking: mode selection now uses `mode: 'local' | 'remote'` and remote credentials use `remote.apiKey`.
- Opensteer now enables built-in LLM resolve/extract by default with model `gpt-5.1`.
- Remote mode now falls back to `OPENSTEER_API_KEY` when `remote.apiKey` is omitted.
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
- Remote action failures now accept optional structured failure details and map
  them to `OpensteerActionError` when available.

## 0.1.0

- Initial open-source release.
