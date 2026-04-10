# Opensteer

Open-source browser automation for AI agents. CLI and TypeScript SDK that give agents a real Chromium browser with persistent sessions, network capture, and stealth.

## Install

```bash
npm install opensteer
npx playwright install chromium
```

Give your AI agent the Opensteer skill:

```bash
npx --yes opensteer@latest skills install
```

## Quick Start

### CLI

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer click 3 --workspace demo --persist "cta"
opensteer extract '{"title":{"element":3}}' --workspace demo
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

- **Persistent sessions** -- Logins, cookies, and browser state survive across restarts. Each workspace is a full Chrome user-data directory.
- **Profile cloning** -- Clone a real Chrome profile to start a workspace already logged in. Source browser doesn't need to close.
- **Network capture** -- Record traffic during any action, inspect requests, and replay APIs with browser-backed `fetch()`.
- **Script analysis** -- Capture, beautify, deobfuscate, and sandbox page JavaScript.
- **Computer-use** -- Coordinate-based mouse and keyboard when DOM targeting isn't enough.
- **Stealth** -- Anti-detection defaults: UA spoofing, fingerprint management, automation signal removal.
- **Local or cloud** -- Run browsers locally or on Opensteer Cloud. Same CLI, same SDK.
- **Local view** -- Stream live screenshots from headless sessions to a browser-based viewer.
- **AI agent skills** -- First-party skills for [Codex](https://openai.com/index/introducing-codex/), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Cursor](https://www.cursor.com/), and other compatible agents.

## Skills

Opensteer ships first-party skills that teach AI agents how to use the CLI and SDK. Install into any supported agent:

```bash
npx --yes opensteer@latest skills install
```

Or target specific agents:

```bash
npx --yes opensteer@latest skills install --agent codex --agent cursor --agent claude-code
```

## Documentation

- [Package guide](./packages/opensteer/README.md)
- [Workflow guide](./docs/workflows.md)
- [Instrumentation guide](./docs/instrumentation.md)
- [Skills guide](./skills/README.md)

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

## Community

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [License](./LICENSE)
