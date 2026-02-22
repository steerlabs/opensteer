# Opensteer

Lean browser automation SDK for coding agents and script replay.

`opensteer` wraps only operations that need descriptor resolution (`snapshot`,
`click`, `dblclick`, `rightclick`, `hover`, `input`, `select`, `scroll`,
`extract`, `extractFromPlan`, `state`).

Everything else is raw Playwright via `ov.page` and `ov.context`.

## Install

```bash
# npm
npm install opensteer playwright
# pnpm
pnpm add opensteer playwright
```

## Quickstart

```ts
import { Opensteer } from "opensteer";

const ov = new Opensteer({ name: "my-scraper" }); // defaults to model: 'gpt-5.1'
await ov.launch({ headless: false });

await ov.page.goto("https://example.com");
const html = await ov.snapshot();

await ov.click({ description: "login-button" });
await ov.input({ description: "email", text: "user@example.com" });
await ov.page.keyboard.press("Enter");

await ov.close();
```

## Core Model

- `ov.page`: raw Playwright `Page`
- `ov.context`: raw Playwright `BrowserContext`
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
await ov.click({ description: "Save button", wait: false });

await ov.click({
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
  await ov.click({ description: "Save button" });
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
await ov.snapshot(); // action mode (default)
await ov.snapshot({ mode: "extraction" });
await ov.snapshot({ mode: "clickable" });
await ov.snapshot({ mode: "scrollable" });
await ov.snapshot({ mode: "full" });
```

## Two Usage Patterns

### Explore (coding agent, no API key required)

Use `snapshot()` + `element` counters while exploring in real time, then persist
stable descriptions for replay.

### Run (script replay / built-in LLM)

Opensteer uses built-in LLM resolve/extract by default. You can override the
default model with top-level `model` or `OPENSTEER_MODEL`.

```ts
const ov = new Opensteer({
  name: "run-mode",
  model: "gpt-5-mini",
});
```

## Docs

- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/cloud-integration.md`
- `docs/html-cleaning.md`
- `docs/selectors.md`
- `docs/live-web-tests.md`

## License

MIT
