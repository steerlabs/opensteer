# Opensteer SDK Reference

Use the SDK when the result should become reusable code in the repository.

## Construction

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
  browser: {
    mode: "persistent",
  },
});
```

Key options:

- `workspace`: persistent repo-local browser state
- `rootDir`: where `.opensteer` lives
- `browser`: local browser mode/config
- `provider`: remote provider config when applicable

## Core SDK Surface

### Browser and Pages

```ts
await opensteer.open("https://example.com");
await opensteer.goto("https://example.com/search", { captureNetwork: "search" });
const info = await opensteer.info();
const html = await opensteer.snapshot("action");
```

### DOM Automation

```ts
await opensteer.click({ description: "search button", captureNetwork: "search" });
await opensteer.input({
  description: "search input",
  text: "laptop",
  pressEnter: true,
  captureNetwork: "search",
});

const summary = await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});
```

### Network Discovery

```ts
const records = await opensteer.network.query({
  capture: "search",
  json: true,
  limit: 20,
});

const detail = await opensteer.network.detail(records.records[0]!.recordId);
const replay = await opensteer.network.replay(records.records[0]!.recordId, {
  query: { keyword: "headphones" },
});
```

### Browser State

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const browserState = await opensteer.state("example.com");
```

`cookies()` returns a small cookie-jar helper:

```ts
if (cookies.has("session")) {
  console.log(cookies.get("session"));
  console.log(cookies.serialize());
}
```

### Session-Aware Fetch

`fetch()` is the main replay primitive for SDK code.

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: {
    keyword: "laptop",
    count: 24,
  },
});

const data = await response.json();
```

Options:

- `method`
- `query`
- `headers`
- `body`
- `transport`: `"direct" | "matched-tls" | "page"`
- `cookies`: defaults to `true`

If omitted, transport is selected automatically.

## Typical API Workflow

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "target",
  rootDir: process.cwd(),
});

async function ensureSession() {
  const cookies = await opensteer.cookies(".target.com");
  if (cookies.has("visitorId")) {
    return;
  }
  await opensteer.goto("https://target.com");
}

export async function searchTarget(keyword: string, count = 24) {
  await ensureSession();

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

## When To Force Transport

Default transport selection is usually correct. Only force it when exploration proved a specific requirement.

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

Good reasons to force transport:

- `replay` reported `direct-http` failed and `matched-tls` succeeded
- the site uses anti-bot checks or TLS fingerprinting
- the request only works inside a live page context

## GraphQL

Use `network.detail()` and `network.replay()` to understand the operation first, then write normal fetch code.

```ts
const response = await opensteer.fetch("https://api.example.com/graphql", {
  method: "POST",
  body: {
    query: "...",
    variables: {
      keyword: "headphones",
    },
  },
});
```

## Recommended Rules

- Explore with the CLI first, then commit reusable SDK code.
- Use `captureNetwork` on the real browser actions that trigger the traffic.
- Use `network.query` for scanning and `network.detail` for deep inspection.
- Let `replay` tell you the required transport instead of guessing.
- Keep API artifacts as TypeScript, not custom registry metadata.

## What Not To Do

- Do not build request-plan or recipe abstractions on top of simple HTTP code.
- Do not bypass Opensteer with raw Playwright when Opensteer already captured the request.
- Do not dump giant raw response blobs into logs or prompts when the filtered previews already show the useful structure.
