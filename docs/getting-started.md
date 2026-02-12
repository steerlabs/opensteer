# Getting Started

## 1) Install

```bash
# npm
npm install oversteer playwright
# pnpm
pnpm add oversteer playwright
```

## 2) Launch and navigate

```ts
import { Oversteer } from 'oversteer'

const ov = new Oversteer({ name: 'my-scraper' })
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
const ov = new Oversteer({
    name: 'my-scraper',
    model: 'gpt-5.1',
})
```

Or set `OVERSTEER_MODEL=gpt-5.1` in the environment.

## 6) Close

```ts
await ov.close()
```
