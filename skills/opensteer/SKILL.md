---
name: opensteer
description: Browser automation and structured data extraction with the Opensteer CLI and SDK. Use when the agent needs to open pages, navigate, snapshot, click, hover, input, scroll, extract structured data, capture network requests, write request plans, replay requests, or generate scraper scripts. Covers both interactive CLI workflows and programmatic TypeScript SDK usage. Supports managed browsers, real Chrome profiles, cloned profile launches, and browser attachment.
---

# Opensteer — Browser Automation & Data Extraction

Opensteer provides two interfaces for browser automation:

- **CLI** (`opensteer <command>`) — interactive, stateful commands against a running browser session
- **SDK** (`import { Opensteer } from "opensteer"`) — programmatic TypeScript API for building scraper scripts and automation

## When to Use Each

| Use the CLI when...             | Use the SDK when...                              |
| :------------------------------ | :----------------------------------------------- |
| Exploring a site interactively  | Building a reusable scraper script               |
| Debugging element targeting     | Creating automation that runs unattended         |
| Quick one-off data extraction   | Chaining multiple pages/actions programmatically |
| Inspecting network traffic live | Building reverse-engineered API clients          |
| Managing local Chrome profiles  | Attaching to an existing browser session         |

## Core Concepts

### Element Targeting

Every action (click, hover, input, scroll) accepts a target in one of these forms:

- **`element` (counter number)** — from a snapshot's `counters` array. Fastest, but ephemeral per snapshot.
- **`selector` (CSS selector)** — standard CSS. Stable across sessions if the DOM structure is consistent.
- **`description` (semantic string)** — SDK only. Matches against persisted descriptors. Best for replay across sessions. Requires an API key for descriptor resolution.

### Browser Modes

Opensteer supports four browser launch modes:

- **`managed`** (default) — launches a fresh isolated local Chrome/Chromium process that Opensteer owns. This is the right default for most automation.
- **`profile`** — launches Chrome with a real dedicated user-data-dir that Opensteer owns. Preserves cookies, extensions, and login state.
- **`cloned`** — snapshots an existing browser profile into a temporary owned user-data-dir, skips volatile caches, and launches from the copy.
- **`attach`** — attaches to an already-running Chrome via DevTools Protocol. Omit `endpoint` to auto-discover a locally attachable browser, or pass one explicitly when you need exact selection.

### Connect To Real Browser

- Use **`managed`** when you want Opensteer to launch a fresh real local browser on an unused debugging port.
- Use **`profile`** when you need a persistent dedicated automation profile that Opensteer owns.
- Use **`cloned`** when you need existing cookies, extensions, or login state from a source profile without modifying that source profile.
- Use **`attach`** when a browser is already running and you want to reuse it. Omit `endpoint` for local auto-discovery or pass `endpoint` when you need exact selection.

**Recommended manual launch for `attach`:**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="$HOME/Library/Application Support/Opensteer Chrome" \
  --remote-debugging-port=9222
```

When attaching to an existing browser, `chrome://newtab` or another already-open tab is normal. Pass `--fresh-tab` if you want Opensteer to create a clean tab after attaching.

### Session Ownership

- **Owned session** (`new Opensteer(...)`) — the SDK controls the browser lifecycle. Call `close()` to tear down.
- **Attached session** (`Opensteer.attach(...)`) — the SDK connects to a session started elsewhere (e.g., by the CLI). Call `disconnect()` to release the handle without destroying the browser.

### Snapshots

Two modes:

- `"action"` — returns interactive elements with counter numbers for targeting
- `"extraction"` — returns the full page structure optimized for data extraction

### Network Tagging

Pass `networkTag` to any action to label the network traffic it triggers. Query tagged traffic later with `queryNetwork({ tag })`.

### Descriptors

When you use `description` targeting (SDK only), Opensteer looks up a persisted descriptor by that key. When you use `element` or `selector` with a `description` option, the resolved path is saved as a descriptor for future replay.

### Request Plans

Captured network requests can be promoted to reusable request plans with parameter substitution. `session-http` plans replay through a live browser session. `direct-http` plans replay without a browser. Attach auth recipes when a site needs deterministic refresh or token recovery.

---

## Workflow 1: Build a Scraper Script (SDK)

**Goal**: Create a TypeScript script that navigates a site, interacts with it, and extracts structured data.

1. Read the SDK reference: `${CLAUDE_SKILL_DIR}/references/sdk-reference.md`
2. Read scraper patterns: `${CLAUDE_SKILL_DIR}/references/scraper-patterns.md`

**Quick template:**

```typescript
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "my-scraper",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com");

  // Interact with the page
  await opensteer.input({ selector: "input[type=search]", text: "query", pressEnter: true });

  // Extract structured data
  const data = await opensteer.extract({
    description: "search results",
    schema: {
      results: [
        {
          title: { selector: ".result-title" },
          url: { selector: ".result-link", attribute: "href" },
        },
      ],
    },
  });

  console.log(JSON.stringify(data, null, 2));
} finally {
  await opensteer.close();
}
```

## Workflow 2: Reverse-Engineer an API (SDK)

**Goal**: Capture browser network traffic, identify the API call, and build a reusable request plan for either browser-backed replay (`session-http`) or browser-free replay (`direct-http`).

1. Read the request workflow guide: `${CLAUDE_SKILL_DIR}/references/request-workflow.md`
2. Read the SDK reference: `${CLAUDE_SKILL_DIR}/references/sdk-reference.md`

**Steps:**

1. **Capture** — perform the action in-browser with `networkTag`
2. **Inspect** — `queryNetwork({ tag, includeBodies: true })` to find the API call
3. **Experiment** — `rawRequest()` to test the request independently
4. **Promote** — `inferRequestPlan()` to convert the captured request to a reusable template
5. **Execute** — `request(key, { query, headers, body })` to replay with parameter substitution

## Workflow 3: Interactive CLI Exploration

**Goal**: Explore a website interactively using CLI commands.

1. Read the CLI reference: `${CLAUDE_SKILL_DIR}/references/cli-reference.md`

**Quick sequence:**

```bash
opensteer open https://example.com                # Start session + open URL
opensteer snapshot action                          # Snapshot to see interactive elements
opensteer input --selector "input[name=q]" --text "search term" --press-enter
opensteer snapshot action                          # Re-snapshot — DOM changed after input
opensteer click 12                                 # Click a counter from the NEW snapshot
opensteer snapshot action                          # Re-snapshot again before next counter use
opensteer network query --include-bodies           # Inspect network traffic
opensteer close                                    # End session
```

**Critical: always re-snapshot before using counter numbers.** Any action (click, input, scroll, goto) can mutate the DOM, making previous counters stale. A counter from an old snapshot may point to the wrong element or fail entirely.

**With a real Chrome profile:**

```bash
opensteer open https://example.com --browser profile \
  --user-data-dir "~/Library/Application Support/Google/Chrome"
```

**Attach to a running Chrome:**

```bash
opensteer open https://example.com --browser attach --attach-endpoint 9222
opensteer open https://example.com --browser attach
opensteer open https://example.com --browser cloned --clone-from "~/Library/Application Support/Google/Chrome"
opensteer browser discover
opensteer browser inspect --endpoint 9222
```

## Reference Files

| File                                                 | Contents                                                                   |
| :--------------------------------------------------- | :------------------------------------------------------------------------- |
| `${CLAUDE_SKILL_DIR}/references/cli-reference.md`    | All CLI commands, flags, and usage examples                                |
| `${CLAUDE_SKILL_DIR}/references/sdk-reference.md`    | SDK class API, constructor options, method signatures, types               |
| `${CLAUDE_SKILL_DIR}/references/scraper-patterns.md` | Scraper script patterns, extraction schemas, descriptor replay, pagination |
| `${CLAUDE_SKILL_DIR}/references/request-workflow.md` | Network capture, request plan inference, API reverse engineering workflow  |

## Key Rules

- **Always re-snapshot before using counter numbers.** Any action (click, input, scroll, goto) can change the DOM, making previous counters stale. Run `opensteer snapshot action` (CLI) or `opensteer.snapshot("action")` (SDK) immediately before every counter-based action.
- Always wrap owned SDK sessions in `try/finally` with `await opensteer.close()` in the finally block.
- For attached sessions (`Opensteer.attach()`), use `await opensteer.disconnect()` instead of `close()` — disconnect releases the handle without destroying the browser.
- Use `networkTag` on actions when you plan to inspect network traffic — otherwise traffic is unlabeled.
- In the CLI, target elements by counter number or `--selector`. Description-based targeting is SDK-only (requires API key).
- In the SDK, prefer `selector` targeting for scripts where CSS selectors are stable and known.
- In the SDK, use `description` targeting for scripts that will be replayed across sessions (requires API key).
- Use `element` targeting only within the same session immediately after a fresh snapshot.
- Extraction schemas use CSS selectors for field values — they are not the same as element targeting selectors.
- The `schema` in `extract()` supports arrays via `[{ field: { selector } }]` syntax for repeating elements.
- Scripts are TypeScript files. Use `import { Opensteer } from "opensteer"` (not require).
- Use `browser: { kind: "profile", userDataDir: "..." }` to launch with a real Chrome profile that preserves cookies, extensions, and login state.
- Use `browser: { kind: "cloned", sourceUserDataDir: "..." }` to launch from a temporary copy of an existing profile.
- Opensteer rejects default Chrome user-data-dirs in profile mode — use a dedicated directory.
- `managed` already launches a fresh real local browser for you; do not reach for `attach` when you actually want a brand-new browser.
