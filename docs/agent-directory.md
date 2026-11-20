# Verified Agent Directory Operations

The Account service publishes a signed list of verified agent platforms and embedding products at `GET /v1/agent-directory` (`Cache-Control: public, max-age=300`). Homes fetch this list from their configured Account origin so consent screens can verify known redirect origins without ever fetching a URL supplied by an agent.

## Running the operator CLI

An operator needs write access to the Account database to edit the directory. The public HTTP route serves only the signed directory, and the document holds curated names, origins, relationships and public verification keys.

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

## Trust, refresh and expiry

The Home trusts its configured Account origin over HTTPS and reads that origin's public signing keys. Account signs the directory with Ed25519. Signature verification protects the document against tampering in HTTP caches. The signed revision and issue time let the Home enforce rollback protection. Someone who controls the Account origin can serve their own keys and directory, so signing provides no protection against that. Account retains old public keys during rotation, and Homes refresh the key set when they encounter a new key ID.

The Home persists its last accepted directory across restarts. It rejects lower revisions and accepts a renewal at the same revision only if the entries are identical and the signed issue time advances. The document is usable for up to 24 hours from that time. A failed refresh leaves the last accepted copy available until it expires.

The Home refreshes at start and in the background. Consent uses the current copy immediately. On a Home that has never accepted a copy, consent can wait for the first refresh for at most two seconds. Without a usable copy, consent continues with an unverified identity.

A supplied statement that is malformed, expired, replayed, or otherwise unverifiable also leaves consent fully unverified, even for a known platform. A newer directory can withdraw verification by removing an origin, a pairing, or the signing key used at consent. The Home records the first withdrawal and preserves the original evidence. Pending consent uses the current local directory. If verification changes before approval, the Home asks the person to review the request again.
