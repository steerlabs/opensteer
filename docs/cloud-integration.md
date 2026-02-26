# Cloud Integration

Opensteer cloud mode uses a strict v3 contract. No fallback route versions are used.

## Configuration

Enable cloud mode with environment variables:

```bash
OPENSTEER_MODE=cloud
OPENSTEER_API_KEY=ork_your_key
OPENSTEER_AUTH_SCHEME=api-key
OPENSTEER_REMOTE_ANNOUNCE=always
```

These values can be placed in `.env` files. Opensteer auto-loads
`.env.<NODE_ENV>.local`, `.env.local` (skipped when `NODE_ENV=test`),
`.env.<NODE_ENV>`, then `.env` from your `storage.rootDir` (default:
`process.cwd()`). Existing `process.env` values are not overwritten. Set
`OPENSTEER_DISABLE_DOTENV_AUTOLOAD=true` to disable auto-loading.

Opensteer defaults to local mode when `OPENSTEER_MODE` is unset and `cloud` is not configured.

You can also force cloud mode in constructor config:

```ts
import { Opensteer } from 'opensteer'

const opensteer = new Opensteer({
    cloud: {
        apiKey: process.env.OPENSTEER_API_KEY,
        baseUrl: process.env.OPENSTEER_BASE_URL,
        authScheme: 'api-key', // or 'bearer'
    },
})
```

- Default cloud host: `https://remote.opensteer.com`
- Override host with `OPENSTEER_BASE_URL`
- API key can be provided via `cloud.apiKey` or `OPENSTEER_API_KEY`
- Auth scheme can be configured via `cloud.authScheme` or `OPENSTEER_AUTH_SCHEME`
  - Supported values: `api-key` (default), `bearer`
- Default cloud announcement policy: `always`
- Override cloud announcement with `cloud.announce` or `OPENSTEER_REMOTE_ANNOUNCE`
  - Supported values: `always`, `off`, `tty`
- `cloud` in constructor config overrides `OPENSTEER_MODE`
- Cloud mode is fail-fast and does not fall back to local mode

## Control API Contract

- `POST /sessions`
- `GET /sessions/:sessionId`
- `DELETE /sessions/:sessionId`
- `POST /selector-cache/import`

`POST /sessions` now requires:

- `cloudSessionContractVersion: "v3"`
- `sourceType: "local-cloud"`
- `clientSessionHint: string`
- `localRunId: string`

The response includes `cloudSession` metadata and `cloudSessionUrl` for deep links.

You can read these values at runtime with:

- `opensteer.getCloudSessionId()`
- `opensteer.getCloudSessionUrl()`

## WebSocket Contract

- `/ws/action/:sessionId`
- `/ws/cdp/:sessionId`

## Runtime Internal Contract

- `POST /internal/sessions`
- `GET /internal/sessions/:sessionId`
- `DELETE /internal/sessions/:sessionId`
- `POST /internal/sessions/:sessionId/access`

## Notes

- `Opensteer.from(page)` is unsupported in cloud mode.
- `uploadFile`, `exportCookies`, and `importCookies` are unsupported in cloud mode because they depend on local filesystem paths.
