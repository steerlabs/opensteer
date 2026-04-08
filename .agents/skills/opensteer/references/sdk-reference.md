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

## DOM Automation

Persist a target during exploration:

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

Replay it later:

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

## Browser State

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const browserState = await opensteer.state("example.com");
```

## Session-Aware Fetch

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

## Rules

- Explore with the CLI first, then write reusable SDK code.
- Use `persist` for DOM actions.
- Use `description` for extraction descriptors.
- Let `replay` tell you the required transport instead of guessing.
