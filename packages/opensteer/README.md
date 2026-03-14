# Opensteer Package

`opensteer` is the Phase 6 product surface for the rewrite. It exposes:

- a semantic SDK with session continuity inside one process
- a thin JSON-first CLI
- a local per-session service so CLI commands can share one live browser session
- HTML-first snapshots, DOM action replay, descriptor persistence, traces, and artifacts

## Install

```bash
pnpm add opensteer
pnpm exec playwright install chromium
```

## SDK

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "docs-example",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com");
  const snapshot = await opensteer.snapshot("action");
  const firstButton = snapshot.counters.find((counter) => counter.tagName === "BUTTON");
  if (firstButton) {
    await opensteer.click({
      element: firstButton.element,
      description: "primary button",
    });
  }

  const extracted = await opensteer.extract({
    description: "page summary",
    schema: {
      url: { source: "current_url" },
      title: { selector: "title" },
    },
  });

  console.log(snapshot.html);
  console.log(extracted);
} finally {
  await opensteer.close();
}
```

## CLI

```bash
opensteer open https://example.com --name docs-example --headless true
opensteer snapshot action --name docs-example
opensteer click 3 --name docs-example --description "primary button"
opensteer extract --name docs-example --description "page summary" \
  --schema '{"url":{"source":"current_url"},"title":{"selector":"title"}}'
opensteer close --name docs-example
```

Each CLI command prints JSON to stdout. Browser state does not live in the CLI process. It lives
in the local session service recorded under `.opensteer/runtime/sessions/<name>/service.json`.

## Session Root

By default, Opensteer writes into:

```text
<cwd>/.opensteer
```

Important subtrees:

```text
.opensteer/
  artifacts/
  traces/
  registry/
  runtime/
    sessions/
```

## Public Methods

- `open(url?)`
- `goto(url)`
- `snapshot("action" | "extraction")`
- `click({ element | selector | description })`
- `hover({ element | selector | description })`
- `input({ element | selector | description, text })`
- `scroll({ element | selector | description, direction, amount })`
- `extract({ description, schema? })`
- `close()`

`element` targets use counters from the latest snapshot. `description` replays a stored descriptor.
`selector` resolves a CSS selector directly and, when not explicitly scoped, searches the current
page before falling back to child frames.
