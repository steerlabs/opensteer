# Cloud Integration

The OSS SDK is local-first and does not include a cloud execution mode.

To integrate hosted LLMs or remote services, configure callbacks under `ai`:

```ts
const ov = new Oversteer({
    name: 'my-scraper',
    ai: {
        resolve: async ({ html, description }) => ({ element: 5 }),
        extract: async ({ html, schema }) => ({ items: [] }),
    },
})
```

For MCP server hosting, build a separate wrapper project that owns the browser
session and maps tools to `Oversteer` methods and raw Playwright calls.
