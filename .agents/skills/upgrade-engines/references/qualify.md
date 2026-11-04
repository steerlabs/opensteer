# Bump and qualify engines

Update one engine per change:

```sh
pnpm engines
pnpm engines update <kind>
pnpm engines verify
pnpm check:changed --base origin/main
pnpm test:engines -- -t 'shipped Codex'
```

Replace `Codex` with the suite's engine label, and also run `installed <label>` for engines that
declare an installed runtime. Shipped qualification puts the shipped bytes first on `PATH`. Inspect
the JSON artifacts under `OPENSTEER_ENGINE_E2E_OUTPUT` or the printed directory.

- **Antigravity** is downloaded, not shipped or taken from `PATH`. A bump updates and re-verifies
  every platform's archive size, SHA-256 and full member manifest in
  [release.ts](../../../../packages/harness-antigravity/src/release.ts), then runs
  `downloaded Antigravity` against a temporary Runner runtime cache.
- **Sign-in timeout**: `apps/host/src/browser/password-sign-in-timeout.engine.test.ts` needs a
  throwaway PostgreSQL database, engine accounts and binaries, and writes one artifact per engine to
  `OPENSTEER_ENGINE_E2E_OUTPUT`.
- **New models**: check the account's real engine catalog first and update the engine if required;
  never hardcode a model the engine cannot describe. Check native ID routing, context and output
  limits and options in the driver tests, and review protocol and sandbox changes, including Codex's
  approved features. Reconnect the Runner after release to refresh accounts. Review the role
  rankings in `packages/core/src/background-models.ts` too: drivers derive their small model from
  them, and one account missing a ranked model doesn't mean it's retired.

## Local model servers

For a running local oMLX server, qualify a model that fits the computer:

```sh
OPENSTEER_LOCAL_ENDPOINT_QUALIFY=1 \
  OPENSTEER_LOCAL_ENDPOINT_OMLX_SETTINGS="$HOME/.omlx/settings.json" \
  OPENSTEER_LOCAL_ENDPOINT_MODEL_ID=<native-model-id> \
  pnpm test:engines -- -t 'local endpoint qualification'
```

For another endpoint set `OPENSTEER_LOCAL_ENDPOINT_BASE_URL`, `OPENSTEER_LOCAL_ENDPOINT_API_KEY` and
`OPENSTEER_LOCAL_ENDPOINT_CONTEXT_WINDOW`, optionally `OPENSTEER_LOCAL_ENDPOINT_RUNTIME` and
`OPENSTEER_LOCAL_ENDPOINT_MODEL_ID`. Inspect the transcript and artifact record
(`OPENSTEER_LOCAL_ENDPOINT_ARTIFACT_DIR` overrides). Qualify each supported engine and server
combination with a real model.
