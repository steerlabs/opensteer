# Getting Started

## 1) Install

```bash
# npm
npm install opensteer playwright
# pnpm
pnpm add opensteer playwright
```

Set `OPENAI_API_KEY` before using description-based resolve/extract with the
default `gpt-5.1` model.

## 2) Launch and navigate

```ts
import { Opensteer } from 'opensteer'

const ov = new Opensteer({ name: 'my-scraper' })
await ov.launch({ headless: false })

await ov.page.goto('https://example.com')
```

## 3) Explore with snapshots

```ts
const html = await ov.snapshot() // contains c="..." counters
console.log(html)

await ov.click({ description: 'login-btn', element: 3 })
await ov.input({ description: 'email', element: 7, text: 'user@example.com' })
```

## 4) Replay deterministically

On later runs, omit `element` and reuse persisted descriptions:

```ts
await ov.click({ description: 'login-btn' })
await ov.input({ description: 'email', text: 'user@example.com' })
```

## 5) Optional model override

```ts
const ov = new Opensteer({
    name: 'my-scraper',
    model: 'gpt-5.1',
})
```

Or set `OPENSTEER_MODEL=gpt-5.1` in the environment.

## 6) Mode selection

Opensteer defaults to local mode.

Set mode explicitly with:

```bash
OPENSTEER_MODE=local
# or
OPENSTEER_MODE=remote
```

When mode is `remote`, `OPENSTEER_REMOTE_API_KEY` (or `remote.apiKey`) is required.
Remote mode is fail-fast and does not automatically fall back to local mode.

## 7) Close

```ts
await ov.close()
```

## Optional remote force override

```ts
const ov = new Opensteer({
    mode: 'remote',
    remote: {
        apiKey: process.env.OPENSTEER_REMOTE_API_KEY,
        baseUrl: process.env.OPENSTEER_REMOTE_BASE_URL,
    },
})
```

`mode: 'remote'` always forces remote mode, even when
`OPENSTEER_MODE=local`.

Remote base URL defaults to `https://remote.opensteer.com` and can be overridden
with `OPENSTEER_REMOTE_BASE_URL`.
