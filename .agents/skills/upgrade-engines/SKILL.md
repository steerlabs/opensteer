---
name: upgrade-engines
description: Use when bumping an engine pin, qualifying shipped or installed engines on real accounts, or adding a newly available model.
---

Read `docs/ai-engines.md` and the affected driver in `packages/harness-*`.
Update one engine per change:

```sh
pnpm engines
pnpm engines update <kind>
pnpm engines verify
pnpm check:changed --base origin/main
pnpm test:engines -- -t 'shipped Codex'
```

Replace `Codex` with the suite's engine label. Also run the `installed <label>` selection for engines declaring an installed runtime. Use dedicated spending-limited OPENAI_API_KEY/ANTHROPIC_API_KEY credentials or existing machine sign-ins; shipped qualification puts shipped bytes first on PATH. Missing sign-in or quota blocks qualification. Inspect emitted JSON artifacts under OPENSTEER_ENGINE_E2E_OUTPUT or the printed directory. Do not call skipped qualification passed.

Antigravity is downloaded rather than shipped or found on `PATH`. A pin bump must update and re-verify every platform's archive size, SHA-256 and complete member manifest in its driver, then run the `downloaded Antigravity` qualification against a temporary Runner runtime cache.

For a new model, first check the account's real engine catalog. Update its engine when required; never hardcode a model the engine cannot describe. Check native ID routing, context/output limits and options in affected driver tests. Review protocol and sandbox changes, including Codex's approved feature list. Reconnect the Runner to refresh accounts after release.

For a running local oMLX server, qualify a model that fits that computer:

```sh
OPENSTEER_LOCAL_ENDPOINT_QUALIFY=1 \
  OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS="$HOME/.omlx/settings.json" \
  OPENSTEER_LOCAL_ENDPOINT_MODEL_ID=<native-model-id> \
  pnpm test:engines -- -t 'local endpoint qualification'
```

For another endpoint use OPENSTEER_LOCAL_ENDPOINT_BASE_URL, OPENSTEER_LOCAL_ENDPOINT_API_KEY and OPENSTEER_LOCAL_ENDPOINT_CONTEXT_WINDOW; optionally set OPENSTEER_LOCAL_ENDPOINT_RUNTIME and OPENSTEER_LOCAL_ENDPOINT_MODEL_ID. Inspect the temporary transcript/artifact record (override with OPENSTEER_LOCAL_ENDPOINT_ARTIFACT_DIR). Scripted completions prove wiring only; qualify each supported engine/server combination with a real model.
