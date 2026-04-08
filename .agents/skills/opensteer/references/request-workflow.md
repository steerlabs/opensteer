# Opensteer Request Workflow

Use this workflow when the task is to understand, validate, or reuse a site API.

The deliverable is working TypeScript that uses `session.fetch()` or other SDK primitives.

## Workflow

### 1. Capture

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 laptop --workspace demo --persist "search input" --capture-network search
opensteer click 7 --workspace demo --persist "search button" --capture-network search
```

### 2. Discover

```bash
opensteer network query --workspace demo --capture search
opensteer network query --workspace demo --capture search --hostname api.example.com
opensteer network query --workspace demo --capture search --url search --limit 20
```

### 3. Inspect

```bash
opensteer network detail rec_123 --workspace demo
```

Read the URL, method, request headers, cookies sent, request body preview, response headers, response body preview, GraphQL metadata, and redirect chain.

### 4. Test

```bash
opensteer replay rec_123 --workspace demo
opensteer replay rec_123 --workspace demo --query keyword=headphones --query count=10
opensteer replay rec_123 --workspace demo --variables '{"keyword":"headphones"}'
```

Use the working transport that `replay` discovers as input to the final SDK code.

### 5. Trace Dependencies

```bash
opensteer network query --workspace demo --before rec_123 --limit 50
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
```

### 6. Write Code

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});

async function ensureSession() {
  const cookies = await opensteer.cookies("example.com");
  if (cookies.has("session")) {
    return;
  }
  await opensteer.goto("https://example.com");
}

export async function searchProducts(keyword: string) {
  await ensureSession();

  const response = await opensteer.fetch("https://api.example.com/search", {
    query: {
      keyword,
      count: 24,
    },
  });

  return response.json();
}
```

If exploration showed a required transport:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

## What Not To Do

- Do not stop at `network query` when the user asked for reusable code.
- Do not bypass Opensteer with raw Playwright when Opensteer already captured the request.
- Do not dump giant raw response blobs into the prompt when the filtered summaries already show the useful shape.
