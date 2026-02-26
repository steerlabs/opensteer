# Opensteer

Open-source browser automation SDK for coding agents and deterministic replay.

Opensteer combines descriptor-aware actions, resilient selector persistence,
clean HTML snapshots, and first-class local or cloud runtime support.

## Requirements

- Node.js `>=20`
- A browser environment supported by Playwright
- API key for your selected model provider if you use LLM resolve/extract

## Install

```bash
# npm
npm install opensteer
# pnpm
pnpm add opensteer
```

If your environment skips Playwright browser downloads, run:

```bash
npx playwright install chromium
```

## Quickstart (SDK)

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ name: "my-scraper" });
await opensteer.launch({ headless: false });

try {
  await opensteer.goto("https://example.com");
  const html = await opensteer.snapshot();
  console.log(html.slice(0, 500));

  await opensteer.click({ description: "main call to action", element: 3 });
} finally {
  await opensteer.close();
}
```

## CUA Agent (Stagehand-Style)

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  model: "openai/computer-use-preview",
});

await opensteer.launch();

const agent = opensteer.agent({
  mode: "cua",
});

const result = await agent.execute({
  instruction: "Go to Hacker News and open the top story.",
  maxSteps: 20,
  highlightCursor: true,
});

console.log(result.message);
await opensteer.close();
```

Supported CUA providers in V1: `openai`, `anthropic`, `google`.

## Quickstart (CLI)

Opensteer CLI separates runtime routing from selector namespace routing.

- Runtime routing: `--session` or `OPENSTEER_SESSION`
- Selector namespace: `--name` or `OPENSTEER_NAME` (used by `open`)

```bash
opensteer open https://example.com --session agent-a --name product-scraper
opensteer snapshot --session agent-a
opensteer click 3 --session agent-a
opensteer status --session agent-a
opensteer close --session agent-a
```

In non-interactive environments, set `OPENSTEER_SESSION` or
`OPENSTEER_CLIENT_ID` explicitly.

## Resolution and Replay Model

For descriptor-aware actions (`click`, `input`, `hover`, `select`, `scroll`):

1. Reuse persisted path for `description`
2. Use `element` counter from snapshot
3. Use explicit CSS `selector`
4. Use built-in LLM resolution (`description` required)
5. Throw actionable error

When steps 2-4 succeed and `description` is present, Opensteer persists the
path for deterministic replay in `.opensteer/selectors/<namespace>`.

## Cloud Mode

Opensteer defaults to local mode.

- `OPENSTEER_MODE=local|cloud`
- `OPENSTEER_API_KEY` or `cloud.apiKey` required in cloud mode
- `OPENSTEER_BASE_URL` or `cloud.baseUrl` to override the default cloud host
- `OPENSTEER_AUTH_SCHEME` or `cloud.authScheme` for auth header mode
  (`api-key` or `bearer`)
- `cloud: true` or a `cloud` options object overrides `OPENSTEER_MODE`

`.env` files are auto-loaded from `storage.rootDir` (default `process.cwd()`)
in this order: `.env.<NODE_ENV>.local`, `.env.local` (except in test),
`.env.<NODE_ENV>`, `.env`. Existing `process.env` values are not overwritten.
Set `OPENSTEER_DISABLE_DOTENV_AUTOLOAD=true` to disable.

## Docs

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [CLI Reference](docs/cli-reference.md)
- [Cloud Integration](docs/cloud-integration.md)
- [Selectors and Storage](docs/selectors.md)
- [HTML Cleaning and Snapshot Modes](docs/html-cleaning.md)
- [Live Web Validation Suite](docs/live-web-tests.md)

## Community

- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
