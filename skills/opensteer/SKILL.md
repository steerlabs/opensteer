---
name: opensteer
description: "Use when the task needs real browser automation, DOM exploration, browser session state, network capture, or browser-backed request replay with Opensteer. The default pattern is: explore with the CLI first, then write the final code with the SDK."
argument-hint: "[goal]"
---

# Opensteer

Use Opensteer when normal code is not enough because the task depends on a real browser:

- interact with a real page
- inspect browser state like cookies or storage
- capture real network traffic from real browser actions
- replay requests through the browser session
- turn the discovery into plain TypeScript

The default workflow is:

1. Use the CLI to explore the site.
2. Figure out the page or API behavior.
3. Save stable targets with `persist` when useful.
4. Write the final reusable code with the SDK.

Do not stop at manual exploration if the user needs automation. Explore first, then convert the result into SDK code.

## When To Use

- The task needs a real browser session.
- The task involves clicks, forms, DOM extraction, or navigation.
- The task involves cookies, localStorage, sessionStorage, or auth state.
- The task involves reverse-engineering a site API from real browser traffic.
- The task needs browser-backed `fetch()` instead of plain Node HTTP.
- The task needs coordinate-based fallback because DOM targeting is not enough.

If the user wants to manually drive a browser and record the flow, use the `recorder` skill instead.

## Core Rules

1. Always use a workspace for stateful commands: `--workspace <id>` or `OPENSTEER_WORKSPACE`.
2. In this repo, prefer `pnpm run opensteer:local -- <command>` instead of bare `opensteer ...`.
3. Re-snapshot after navigation or big UI changes before reusing element numbers.
4. Use the CLI to discover. Use the SDK for the final implementation.
5. Use `persist` for stable reusable targets and extraction payloads.
6. Use `exec` for SDK code and API experiments. Use `evaluate` only for page-context JavaScript.
7. If `fetch()` fails with auth errors, inspect `state()`, `cookies()`, and `storage()` before changing transport.
8. Keep the final output simple. Prefer ordinary TypeScript with `Opensteer`, not extra abstraction unless the user asks for it.

## Choose A Path

- Page interaction or extraction: use the DOM path.
- API discovery or replay: use the network path.
- Canvas, WebGL, or hard-to-target UI: use computer-use.
- Browser profile, attach mode, or workspace management: use browser management.
- Unsure: start by capturing network traffic.

## DOM Path

Use this when the goal is clicking, typing, navigating, or extracting visible data.

### CLI exploration

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer input 5 "laptop" --workspace demo --press-enter --persist "search input"
opensteer click 7 --workspace demo --persist "search button"
opensteer snapshot extraction --workspace demo
opensteer extract '{"items":[{"name":{"element":13},"price":{"element":14}}]}' \
  --workspace demo \
  --persist "search results"
```

Element numbers come from `c="N"` markers in the snapshot HTML.

### SDK implementation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

await opensteer.open("https://example.com");
await opensteer.input({ persist: "search input", text: "laptop", pressEnter: true });
await opensteer.click({ persist: "search button" });
const data = await opensteer.extract({ persist: "search results" });
```

Use `selector` in SDK code only when a stable CSS selector is cleaner than `persist`.

## Network Path

Use this when the goal is to find or replay a site API.

### CLI exploration

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer input 5 "laptop" --workspace demo --press-enter --capture-network search
opensteer network query --workspace demo --capture search --json
opensteer network detail rec_123 --workspace demo --probe
```

Use `network detail --probe` to learn which transport works.

### Session state checks

Use these when auth or browser state matters:

```bash
opensteer state example.com --workspace demo
```

```ts
const cookies = await opensteer.cookies("example.com");
const localStorage = await opensteer.storage("example.com", "local");
const sessionStorage = await opensteer.storage("example.com", "session");
const state = await opensteer.state("example.com");
```

### Prove the request with `exec`

```bash
opensteer exec "
  const response = await this.fetch('https://api.example.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: 'laptop', count: 24 }),
  });
  return { status: response.status, data: await response.json() };
" --workspace demo
```

### SDK implementation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

export async function search(keyword: string) {
  const response = await opensteer.fetch("https://api.example.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyword, count: 24 }),
  });
  return response.json();
}
```

Use ordinary `fetch()` syntax. Only set `transport` explicitly if probing showed you need it.

## Computer-Use

Use this only when DOM targeting is not enough.

```bash
opensteer computer click 245 380 --workspace demo --capture-network action
opensteer computer type "search query" --workspace demo
opensteer computer key Enter --workspace demo
opensteer computer screenshot --workspace demo
```

```ts
await opensteer.computerExecute({
  action: { type: "click", x: 245, y: 380 },
});
```

After coordinate-based actions, switch back to normal extraction or request analysis as soon as possible.

## Browser Management

Use these when the task is about browser setup rather than page logic.

```bash
opensteer browser discover
opensteer browser inspect --attach-endpoint http://localhost:9222
opensteer browser clone --workspace demo \
  --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
opensteer browser status --workspace demo
opensteer browser reset --workspace demo
opensteer browser delete --workspace demo
```

Attach to an existing browser:

```bash
opensteer open https://example.com --workspace demo --attach-endpoint http://localhost:9222
```

Cloud mode:

- Use `--provider cloud` on CLI when needed.
- Common env vars are `OPENSTEER_BASE_URL`, `OPENSTEER_API_KEY`, and `OPENSTEER_CLOUD_APP_BASE_URL`.

## Useful SDK Surface

Use these often:

- `open(url)`
- `goto(url, { captureNetwork? })`
- `snapshot("action" | "extraction")`
- `click()`, `hover()`, `input()`, `scroll()`
- `extract()`
- `network.query()`
- `network.detail()`
- `waitForNetwork()`, `waitForResponse()`, `waitForPage()`
- `cookies()`, `storage()`, `state()`
- `fetch()`
- `computerExecute()`
- `addInitScript()`
- `browser.status()`, `browser.clone()`, `browser.reset()`, `browser.delete()`

## Guardrails

- Snapshot before using element numbers.
- Snapshot again after UI changes.
- Do not use `evaluate` for API work.
- Do not keep the result as a manual-only workflow if the user needs reusable automation.
- Prefer a small final script over a large framework.
