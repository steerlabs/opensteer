# Remote Integration

Opensteer remote mode uses one unversioned contract by default.

## Configuration

Set remote mode universally with environment variables:

```bash
OPENSTEER_MODE=remote
OPENSTEER_REMOTE_API_KEY=ork_your_key
```

Opensteer defaults to local mode when `OPENSTEER_MODE` is unset.

You can also force remote mode in constructor config:

```ts
import { Opensteer } from 'opensteer'

const opensteer = new Opensteer({
    mode: 'remote',
    remote: {
        apiKey: process.env.OPENSTEER_REMOTE_API_KEY,
        baseUrl: process.env.OPENSTEER_REMOTE_BASE_URL,
    },
})
```

- Default remote host: `https://remote.opensteer.com`
- Override host with `OPENSTEER_REMOTE_BASE_URL`
- API key can be provided via `remote.apiKey` or `OPENSTEER_REMOTE_API_KEY`
- `mode` in constructor config overrides `OPENSTEER_MODE`
- Remote mode is fail-fast and does not fall back to local mode

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

- `Opensteer.from(page)` is unsupported in remote mode.
- `uploadFile`, `exportCookies`, and `importCookies` are unsupported in remote
  mode because they depend on local filesystem paths.
