# Opensteer

Browser automation framework for developers and AI agents with deterministic replay.

Opensteer gives you one API for local and cloud runs, description-based actions,
structured extraction, and CUA agent workflows.

## Install

Main setup (recommended):

```bash
npm i -g opensteer
opensteer skills install
```

SDK package (when importing `Opensteer` in app code):

```bash
# npm
npm install opensteer

# pnpm
pnpm add opensteer

# bun
bun add opensteer
```

## Requirements

- Node.js `>=20`
- Playwright-supported browser runtime
- Model provider API key for LLM-powered resolution/extraction/CUA

If browser binaries are missing:

```bash
npx playwright install chromium
```

## What It Does

- Unified local/cloud execution with the same API surface
- Descriptor-aware actions with selector persistence for replay
- Structured extraction with typed schemas
- CUA agent support (`openai`, `anthropic`, `google`)

## Quick Start: SDK

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ name: "quickstart" });

try {
  await opensteer.launch();
  await opensteer.goto("https://example.com");

  await opensteer.snapshot({ mode: "action" });
  await opensteer.click({ description: "main call to action" });

  await opensteer.snapshot({ mode: "extraction" });
  const data = await opensteer.extract({
    description: "hero section",
    schema: { title: "string", href: "string" },
  });

  console.log(data);
} finally {
  await opensteer.close();
}
```

## Quick Start: CUA Agent

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ model: "openai/computer-use-preview" });

try {
  await opensteer.launch();
  const agent = opensteer.agent({ mode: "cua" });
  const result = await agent.execute({
    instruction: "Go to Hacker News and open the top story.",
    maxSteps: 20,
  });
  console.log(result.message);
} finally {
  await opensteer.close();
}
```

## Quick Start: CLI

```bash
# Open a browser session and bind a selector namespace
opensteer open https://example.com --session demo --name quickstart

# Action snapshot + interaction
opensteer snapshot action --session demo
opensteer click --description "main call to action" --session demo

# Extraction snapshot + structured extract
opensteer snapshot extraction --session demo
opensteer extract '{"title":"string","href":"string"}' --description "hero section" --session demo

# Close session
opensteer close --session demo
```

For non-interactive runs, set `OPENSTEER_SESSION` or `OPENSTEER_CLIENT_ID`.

## For AI Agents

Use this workflow to keep scripts replayable and maintainable:

1. Use Opensteer APIs (`goto`, `snapshot`, `click`, `input`, `extract`) instead of raw Playwright calls.
2. Keep namespace consistent: SDK `name` must match CLI `--name`.
3. Take `snapshot({ mode: "action" })` before actions and `snapshot({ mode: "extraction" })` before extraction.
4. Prefer `description` targeting for persistence and deterministic reruns.
5. Always wrap runs in `try/finally` and call `close()`.

First-party skills:

- [skills/opensteer/SKILL.md](skills/opensteer/SKILL.md)
- [skills/electron/SKILL.md](skills/electron/SKILL.md)
- [skills/README.md](skills/README.md)

Install the Opensteer skill pack:

```bash
opensteer skills install
```

Claude Code marketplace plugin:

```text
/plugin marketplace add steerlabs/opensteer
/plugin install opensteer@opensteer-marketplace
```

## Cloud Mode

Opensteer defaults to local mode. Enable cloud mode with env or constructor options:

```bash
OPENSTEER_MODE=cloud
OPENSTEER_API_KEY=<your_api_key>
```

- `OPENSTEER_BASE_URL` overrides the default cloud host
- `OPENSTEER_AUTH_SCHEME` supports `api-key` (default) or `bearer`
- `cloud: true` or a `cloud` options object overrides `OPENSTEER_MODE`
- Cloud mode is fail-fast (no automatic fallback to local)
- `Opensteer.from(page)`, `uploadFile`, `exportCookies`, and `importCookies` are local-only

## Resolution and Replay

For descriptor-aware actions (`click`, `input`, `hover`, `select`, `scroll`):

1. Reuse persisted selector path from `description`
2. Try snapshot counter (`element`)
3. Try explicit CSS selector (`selector`)
4. Use LLM resolution (`description` required)
5. Return actionable error

When step 2-4 succeeds and `description` is present, selector paths are cached
in `.opensteer/selectors/<namespace>` for deterministic replay.

## Docs

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [CLI Reference](docs/cli-reference.md)
- [Cloud Integration](docs/cloud-integration.md)
- [Selectors and Storage](docs/selectors.md)
- [HTML Cleaning and Snapshot Modes](docs/html-cleaning.md)
- [Live Web Validation Suite](docs/live-web-tests.md)
- [Skills](docs/skills.md)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Discussions](https://github.com/steerlabs/opensteer/discussions)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
