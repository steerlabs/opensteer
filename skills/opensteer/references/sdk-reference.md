# Opensteer SDK Reference

Use the SDK when the result should become reusable TypeScript in the repository.

## Construction

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});
```

Key options:

- `workspace`: persistent repo-local browser state
- `rootDir`: where `.opensteer` lives
- `browser`: local browser mode or attach config
- `provider`: cloud config when applicable

## DOM Automation

Explore with the CLI first. Use the snapshot `html` output to find `c="N"` element numbers.

Persist a DOM action target during exploration:

```ts
await opensteer.click({
  element: 3,
  persist: "primary button",
});

await opensteer.input({
  element: 7,
  persist: "search input",
  text: "laptop",
  pressEnter: true,
});
```

Replay it later without element numbers:

```ts
await opensteer.click({ persist: "primary button" });
await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
```

Extraction still uses `description`:

```ts
const summary = await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});
```

Rules:

- Use `persist` for DOM actions.
- Use `description` for extraction descriptors.
- Use `selector` only as a low-level escape hatch.

## Network Discovery

```ts
await opensteer.goto("https://example.com/search", {
  captureNetwork: "search",
});

const records = await opensteer.network.query({
  capture: "search",
  limit: 20,
});

const detail = await opensteer.network.detail(records.records[0]!.recordId);
const replay = await opensteer.network.replay(records.records[0]!.recordId, {
  query: { keyword: "headphones" },
});
```

Use:

- `network.query()` to shortlist requests
- `network.detail()` to inspect one request deeply
- `network.replay()` to confirm the transport and response shape

## Browser State

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const sessionStorage = await opensteer.storage("example.com", "session");
const browserState = await opensteer.state("example.com");
```

`cookies()` returns a small cookie-jar helper:

```ts
cookies.has("session");
cookies.get("session");
cookies.getAll();
cookies.serialize();
```

## Session-Aware Fetch

`fetch()` is the main replay primitive for final code.

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: {
    keyword: "laptop",
    count: 24,
  },
});

const data = await response.json();
```

If exploration showed a required transport:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

## Browser Admin

```ts
const status = await opensteer.browser.status();

if (!status.live) {
  await opensteer.browser.clone({
    sourceUserDataDir: "/Users/me/Library/Application Support/Google/Chrome",
    sourceProfileDirectory: "Default",
  });
}
```

## Recommended Rules

- Explore with the CLI first, then write reusable SDK code.
- Use `captureNetwork` on the real browser actions that trigger the traffic.
- Let `replay` tell you the required transport instead of guessing.
- Keep the final artifact as code, not as shell commands or giant logs.

## What Not To Do

- Do not build new abstractions on top of simple `fetch()` code unless the task really needs them.
- Do not bypass Opensteer with raw Playwright when Opensteer already captured the request.
- Do not dump giant raw response blobs into logs or prompts when the filtered previews already show the useful structure.
