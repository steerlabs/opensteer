# Remote Integration

Opensteer remote mode uses a strict v3 contract. No fallback route versions are used.

## Configuration

Set remote mode universally with environment variables:

```bash
OPENSTEER_MODE=remote
OPENSTEER_API_KEY=ork_your_key
OPENSTEER_APP_URL=https://opensteer.com
OPENSTEER_REMOTE_ANNOUNCE=always
```

Opensteer defaults to local mode when `OPENSTEER_MODE` is unset.

You can also force remote mode in constructor config:

```ts
import { Opensteer } from 'opensteer'

const opensteer = new Opensteer({
    mode: 'remote',
    remote: {
        apiKey: process.env.OPENSTEER_API_KEY,
        baseUrl: process.env.OPENSTEER_BASE_URL,
        appUrl: process.env.OPENSTEER_APP_URL,
    },
})
```

- Default remote host: `https://remote.opensteer.com`
- Override host with `OPENSTEER_BASE_URL`
- API key can be provided via `remote.apiKey` or `OPENSTEER_API_KEY`
- Default cloud app URL: `https://opensteer.com`
- Override cloud app URL with `remote.appUrl` or `OPENSTEER_APP_URL`
- Default remote announcement policy: `always`
- Override remote announcement with `remote.announce` or `OPENSTEER_REMOTE_ANNOUNCE`
  - Supported values: `always`, `off`, `tty`
- `mode` in constructor config overrides `OPENSTEER_MODE`
- Remote mode is fail-fast and does not fall back to local mode

## Control API Contract

- `POST /sessions`
- `GET /sessions/:sessionId`
- `DELETE /sessions/:sessionId`
- `POST /selector-cache/import`

`POST /sessions` now requires:

- `remoteSessionContractVersion: "v3"`
- `sourceType: "local-remote"`
- `clientSessionHint: string`
- `localRunId: string`

The response includes `cloudSession` metadata and `cloudSessionUrl` for deep links.

## WebSocket Contract

- `/ws/action/:sessionId`
- `/ws/cdp/:sessionId`

## Runtime Internal Contract

- `POST /internal/sessions`
- `GET /internal/sessions/:sessionId`
- `DELETE /internal/sessions/:sessionId`
- `POST /internal/sessions/:sessionId/access`

## Notes

- `Opensteer.from(page)` is unsupported in remote mode.
- `uploadFile`, `exportCookies`, and `importCookies` are unsupported in remote
  mode because they depend on local filesystem paths.
