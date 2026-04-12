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

### SDK

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

- [Contributing](https://github.com/steerlabs/opensteer/blob/main/CONTRIBUTING.md)
- [Code of Conduct](https://github.com/steerlabs/opensteer/blob/main/CODE_OF_CONDUCT.md)
- [Security Policy](https://github.com/steerlabs/opensteer/blob/main/SECURITY.md)
- [License](https://github.com/steerlabs/opensteer/blob/main/LICENSE) (MIT)
