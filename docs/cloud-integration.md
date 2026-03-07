# Cloud Integration

Opensteer cloud mode uses a strict v3 contract. No fallback route versions are used.

## Configuration

Enable cloud mode with environment variables:

```bash
OPENSTEER_MODE=cloud
OPENSTEER_API_KEY=ork_your_key
OPENSTEER_AUTH_SCHEME=api-key
OPENSTEER_REMOTE_ANNOUNCE=always
OPENSTEER_CLOUD_PROFILE_ID=bp_123
OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE=true
```

Or use interactive CLI login and saved machine credentials:

```bash
opensteer auth login
opensteer auth status
```

`opensteer auth login` opens your default browser when possible. Use
`opensteer auth login --no-browser` on remote shells, containers, or CI and
paste the printed URL into a browser manually. In `--json` mode, login prompts
go to stderr and the final JSON result stays on stdout.

Saved machine logins remain scoped per resolved cloud host (`baseUrl` +
`siteUrl`). The CLI remembers the last selected cloud host, so `opensteer auth
status`, `opensteer auth logout`, and other cloud commands reuse it by default
unless `--base-url`, `--site-url`, or env vars select a different host.

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
        accessToken: process.env.OPENSTEER_ACCESS_TOKEN,
        baseUrl: process.env.OPENSTEER_BASE_URL,
        authScheme: 'bearer',
        browserProfile: {
            profileId: 'bp_123',
            reuseIfActive: true,
        },
    },
})
```

- Default cloud host: `https://api.opensteer.com`
- Override host with `OPENSTEER_BASE_URL`
- Cloud credential can be provided via:
  - `cloud.apiKey` / `OPENSTEER_API_KEY` (CI/headless recommended)
  - `cloud.accessToken` / `OPENSTEER_ACCESS_TOKEN`
  - saved machine login (`opensteer auth login`) for interactive CLI commands,
    scoped per resolved host
- Auth scheme can be configured via `cloud.authScheme` or `OPENSTEER_AUTH_SCHEME`
  - Supported values: `api-key` (default), `bearer`
- Credential precedence in CLI commands:
  1. explicit flags
  2. environment variables
  3. saved machine login for the resolved host
- Cloud browser profile can be configured via
  `cloud.browserProfile.profileId` or `OPENSTEER_CLOUD_PROFILE_ID`
- Optional profile session reuse can be configured via
  `cloud.browserProfile.reuseIfActive` or
  `OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE`
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

Optional profile launch preference:

- `launchConfig?: { browserProfile?: { profileId: string; reuseIfActive?: boolean } }`

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
- `opensteer.agent({ mode: 'cua' })` is supported in cloud mode after `launch()`.
  CUA actions execute against the active cloud CDP page.
