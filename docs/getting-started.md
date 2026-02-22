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

## 6) Runtime selection

Opensteer defaults to local runtime.

Set runtime explicitly with:

```bash
OPENSTEER_RUNTIME=local
# or
OPENSTEER_RUNTIME=cloud
```

When runtime is `cloud`, `OPENSTEER_API_KEY` (or `cloud.key`) is required.
Cloud mode is fail-fast and does not automatically fall back to local runtime.

## 7) Close

```ts
await ov.close()
```

## Optional cloud force override

```ts
const ov = new Opensteer({
    cloud: {
        enabled: true,
        key: process.env.OPENSTEER_API_KEY,
    },
})
```

`cloud.enabled: true` always forces cloud mode, even when
`OPENSTEER_RUNTIME=local`.

Cloud base URL defaults to `https://cloud.opensteer.com` and can be overridden
with `OPENSTEER_CLOUD_BASE_URL`.
