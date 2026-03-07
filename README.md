# Opensteer

Browser automation framework for AI agents to explore websites and build complex scrapers directly in your codebase.

Opensteer enables AI agents like Claude Code and Codex to interact with browsers and Electron applications, building scrapers directly in your local codebase. It provides a token-efficient suite of tools and agent skills designed for seamless integration.

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
- Stealth cursor preview for interactive actions (CLI default on, SDK default off)

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

Enable cursor preview in SDK:

```ts
const opensteer = new Opensteer({
  name: "quickstart",
  cursor: { enabled: true },
});
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

# Cursor controls
opensteer cursor status --session demo
opensteer cursor off --session demo

# Extraction snapshot + structured extract
opensteer snapshot extraction --session demo
opensteer extract '{"title":"string","href":"string"}' --description "hero section" --session demo

# Close session
opensteer close --session demo
```

For non-interactive runs, set `OPENSTEER_SESSION` or `OPENSTEER_CLIENT_ID`.
Runtime daemon routing for `OPENSTEER_SESSION` is scoped by canonical `cwd`
(`realpath(cwd)`) + logical session id.

Cursor defaults:

- CLI sessions: enabled by default (toggle with `--cursor` or `opensteer cursor on|off`)
- SDK instances: disabled by default (set `cursor.enabled: true` to opt in)

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

- Interactive CLI login:

```bash
opensteer auth login
opensteer auth status
opensteer auth logout
```

- `opensteer auth login` opens your default browser when possible. Use
  `--no-browser` on remote shells, containers, or CI and paste the printed URL
  into a browser manually. In `--json` mode, login prompts go to stderr and the
  final JSON result stays on stdout.
- Saved machine logins remain scoped per resolved cloud API host (`baseUrl`).
  The CLI also remembers the last selected cloud host, so `opensteer auth
  status`, `opensteer auth logout`, and other cloud commands reuse it by
  default unless `--base-url` or env vars select a different host.

- `OPENSTEER_BASE_URL` overrides the default cloud host
- `OPENSTEER_ACCESS_TOKEN` provides bearer auth for cloud commands
- `OPENSTEER_AUTH_SCHEME` supports `api-key` (default) or `bearer`
- Credential precedence: explicit flags > environment variables > saved machine login
- `OPENSTEER_CLOUD_PROFILE_ID` optionally launches into a specific cloud browser profile
- `OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE` (`true|false`) optionally reuses an active profile session
- `cloud: true` or a `cloud` options object overrides `OPENSTEER_MODE`
- Cloud mode is fail-fast (no automatic fallback to local)
- `Opensteer.from(page)`, `uploadFile`, `exportCookies`, and `importCookies` are local-only

Select a cloud browser profile in SDK:

```ts
const opensteer = new Opensteer({
  cloud: {
    accessToken: process.env.OPENSTEER_ACCESS_TOKEN,
    browserProfile: {
      profileId: "bp_123",
      reuseIfActive: true,
    },
  },
});
```

Sync local profile cookies into a cloud profile:

```bash
opensteer profile sync \
  --from-profile-dir ~/Library/Application\ Support/Google/Chrome/Default \
  --to-profile-id bp_123 \
  --domain github.com
```

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
