# Oversteer

Lean browser automation SDK for coding agents and script replay.

`oversteer` wraps only operations that need descriptor resolution (`snapshot`,
`click`, `dblclick`, `rightclick`, `hover`, `input`, `select`, `scroll`,
`extract`, `extractFromPlan`, `state`).

Everything else is raw Playwright via `ov.page` and `ov.context`.

## Install

```bash
npm install oversteer playwright
```

## Quickstart

```ts
import { Oversteer } from "oversteer";

const ov = new Oversteer({ name: "my-scraper" }); // defaults to model: 'gpt-5.1'
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
- Oversteer methods: descriptor-aware operations that can persist selectors
- Selector storage: `.oversteer/selectors/<namespace>`

## Resolution Chain

For actions like `click`/`input`/`hover`/`select`/`scroll`:

1. Use persisted path for `description` (if present)
2. Use `element` counter from snapshot
3. Use explicit CSS `selector`
4. Use built-in LLM resolution (`description` required)
5. Throw

When steps 2-4 resolve and `description` is provided, the path is persisted.

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

Oversteer uses built-in LLM resolve/extract by default. You can override the
default model with top-level `model` or `OVERSTEER_MODEL`.

```ts
const ov = new Oversteer({
  name: "run-mode",
  model: "gpt-5-mini",
});
```

## Docs

- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/html-cleaning.md`
- `docs/selectors.md`
- `docs/live-web-tests.md`

## License

MIT
