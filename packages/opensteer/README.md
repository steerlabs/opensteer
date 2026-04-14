<!-- This file is generated from the repository README. Run `node scripts/sync-package-readme.mjs`. -->

<p align="center">
  <strong>Opensteer</strong><br/>
  <em>AI Browser Automation Framework</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opensteer"><img src="https://img.shields.io/npm/v/opensteer.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/opensteer"><img src="https://img.shields.io/npm/dm/opensteer.svg" alt="npm downloads" /></a>
  <a href="https://github.com/steerlabs/opensteer/blob/main/LICENSE"><img src="https://img.shields.io/github/license/steerlabs/opensteer.svg" alt="license" /></a>
  <a href="https://github.com/steerlabs/opensteer/stargazers"><img src="https://img.shields.io/github/stars/steerlabs/opensteer.svg" alt="stars" /></a>
</p>

<p align="center">
  <a href="https://opensteer.com">Website</a> &middot;
  <a href="https://docs.opensteer.com">Docs</a> &middot;
  <a href="https://github.com/steerlabs/opensteer">GitHub</a> &middot;
  <a href="https://discord.gg/opensteer">Discord</a>
</p>

---

Open-source browser automation framework for AI agents. CLI and TypeScript SDK that give coding agents a real Chromium browser with persistent sessions, network capture, and stealth -- so they can browse, inspect, and generate scrapers directly in your codebase.

## Install

```bash
npm i -g opensteer
```

Then install Chromium for Playwright:

```bash
npx playwright install chromium
```

## Agent Quickstart

> **Using Claude Code, Codex, or Cursor?** Point your agent at Opensteer with a single command -- no manual setup needed.

```bash
opensteer skills install
```

This installs first-party skills that teach your AI agent how to use the Opensteer CLI and SDK. The agent can then open browsers, capture network traffic, extract structured data, and generate scrapers autonomously.

Target specific agents:

```bash
opensteer skills install --agent codex --agent cursor --agent claude-code
```

## Quickstart

### CLI

```bash
# Open a page in a persistent workspace
opensteer open https://example.com --workspace demo

# Take a snapshot and list interactive elements
opensteer snapshot action --workspace demo

# Click an element by its annotated index
opensteer click 3 --workspace demo --persist "cta"

# Extract structured data from the page
opensteer extract '{"title":{"element":3}}' --workspace demo

# Close the workspace
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

const opensteer = new Opensteer({ workspace: "demo", rootDir: process.cwd() });

await opensteer.open("https://example.com");
await opensteer.click({ persist: "cta" });
const data = await opensteer.extract({ persist: "page summary" });
await opensteer.close();
```

## Features

<table>
<tr>
<td width="50%">

### Persistent Sessions

Logins, cookies, and browser state survive across restarts. Each workspace is a full Chrome user-data directory.

### Profile Cloning

Clone a real Chrome profile to start a workspace already logged in. Source browser doesn't need to close.

### Network Capture

Record traffic during any action, inspect requests, and replay APIs with browser-backed `fetch()`.

### Script Analysis

Capture, beautify, deobfuscate, and sandbox page JavaScript.

</td>
<td width="50%">

### Computer Use

Coordinate-based mouse and keyboard when DOM targeting isn't enough.

### Stealth

Anti-detection defaults: UA spoofing, fingerprint management, automation signal removal.

### Local View

Stream live screenshots from headless sessions to a browser-based viewer.

### Local or Cloud

Run browsers locally or on [Opensteer Cloud](https://opensteer.com). Same CLI, same SDK.

</td>
</tr>
</table>

## How It Works

Opensteer follows a **discover-then-codify** workflow:

1. **Capture** -- Open a real page, trigger actions, and record network traffic.
2. **Inspect** -- Query captured traffic, check cookies/storage/state for auth context.
3. **Probe** -- Test transport viability for captured requests before writing code.
4. **Codify** -- Write plain TypeScript with `session.fetch()`. The code is the durable artifact.

See the full [Workflow Guide](https://github.com/steerlabs/opensteer/blob/main/docs/workflows.md) for details.

## Documentation

| Resource                                           | Description                            |
| -------------------------------------------------- | -------------------------------------- |
| [Package Guide](https://github.com/steerlabs/opensteer/blob/main/packages/opensteer/README.md)    | Full CLI and SDK reference             |
| [Workflow Guide](https://github.com/steerlabs/opensteer/blob/main/docs/workflows.md)              | Discover-then-codify methodology       |
| [Instrumentation Guide](https://github.com/steerlabs/opensteer/blob/main/docs/instrumentation.md) | Tracing and observability              |
| [Skills Guide](https://github.com/steerlabs/opensteer/blob/main/skills/README.md)                 | Agent skill installation and authoring |

## FAQ

<details>
<summary><strong>Which AI agents are supported?</strong></summary>

Opensteer ships first-party skills for [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://openai.com/index/introducing-codex/), [Cursor](https://www.cursor.com/), and any agent compatible with the [skills.sh](https://skills.sh) standard.

</details>

<details>
<summary><strong>Do I need to install a browser separately?</strong></summary>

Yes. After installing Opensteer, run `npx playwright install chromium` to download a compatible Chromium build. This is a one-time step.

</details>

<details>
<summary><strong>Can I use my existing Chrome login sessions?</strong></summary>

Yes. Use profile cloning to copy your real Chrome profile into an Opensteer workspace. Your logins, cookies, and extensions carry over without closing your main browser.

</details>

<details>
<summary><strong>Does it work in headless mode?</strong></summary>

Yes. Opensteer runs headless by default. Use the Local View feature to stream live screenshots from headless sessions to a browser-based viewer for debugging.

</details>

<details>
<summary><strong>What Node.js version is required?</strong></summary>

Node.js 22 or later.

</details>

## Development

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```

## Community

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

- [Contributing](https://github.com/steerlabs/opensteer/blob/main/CONTRIBUTING.md)
- [Code of Conduct](https://github.com/steerlabs/opensteer/blob/main/CODE_OF_CONDUCT.md)
- [Security Policy](https://github.com/steerlabs/opensteer/blob/main/SECURITY.md)
- [License](https://github.com/steerlabs/opensteer/blob/main/LICENSE) (MIT)
