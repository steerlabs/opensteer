---
name: opensteer
description: "Handles Opensteer browser automation, structured DOM extraction, and browser-backed API reverse engineering. Use when the user mentions Opensteer, browser automation, real Chromium sessions, DOM extraction, network capture, replay, cookies, reverse-engineering a site API, or browser-grade fetch."
argument-hint: "[goal]"
---

# Opensteer

Opensteer gives agents a real Chromium browser for two jobs normal code cannot do:

1. **DOM automation** — interact with pages and extract structured data via snapshot-based element targeting.
2. **API reverse engineering** — capture real browser traffic, identify APIs, test transport portability, and write replay code.

The workflow is always: **explore with CLI, then write reusable code with SDK.**

## When To Use

- Task involves a website's API, network traffic, auth headers, or replay → **API workflow**
- Task involves page content, forms, clicking, typing, or extracting visible data → **DOM workflow**
- Task involves browser profiles, attaching to Chrome, or workspace setup → **Browser management**
- Unsure → Start with the API workflow. Capture traffic first, then decide.

## Rules

1. Set `--workspace <id>` on every command, or export `OPENSTEER_WORKSPACE`.
2. Re-snapshot after every navigation before using element numbers.
3. Import as `import { Opensteer } from "opensteer"` — never a relative path.
4. SDK constructor needs only two fields:
   ```ts
   const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });
   ```
5. `persist` is the only naming mechanism for reusable targets and extractions.
6. `--capture-network <label>` is opt-in. Add it to any action when you need traffic.
7. `opensteer.fetch()` works without a page open — it uses the session cookie jar and transport stack directly.
8. Element numbers come from `c="N"` attributes in snapshot HTML. Always snapshot first, then act.

---

## DOM Automation

### Step 1: Open and snapshot

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
```

Read the `html` output. Find `c="N"` markers — these are your element IDs.

### Step 2: Interact

```bash
opensteer click 7 --workspace demo --persist "search button"
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input"
opensteer hover 3 --workspace demo --persist "menu trigger"
opensteer scroll down 400 --workspace demo
```

`--persist <key>` saves the element's structural DOM path for deterministic SDK replay. Element number is always required on CLI — persist is save-only, not a targeting mode.

### Step 3: Extract

Re-snapshot, then extract with a JSON schema referencing element numbers:

```bash
opensteer snapshot extraction --workspace demo
opensteer extract '{"items":[{"name":{"element":13},"price":{"element":14}}]}' \
  --persist "search results" --workspace demo
```

The positional argument is the JSON schema. `--persist` names it for SDK replay.

### Step 4: Close

```bash
opensteer close --workspace demo
```

### SDK Replay

```ts
import { Opensteer } from "opensteer";
const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

try {
  await opensteer.open("https://example.com");

  // Replay by persist key — no element numbers or snapshots needed
  await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
  await opensteer.click({ persist: "search button" });

  // Extract using cached schema
  const data = await opensteer.extract({ persist: "search results" });
  console.log(data);
} finally {
  await opensteer.close();
}
```

When `persist` is used with `element`, it **saves** the path. When used alone, it **resolves** from cache.

---

## API Reverse Engineering

### Step 1: Capture traffic

Open the site and trigger the real browser action with `--capture-network`:

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 "laptop" --workspace demo --press-enter --capture-network search
```

### Step 2: Find the API

```bash
opensteer network query --workspace demo --capture search
opensteer network query --workspace demo --capture search --hostname api.example.com --json
```

`--json` filters to JSON and GraphQL responses only. Other filters: `--url`, `--path`, `--method`, `--status`, `--type`, `--before`, `--after`, `--limit`.

### Step 3: Inspect

```bash
opensteer network detail rec_123 --workspace demo
```

Shows: URL, method, request headers, cookies sent, request/response body preview, GraphQL metadata, redirect chain.

### Step 4: Test replay

```bash
opensteer replay rec_123 --workspace demo
opensteer replay rec_123 --workspace demo --query keyword=headphones --query count=10
```

Replay tries transports automatically and reports which succeeded:

| Transport | Meaning | SDK usage |
|---|---|---|
| `direct-http` | Plain HTTP works | `opensteer.fetch(url)` (default) |
| `matched-tls` | Needs TLS fingerprint matching | `opensteer.fetch(url, { transport: "matched-tls" })` |
| `page-http` | Needs a live browser page | `opensteer.fetch(url, { transport: "page" })` |

### Step 5: Check browser state (if replay returns 401/403)

```bash
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
```

Look for session cookies, CSRF tokens, or storage-backed auth that the request depends on.

### Step 6: Write SDK code

```bash
opensteer close --workspace demo
```

```ts
import { Opensteer } from "opensteer";
const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

async function ensureSession() {
  const cookies = await opensteer.cookies("example.com");
  if (cookies.has("session")) return;
  await opensteer.goto("https://example.com");
}

export async function search(keyword: string) {
  await ensureSession();
  const response = await opensteer.fetch("https://api.example.com/search", {
    query: { keyword, count: 24 },
  });
  return response.json();
}
```

If replay showed a required transport, carry it into `fetch()`:

```ts
const response = await opensteer.fetch("https://api.example.com/search", {
  query: { keyword: "laptop" },
  transport: "matched-tls",
});
```

IMPORTANT: `opensteer.fetch()` does not require opening a browser page. It works directly with the session's cookies and transport stack. Only call `opensteer.open()` or `opensteer.goto()` if you need to establish session cookies first.

---

## Browser Management

### Import a Chrome profile

Copy cookies, localStorage, and session state from an existing Chrome installation:

```bash
opensteer browser clone --workspace my-site \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
```

### Attach to a running browser

Start Chrome with remote debugging, then connect Opensteer:

```bash
# Terminal 1: launch Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Terminal 2: attach Opensteer
opensteer open https://example.com --workspace demo --attach-endpoint http://localhost:9222
```

### Headful mode

```bash
opensteer open https://example.com --workspace demo --headless false
```

### Workspace lifecycle

```bash
opensteer browser status --workspace demo
opensteer browser reset --workspace demo     # reset browser data, keep workspace
opensteer browser delete --workspace demo    # delete workspace entirely
```

---

## Tabs

```bash
opensteer tab list --workspace demo
opensteer tab new https://other-page.com --workspace demo
opensteer tab 2 --workspace demo             # switch to tab 2
opensteer tab close 2 --workspace demo
```

## Run JavaScript

```bash
opensteer evaluate "document.title" --workspace demo
```

## Computer-Use (Coordinate-Based)

For canvas, WebGL, or complex iframes where DOM element targeting fails:

```bash
opensteer computer click 245 380 --workspace demo --capture-network action
opensteer computer type "search query" --workspace demo
opensteer computer key Enter --workspace demo
opensteer computer scroll 400 300 --dx 0 --dy -200 --workspace demo
opensteer computer screenshot --workspace demo
```

---

## CLI Quick Reference

| Command | Positional args | Key flags |
|---|---|---|
| `open <url>` | url | `--headless`, `--provider`, `--attach-endpoint`, `--attach-header` |
| `close` | — | — |
| `status` | — | — |
| `goto <url>` | url | `--capture-network` |
| `snapshot [mode]` | action \| extraction | — |
| `click <element>` | element number | `--persist`, `--capture-network`, `--button` |
| `hover <element>` | element number | `--persist`, `--capture-network` |
| `input <element> <text>` | element, text | `--persist`, `--press-enter`, `--capture-network` |
| `scroll <dir> <amount>` | direction, amount | `--element`, `--persist`, `--capture-network` |
| `extract <schema>` | JSON schema | `--persist` |
| `evaluate <script>` | JS expression | — |
| `network query` | — | `--capture`, `--url`, `--hostname`, `--json`, `--limit`, +6 filters |
| `network detail <id>` | recordId | — |
| `replay <id>` | recordId | `--query`, `--header`, `--body`, `--variables` |
| `fetch <url>` | url | `--method`, `--header`, `--query`, `--body`, `--transport`, `--cookies` |
| `cookies [domain]` | domain (optional) | — |
| `storage [domain]` | domain (optional) | — |
| `state [domain]` | domain (optional) | — |
| `tab list / new / <n> / close` | varies | — |
| `computer click/type/key/scroll/move/drag/screenshot/wait` | varies | `--capture-network` |

## SDK Quick Reference

```ts
// Browser lifecycle
await opensteer.open(url);
await opensteer.goto(url, { captureNetwork?: "label" });
await opensteer.close();

// DOM actions — save to cache
await opensteer.click({ element: 7, persist: "name" });
await opensteer.input({ element: 5, text: "...", persist: "name", pressEnter: true });
await opensteer.hover({ element: 3, persist: "name" });
await opensteer.scroll({ direction: "down", amount: 400 });

// DOM actions — resolve from cache
await opensteer.click({ persist: "name" });
await opensteer.input({ persist: "name", text: "..." });

// Extraction
await opensteer.extract({ persist: "name" });                    // cached schema
await opensteer.extract({ persist: "name", schema: { ... } });   // inline schema

// Network discovery
const records = await opensteer.network.query({ capture: "label", limit: 20 });
const detail = await opensteer.network.detail(recordId);
const replay = await opensteer.network.replay(recordId, { query: { k: "v" } });

// Fetch — works without a page open
const response = await opensteer.fetch(url, {
  query?: { key: "value" },
  method?: "POST",
  headers?: { Authorization: "Bearer ..." },
  body?: { ... },
  transport?: "auto" | "direct" | "matched-tls" | "page",
});

// Browser state
const cookies = await opensteer.cookies("domain.com"); // .has(), .get(), .serialize()
const storage = await opensteer.storage("domain.com", "local");
const state = await opensteer.state("domain.com");

// Snapshots
const html = await opensteer.snapshot("action");
const html = await opensteer.snapshot("extraction");
```

---

## Common Issues

| Symptom | Fix |
|---|---|
| Element numbers wrong after navigation | Re-snapshot before using element numbers |
| `replay` returns 401/403 | Check `cookies`, `storage`, `state` — request depends on session tokens |
| `replay` works but `fetch()` fails | Use the transport replay discovered: `transport: "matched-tls"` or `"page"` |
| Direct HTTP blocked, browser transport works | Site uses TLS fingerprinting — use `transport: "matched-tls"` |
| Extract returns empty data | Element numbers changed — re-snapshot and rebuild the schema |
| `fetch()` fails with no session | Call `opensteer.goto(url)` first to establish cookies, then `fetch()` |
