# Opensteer Package

`opensteer` is the product surface for the rewrite. It exposes:

- a semantic SDK with session continuity inside one process
- a thin JSON-first CLI
- a local per-session service so CLI commands can share one live browser session
- HTML-first snapshots, DOM action replay, computer-use actions, descriptor persistence, traces,
  and artifacts

## Install

```bash
pnpm add opensteer
pnpm exec playwright install chromium

# Optional ABP backend for `--engine abp`
pnpm add @opensteer/engine-abp
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
opensteer open https://example.com --name docs-example --engine abp
opensteer snapshot action --name docs-example
opensteer click 3 --name docs-example --description "primary button"
opensteer extract --name docs-example --description "page summary" \
  --schema '{"url":{"source":"current_url"},"title":{"selector":"title"}}'
opensteer computer '{"type":"screenshot"}' --name docs-example
opensteer close --name docs-example
```

Each CLI command prints JSON to stdout. Browser state does not live in the CLI process. It lives
in the local session service recorded under `.opensteer/runtime/sessions/<name>/service.json`.
`opensteer computer` prints compact screenshot metadata and points at the persisted image through
`screenshot.path` for local shells and `screenshot.payload.uri` for the canonical file-backed
location.

Use `--engine <playwright|abp>` on `open` to choose the backend for a new session. You can also
set `OPENSTEER_ENGINE=abp` to change the default engine for `open` in the current shell. Engine
selection is fixed when the session service starts, so `OPENSTEER_ENGINE` and `--engine` only
affect `open`, not commands like `snapshot` or `click` that attach to an existing session.
When using `--engine abp`, Opensteer accepts the ABP launch options it can actually honor:
`--headless`, `--executable-path`, and equivalent `--browser-json` fields for `headless`, `args`,
and `executablePath`. Unsupported shared browser/context options fail fast instead of being
ignored.

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
- `goto(url | { url, networkTag? })`
- `snapshot("action" | "extraction")`
- `click({ element | selector | description, networkTag? })`
- `hover({ element | selector | description, networkTag? })`
- `input({ element | selector | description, text, networkTag? })`
- `scroll({ element | selector | description, direction, amount, networkTag? })`
- `extract({ description, schema? })`
- `queryNetwork({ source?, recordId?, requestId?, actionId?, tag?, url?, hostname?, path?, method?, status?, resourceType?, pageRef?, includeBodies?, limit? })`
- `saveNetwork({ tag, ...filters })`
- `clearNetwork({ tag? })`
- `rawRequest({ url, method?, headers?, body?, followRedirects? })`
- `inferRequestPlan({ recordId, key, version, lifecycle? })`
- `writeRequestPlan({ key, version, payload, lifecycle?, tags?, provenance?, freshness? })`
- `getRequestPlan({ key, version? })`
- `listRequestPlans({ key? })`
- `request(key, { path?, query?, headers?, body? })`
- `computerExecute({ action, screenshot?, networkTag? })`
- `close()`

`element` targets use counters from the latest snapshot. `description` replays a stored descriptor.
`selector` resolves a CSS selector directly and, when not explicitly scoped, searches the current
page before falling back to child frames.

The reverse-engineering workflow is: perform a browser action, inspect traffic with
`queryNetwork()`, experiment with `rawRequest()`, promote a record with `inferRequestPlan()`,
then replay with `request()`.
