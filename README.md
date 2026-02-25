# Opensteer

Lean browser automation SDK for coding agents and script replay.

`opensteer` provides descriptor-aware actions (`click`, `dblclick`,
`rightclick`, `hover`, `input`, `select`, `scroll`, `extract`,
`extractFromPlan`, `uploadFile`), observation (`snapshot`, `state`,
`screenshot`), navigation (`goto`), and convenience methods for tabs, cookies,
keyboard, element info, and wait.

For anything not covered, use raw Playwright via `opensteer.page` and
`opensteer.context`.

## Install

```bash
# npm
npm install opensteer playwright
# pnpm
pnpm add opensteer playwright
```

## CLI Session Routing

OpenSteer CLI now separates runtime routing from selector caching:

- Runtime routing: `--session` or `OPENSTEER_SESSION`
- Selector cache namespace: `--name` or `OPENSTEER_NAME` (used on `open`)

If neither `--session` nor `OPENSTEER_SESSION` is set:

- In an interactive terminal, OpenSteer creates/reuses a terminal-scoped default session.
- In non-interactive environments (agents/CI), it fails fast unless you set
  `OPENSTEER_SESSION` or `OPENSTEER_CLIENT_ID`.

Example:

```bash
export OPENSTEER_SESSION=agent-a
opensteer open https://example.com --name product-scraper
opensteer snapshot
opensteer click 3
opensteer status
```

`opensteer status` reports `resolvedSession`, `sessionSource`, `resolvedName`, and `nameSource`.

## Quickstart

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ name: "my-scraper" }); // defaults to model: 'gpt-5.1'
await opensteer.launch({ headless: false });

await opensteer.goto("https://example.com");
const html = await opensteer.snapshot();

await opensteer.click({ description: "login-button" });
await opensteer.input({ description: "email", text: "user@example.com" });
await opensteer.page.keyboard.press("Enter");

await opensteer.close();
```

## Core Model

- `opensteer.page`: raw Playwright `Page`
- `opensteer.context`: raw Playwright `BrowserContext`
- Opensteer methods: descriptor-aware operations that can persist selectors
- Selector storage: `.opensteer/selectors/<namespace>`

## Resolution Chain

For actions like `click`/`input`/`hover`/`select`/`scroll`:

1. Use persisted path for `description` (if present)
2. Use `element` counter from snapshot
3. Use explicit CSS `selector`
4. Use built-in LLM resolution (`description` required)
5. Throw

When steps 2-4 resolve and `description` is provided, the path is persisted.

## Smart Post-Action Wait

Mutating actions (`click`, `input`, `select`, `scroll`, etc.) include a
best-effort post-action wait so delayed visual updates are usually settled
before the method resolves.

You can disable or tune this per call:

```ts
await opensteer.click({ description: "Save button", wait: false });

await opensteer.click({
  description: "Save button",
  wait: { timeout: 9000, settleMs: 900, includeNetwork: true, networkQuietMs: 400 },
});
```

## Action Failure Diagnostics

Descriptor-aware interaction methods (`click`, `dblclick`, `rightclick`,
`hover`, `input`, `select`, `scroll`, `uploadFile`) throw
`OpensteerActionError` when an interaction cannot be completed.

The error includes structured failure metadata for agent/tooling decisions:

- `error.failure.code` (`ActionFailureCode`)
- `error.failure.message`
- `error.failure.retryable`
- `error.failure.classificationSource`
- `error.failure.details` (for blocker and observation details when available)

```ts
import { Opensteer, OpensteerActionError } from "opensteer";

try {
  await opensteer.click({ description: "Save button" });
} catch (err) {
  if (err instanceof OpensteerActionError) {
    console.error(err.failure.code); // e.g. BLOCKED_BY_INTERCEPTOR
    console.error(err.failure.message);
    console.error(err.failure.classificationSource);
  }
  throw err;
}
```

## Snapshot Modes

```ts
await opensteer.snapshot(); // action mode (default)
await opensteer.snapshot({ mode: "extraction" });
await opensteer.snapshot({ mode: "clickable" });
await opensteer.snapshot({ mode: "scrollable" });
await opensteer.snapshot({ mode: "full" });
```

## Two Usage Patterns

### Explore (coding agent, no API key required)

Use `snapshot()` + `element` counters while exploring in real time, then persist
stable descriptions for replay.

### Run (script replay / built-in LLM)

Opensteer uses built-in LLM resolve/extract by default. You can override the
default model with top-level `model` or `OPENSTEER_MODEL`.

```ts
const opensteer = new Opensteer({
  name: "run-mode",
  model: "gpt-5-mini",
});
```

## Mode Selection

Opensteer defaults to local mode.

- `OPENSTEER_MODE=local` runs local Playwright.
- `OPENSTEER_MODE=cloud` enables cloud mode (requires `OPENSTEER_API_KEY`).
- `cloud: true` in constructor config always enables cloud mode.
- Opensteer auto-loads `.env` files from your `storage.rootDir` (default:
  `process.cwd()`) using this order: `.env.<NODE_ENV>.local`, `.env.local`
  (skipped when `NODE_ENV=test`), `.env.<NODE_ENV>`, `.env`.
- Existing `process.env` values are never overwritten by `.env` values.
- Set `OPENSTEER_DISABLE_DOTENV_AUTOLOAD=true` to disable auto-loading.

Cloud mode is fail-fast: it does not automatically fall back to local mode.

## Docs

- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/cloud-integration.md`
- `docs/html-cleaning.md`
- `docs/selectors.md`
- `docs/live-web-tests.md`

## License

MIT
