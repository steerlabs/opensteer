# Opensteer

`opensteer` is a browser-backed toolkit for agents exploring websites.

It focuses on the parts normal code cannot do reliably on its own:

- capture real browser traffic from real browser actions
- inspect captured requests without dumping huge raw payloads
- replay requests with browser-grade transports
- read browser cookies, storage, and page state
- turn discoveries into plain TypeScript with `session.fetch()`

The goal is discovery first, code second. The artifact should usually be working code, not a custom registry abstraction.

## Install

```bash
pnpm add opensteer
pnpm exec playwright install chromium

# npm
npm install opensteer
npx playwright install chromium
```

The package uses the Playwright-backed local engine by default.

## CLI Quickstart

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network search
opensteer network query --workspace demo --capture search
opensteer network detail rec_123 --workspace demo
opensteer replay rec_123 --workspace demo
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
opensteer close --workspace demo
```

For DOM exploration:

```bash
opensteer snapshot action --workspace demo
opensteer input 5 laptop --workspace demo --persist "search input" --capture-network search
opensteer click 7 --workspace demo --persist "search button" --capture-network search
opensteer snapshot extraction --workspace demo
opensteer extract '{"title":3,"productUrl":{"c":7,"attr":"href"},"url":{"source":"current_url"}}' --workspace demo --persist "page summary"
```

## SDK Quickstart

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});

await opensteer.open("https://example.com");
await opensteer.goto("https://example.com/search", {
  captureNetwork: "search",
});

const records = await opensteer.network.query({
  capture: "search",
  json: true,
});

const detail = await opensteer.network.detail(records.records[0]!.recordId, {
  probe: true,
});

console.log(detail.summary.url);
console.log(detail.transportProbe?.recommended);
```

## `session.fetch()`

After discovery, write ordinary TypeScript using `fetch()` on the session.

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "target",
  rootDir: process.cwd(),
});

async function ensureTargetSession() {
  const cookies = await opensteer.cookies(".target.com");
  if (cookies.has("visitorId")) {
    return;
  }
  await opensteer.goto("https://target.com");
}

export async function searchTarget(keyword: string, count = 24) {
  await ensureTargetSession();

  const response = await opensteer.fetch(
    "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2",
    {
      query: {
        keyword,
        count,
        offset: 0,
        channel: "WEB",
        platform: "desktop",
      },
    },
  );

  return response.json();
}
```

Transport is selected automatically by default. Force it only when discovery showed a specific requirement:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

## Browser State

Opensteer exposes the browser state agents need for request tracing:

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const sessionStorage = await opensteer.storage("example.com", "session");
const state = await opensteer.state("example.com");
```

`cookies()` returns a lightweight cookie jar:

```ts
cookies.has("session");
cookies.get("session");
cookies.getAll();
cookies.serialize();
```

## DOM Automation

```ts
await opensteer.click({ persist: "search button", captureNetwork: "search" });
await opensteer.input({
  persist: "search input",
  text: "laptop",
  pressEnter: true,
  captureNetwork: "search",
});

const data = await opensteer.extract({
  persist: "page summary",
});
```

Author extraction templates from the CLI. Bare numbers reference element numbers from the snapshot (`c="N"` attributes), `{ c, attr }` reads an attribute from that element, and `{ source: "current_url" }` reads page metadata.

```bash
opensteer extract '{"title":3,"productUrl":{"c":7,"attr":"href"},"url":{"source":"current_url"}}' --workspace demo --persist "page summary"
```

Use `snapshot("action")` or `snapshot("extraction")` during exploration. The snapshot result is the filtered HTML string, not a huge raw DOM object.

## Humanized Input

Humanized cursor movement, typing cadence, and wheel ticks are opt-in:

```ts
const opensteer = new Opensteer({
  workspace: "demo",
  context: {
    humanize: true,
  },
});
```

You can also set `OPENSTEER_HUMANIZE=1` to turn it on for local runs without changing code.

## Public SDK Surface

- `new Opensteer({ workspace?, rootDir?, browser?, provider? })`
- `open(url | input?)`
- `info()`
- `listPages()`
- `newPage()`
- `activatePage()`
- `closePage()`
- `goto(url, { captureNetwork? })`
- `evaluate(script | input)`
- `addInitScript(input)`
- `snapshot("action" | "extraction")`
- `click({ element? | selector? | persist?, captureNetwork? })`
- `hover({ element? | selector? | persist?, captureNetwork? })`
- `input({ text, element? | selector? | persist?, captureNetwork? })`
- `scroll({ direction, amount, element? | selector? | persist?, captureNetwork? })`
- `extract({ persist })`
- `network.query(input?)`
- `network.detail(recordId, { probe?: boolean })`
- `waitForPage(input?)`
- `cookies(domain?)`
- `storage(domain?, "local" | "session")`
- `state(domain?)`
- `fetch(url, options?)`
- `computerExecute(input)`
- `route(input)`
- `interceptScript(input)`
- `browser.status()`
- `browser.clone(input)`
- `browser.reset()`
- `browser.delete()`
- `close()`
- `disconnect()`

## Design Notes

- `network query` is intentionally summary-oriented. Use `network detail` for deep inspection.
- `replay` is transport-aware and should usually replace manual probe logic.
- `browser status` intentionally does not leak the raw browser websocket endpoint.
- The package also exports advanced cloud and browser-management utilities, but the core agent workflow is the local discovery-first SDK and CLI shown above.
