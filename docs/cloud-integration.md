# Cloud Integration

Opensteer cloud mode uses one unversioned contract by default.

## Configuration

```ts
import { Opensteer } from 'opensteer'

const ov = new Opensteer({
    cloud: {
        enabled: true,
        key: process.env.OPENSTEER_API_KEY,
    },
})
```

- Default cloud host: `https://cloud.opensteer.com`
- Override host with `OPENSTEER_CLOUD_BASE_URL`
- API key can be provided via `cloud.key` or `OPENSTEER_API_KEY`

## Control API Contract

- `POST /sessions`
- `GET /sessions/:sessionId`
- `DELETE /sessions/:sessionId`
- `POST /selector-cache/import`

## WebSocket Contract

- `/ws/action/:sessionId`
- `/ws/cdp/:sessionId`

## Runtime Internal Contract

- `POST /internal/sessions`
- `GET /internal/sessions/:sessionId`
- `POST /internal/sessions/:sessionId/close`

No fallback route versions are used.

## Notes

- `Opensteer.from(page)` is unsupported in cloud mode.
- `uploadFile`, `exportCookies`, and `importCookies` are unsupported in cloud
  mode because they depend on local filesystem paths.
