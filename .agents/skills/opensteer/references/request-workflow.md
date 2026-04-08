# Network Discovery Workflow

Use this workflow when the task is to understand, reverse-engineer, or reuse a site API.

The deliverable is not a request-plan registry entry. The deliverable is working TypeScript that uses `session.fetch()` or other session primitives.

## Core Principles

1. Capture real browser traffic instead of guessing request shapes.
2. Give the agent clean summaries, not huge raw dumps.
3. Let the agent reason about URLs, params, auth chains, and code.
4. Use Opensteer only for the pieces normal code cannot reproduce reliably: browser traffic, browser state, and browser-grade transports.

## Workflow

### 1. Capture

Open the site and perform the real browser action that triggers the request.

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input --workspace demo --description "search input" --text "laptop" --capture-network search
opensteer click --workspace demo --description "search button" --capture-network search
```

Use a meaningful capture label. It becomes the easiest way to narrow the request set later.

### 2. Discover

Scan the capture with `network query`.

```bash
opensteer network query --workspace demo --capture search --json
opensteer network query --workspace demo --capture search --hostname api.example.com
opensteer network query --workspace demo --capture search --url search --limit 20
```

Look for first-party requests that carry the data you want. Ignore static assets, analytics, and most third-party noise.

Useful filters:

- `--capture <label>`
- `--json`
- `--url <substring>`
- `--hostname <host>`
- `--path <substring>`
- `--method GET|POST|...`
- `--status <code>`
- `--before <recordId>`
- `--after <recordId>`

### 3. Inspect

Pick a candidate record and inspect it deeply.

```bash
opensteer network detail rec_123 --workspace demo
```

Read:

- request URL and method
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

`replay` automatically tries transports in order and tells you which one worked. That answer should directly inform SDK code:

- `direct-http` -> likely `session.fetch()` default is enough
- `matched-tls` -> likely needs TLS fingerprint matching
- `page-http` -> may need a live page context

### 5. Trace Dependencies

If replay fails or returns 401/403, trace what the request depends on.

```bash
opensteer network query --workspace demo --before rec_123 --limit 50
opensteer cookies --workspace demo --domain example.com
opensteer storage --workspace demo --domain example.com
opensteer state --workspace demo --domain example.com
```

Use these tools to answer:

- which cookies are present in the browser
- which tokens live in localStorage or sessionStorage
- whether hidden form fields or globals expose CSRF/nonces
- which earlier requests set the relevant cookies or tokens

### 6. Write Code

Translate what you learned into plain TypeScript.

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
    query: { keyword, count: 24 },
  });

  return response.json();
}
```

If `replay` showed a transport fallback was needed, carry that into `session.fetch()`:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword },
  transport: "matched-tls",
});
```

## Common Cases

### GraphQL

- `network query` should surface the operation name next to the URL.
- `network detail` should show operation type, name, variables, and whether the request looks persisted.
- `replay --variables '{...}'` is the quickest way to test the same operation with new inputs.

### Redirect / Auth Chains

Use `network detail` on the failing request first. If it shows redirects or challenge notes, inspect the earlier chain with `--before`.

### Hidden Form Tokens

Use `state --domain example.com` when the request depends on hidden inputs or JS globals that do not show up cleanly in cookies/storage alone.

### Anti-Bot Protection

If `replay` says `direct-http` failed but a browser-grade transport succeeded, do not fight that with custom proxy code. Use the working transport in `session.fetch()`.

## What Not To Do

- Do not stop at a captured record summary when the user asked for reusable code.
- Do not build a custom browser bridge or raw Playwright CDP client if Opensteer already captured the request.
- Do not force a rigid request-plan abstraction on top of code the agent can already write.
