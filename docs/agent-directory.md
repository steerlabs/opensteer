# Verified Agent Directory Operations

The Account service publishes a signed list of verified agent platforms and embedding products at `GET /v1/agent-directory` (`Cache-Control: public, max-age=300`). Homes fetch this list from their configured Account origin so consent screens can verify known redirect origins without ever fetching a URL supplied by an agent.

## Running the operator CLI

The directory operator CLI ships in the Account image as `dist/agent-directory-operator-main.js`. It requires only `OPENSTEER_CONTROL_PLANE_DATABASE_URL` in the environment:

```bash
node dist/agent-directory-operator-main.js list | add <json-file> | update <id> <json-file> | remove <id>
```

Every command prints JSON to stdout and exits `0` on success, or prints an error message to stderr and exits `1`. Every `add`, `update`, and `remove` runs in a transaction, validates the full directory (unique IDs, unique exact `https://` origins with no wildcards or loopback hosts, valid `embedsVia` references), and increments the monotonic `revision`.

### List current entries

```bash
node dist/agent-directory-operator-main.js list
```

Returns `{"revision":1,"entries":[...]}`.

### Load the initial seed file

`deploy/account/agent-directory.seed.json` is a JSON array of entries, while `add` reads one entry per JSON file. Load each entry in turn (removing the temporary file afterward):

```bash
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
jq -c '.[]' deploy/account/agent-directory.seed.json | while IFS= read -r entry; do
  printf '%s\n' "$entry" > "$tmp"
  node dist/agent-directory-operator-main.js add "$tmp"
done
```

### Add one entry

Write a JSON file containing `id`, `displayName`, `origins`, and optionally `keys` (public JWKS for `EdDSA`/`ES256`) and `embedsVia` (IDs of platform entries already in the directory):

```json
{
  "id": "claude",
  "displayName": "Claude",
  "origins": ["https://claude.ai"]
}
```

```bash
node dist/agent-directory-operator-main.js add /path/to/entry.json
```

Returns `{"revision":2,"entry":{...}}`.

### Change an entry

Write a JSON file with the entry's full updated fields (`id` may be omitted or must match `<id>`):

```bash
node dist/agent-directory-operator-main.js update claude /path/to/updated-entry.json
```

Returns `{"revision":3,"entry":{...}}`.

### Remove an entry

```bash
node dist/agent-directory-operator-main.js remove claude
```

Returns `{"revision":4,"removed":true}`. Removal is refused with a conflict if another entry still lists `<id>` in `embedsVia`; update or remove the embedding entry first.

## What a Home does when it cannot read the list

Homes cache the verified directory in memory (`AgentDirectoryCache`):

- **Refresh interval**: 15 minutes (`defaultAgentDirectoryRefreshIntervalMs`). Within this window, lookups use the cached copy without contacting Account.
- **Maximum age**: 24 hours (`defaultAgentDirectoryMaxAgeMs`). If a refresh fails (network error, non-200 status, oversized response, bad signature, wrong `typ`/`tokenUse`, or lower `revision` than already accepted), the Home keeps serving its last verified copy until 24 hours have elapsed since `fetchedAt` or `issuedAt`.
- **Degradation when unavailable or expired**: `AgentDirectoryCache.get()` never throws into its caller. Once no unexpired verified copy is available, lookups return `null`:
  - Connections without an embedder assertion are shown as **unverified** (self-asserted name plus redirect origin, or `"an app on this computer"` for loopback). The Home never guesses a verified name.
  - Requests that present `opensteer_embedder_assertion` are **refused** (`directory-unavailable`), never silently downgraded to unverified.
  - Existing connections are not disconnected when the directory is unreachable (`isIdentityStillVerified` returns `null` rather than marking them withdrawn).
