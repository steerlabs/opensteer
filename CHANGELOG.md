# Changelog

## Unreleased

- Breaking: removed legacy `ai` config from `OpensteerConfig`; use top-level `model` instead.
- Breaking: `OPENSTEER_AI_MODEL` is no longer supported; use `OPENSTEER_MODEL`.
- Opensteer now enables built-in LLM resolve/extract by default with model `gpt-5.1`.
- Cloud mode now falls back to `OPENSTEER_API_KEY` when `cloud.key` is omitted.
- Mutating actions now include smart best-effort post-action wait with per-action
  profiles and optional per-call overrides via `wait`.

## 0.1.0

- Initial open-source release.
