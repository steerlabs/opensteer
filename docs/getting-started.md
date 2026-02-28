# Getting Started

## 1) Requirements

- Node.js `>=20`
- Playwright-compatible runtime environment
- API key for your model provider if you use LLM resolve/extract

## 2) Install

```bash
# npm
npm install opensteer
# pnpm
pnpm add opensteer
# bun
bun add opensteer
```

If browser binaries are not present, run:

```bash
npx playwright install chromium
```

## 3) Create an instance and launch

```ts
import { Opensteer } from 'opensteer'

const opensteer = new Opensteer({ name: 'my-scraper' })
await opensteer.launch({ headless: false })
```

## 4) Navigate and explore

```ts
await opensteer.goto('https://example.com')

const html = await opensteer.snapshot() // includes c="..." counters
console.log(html)

await opensteer.click({ description: 'login button', element: 3 })
await opensteer.input({
  description: 'email input',
  element: 7,
  text: 'user@example.com',
})
```

## 5) Replay deterministically

After selectors are persisted for a `description`, you can often omit `element`:

```ts
await opensteer.click({ description: 'login button' })
await opensteer.input({
  description: 'email input',
  text: 'user@example.com',
})
```

If a cached selector later fails with `TARGET_NOT_FOUND`, Opensteer performs a
one-shot AI self-heal from `description`, refreshes the cache, and retries.

## 6) Configure model and mode (optional)

Opensteer defaults to:

- `model: 'gpt-5.1'`
- local mode (`OPENSTEER_MODE=local`)

Set a model:

```bash
OPENSTEER_MODEL=gpt-5-mini
```

Enable cloud mode:

```bash
OPENSTEER_MODE=cloud
OPENSTEER_API_KEY=ork_your_key
```

Additional cloud options:

- `OPENSTEER_BASE_URL` to override `https://api.opensteer.com`
- `OPENSTEER_AUTH_SCHEME` as `api-key` (default) or `bearer`
- `OPENSTEER_REMOTE_ANNOUNCE` as `always`, `off`, or `tty`

In code, `cloud: true` or a `cloud` options object overrides `OPENSTEER_MODE`.
Cloud mode is fail-fast and does not automatically fall back to local mode.

## 7) Dotenv autoload behavior

Opensteer loads `.env` files from `storage.rootDir` (default `process.cwd()`)
in this order:

1. `.env.<NODE_ENV>.local`
2. `.env.local` (skipped when `NODE_ENV=test`)
3. `.env.<NODE_ENV>`
4. `.env`

Existing `process.env` values are never overwritten. Set
`OPENSTEER_DISABLE_DOTENV_AUTOLOAD=true` to disable.

## 8) Close resources

```ts
await opensteer.close()
```

## 9) Use CUA Agent

```ts
const opensteer = new Opensteer({
  model: 'openai/computer-use-preview',
})
await opensteer.launch()

const agent = opensteer.agent({
  mode: 'cua',
})

const result = await agent.execute({
  instruction: 'Go to docs and summarize the first section',
  maxSteps: 20,
  highlightCursor: true,
})

console.log(result.message)
await opensteer.close()
```

V1 CUA providers: `openai`, `anthropic`, `google`.
