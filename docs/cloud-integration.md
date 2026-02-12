# Cloud Integration

The OSS SDK is local-first and does not include a cloud execution mode.

Opensteer includes built-in LLM resolution/extraction and uses `gpt-5.1` by
default. You can override the model with top-level `model` or
`OPENSTEER_MODEL`:

```ts
const ov = new Opensteer({
    name: 'my-scraper',
    model: 'gpt-5.1',
})
```

For MCP server hosting, build a separate wrapper project that owns the browser
session and maps tools to `Opensteer` methods and raw Playwright calls.
