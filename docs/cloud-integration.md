# Cloud Integration

The OSS SDK is local-first and does not include a cloud execution mode.

Oversteer includes built-in LLM resolution/extraction and uses `gpt-5.1` by
default. You can override the model with top-level `model` or
`OVERSTEER_MODEL`:

```ts
const ov = new Oversteer({
    name: 'my-scraper',
    model: 'gpt-5.1',
})
```

For MCP server hosting, build a separate wrapper project that owns the browser
session and maps tools to `Oversteer` methods and raw Playwright calls.
