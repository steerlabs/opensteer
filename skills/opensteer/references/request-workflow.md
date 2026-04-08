# Opensteer Request Workflow

Use this workflow when the task is to understand, validate, or reuse a site API.

The deliverable is working TypeScript that uses `session.fetch()` or other SDK primitives. The deliverable is not a registry artifact or a raw replay dump.

## Core Rules

1. Capture real browser traffic instead of guessing request shapes.
2. Use the filtered summaries first. Only drill into details when needed.
3. Let `replay` tell you what transport works.
4. Keep the final artifact as code, not as shell history.

## Workflow

### 1. Capture

Trigger the real browser action that causes the request.

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 laptop --workspace demo --persist "search input" --capture-network search
opensteer click 7 --workspace demo --persist "search button" --capture-network search
```

Use meaningful capture labels. They make the next step much easier.

### 2. Discover

Scan the captured traffic.

```bash
opensteer network query --workspace demo --capture search
opensteer network query --workspace demo --capture search --hostname api.example.com
opensteer network query --workspace demo --capture search --url search --limit 20
```

Look for first-party JSON requests that actually carry the data you want. Ignore static assets, analytics, and third-party noise.

### 3. Inspect

Inspect the most promising record deeply.

```bash
opensteer network detail rec_123 --workspace demo
```

Read:

- URL and method
- request headers
- cookies sent
- request body preview
- response headers
- response body preview
- GraphQL metadata when present
- redirect chains when present

### 4. Test

Replay the captured request.

```bash
opensteer replay rec_123 --workspace demo
opensteer replay rec_123 --workspace demo --query keyword=headphones --query count=10
opensteer replay rec_123 --workspace demo --variables '{"keyword":"headphones"}'
```

Use the working transport that `replay` discovers as input to your final SDK code.

### 5. Trace Dependencies

If replay fails or returns `401`/`403`, inspect the surrounding state.

```bash
opensteer network query --workspace demo --before rec_123 --limit 50
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
```

Use these to answer:

- which cookies matter
- which tokens live in storage
- whether hidden fields or globals provide CSRF values or nonces
- which earlier requests set the relevant state

### 6. Write Code

Translate what worked into plain TypeScript.

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

If exploration showed a required transport, carry it into `fetch()`:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

## Common Cases

### GraphQL

- `network query` should surface the operation name next to the URL.
- `network detail` should show operation type, operation name, and variables.
- `replay --variables '{...}'` is the fastest way to test new inputs.

### Redirect or Auth Chains

Start with `network detail` on the failing request. If it shows redirects or challenge notes, inspect earlier records with `--before`.

### Hidden Form Tokens

Use `state example.com --workspace demo` when the request depends on hidden fields or globals that do not show up cleanly in cookies or storage alone.

## What Not To Do

- Do not stop at `network query` when the user asked for reusable code.
- Do not bypass Opensteer with raw Playwright when Opensteer already captured the request.
- Do not dump giant raw response blobs into the prompt when the filtered summaries already show the useful shape.
