# Opensteer Passwords

`Opensteer Passwords.app` is the broker: the one process that holds the vault
and its grants, authenticates the person for the actions that need them, and
releases a saved login's fields, one field per fill, only into a sign-in the
person allowed for a Workspace or approved now. The contract is
[docs/passwords.md](../../../../docs/passwords.md); the wire is
[passwords-broker.ts](../../../../packages/protocol/src/passwords-broker.ts).

| Target                  | What it is                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PasswordsCore`         | The vault, crypto, site matching, TOTP and import code. Pure Swift (Foundation, CryptoKit, Security, LocalAuthentication).                                                        |
| `PasswordsBrokerKit`    | The broker: socket and peers (`IPC/`), wire types (`Wire/`), the transaction state machine, the authentication policy and vault access (`Broker/`), the Passwords window (`UI/`). |
| `PasswordsBroker`       | The executable: the build mode, `--verify-peer`, `--prepare-replacement`, then the app.                                                                                           |
| `PasswordsImportWorker` | `Contents/Helpers/Opensteer Passwords Import`: parses one export from stdin in the App Sandbox, answers on stdout. No keys.                                                       |
| `PasswordsTestSupport`  | Software owner keys, for tests only.                                                                                                                                              |

```sh
pnpm --filter @opensteer/desktop build:passwords-broker   # builds dist/Opensteer Passwords.app
swift test --package-path apps/desktop/native/passwords --skip "SecureEnclaveTests|SnapshotTests"
```

The broker derives release peer rules and the keychain group from its own code
signature. `OPENSTEER_DEV_TRUST` is set by non-release builds when no signing file is supplied.
The import worker links one of two checked-in plists for its sandbox identifier;
no generated source or plist is needed for bare `swift test`.

Tests never prompt: owner keys are software keys, the Secure Enclave checks
use contexts with `interactionNotAllowed`, and authentication is scripted. The failure inventory they cover is in
[Tests/FAILURES.md](Tests/FAILURES.md).

## Release and development

|                 | Release (`--sign <identity>`)                                            | Development                          |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| Bundle ID       | `com.opensteer.passwords`                                                | `com.opensteer.passwords.dev`        |
| Folder          | `~/Library/Application Support/Opensteer/Passwords`                      | `… /Passwords (Development)`         |
| Who may connect | The Opensteer desktop (Stable or Beta), Developer ID, team `<teamId>`    | Any process of this user             |
| Protected state | The broker's keychain access group `<teamId>.com.opensteer.passwords`    | `FileProtectedStore` in `Protected/` |
| Signature       | Developer ID, hardened runtime, timestamp, embedded provisioning profile | Ad-hoc                               |

The folder holds `ipc.sock` (0600), `broker.lock` (held for the broker's
life), `Vault/` with its `.Vault.lock` beside it, `activity.jsonl` (0600,
newest 500 sign-ins, no secrets) and, in development, `Protected/`. The desktop's own `lifecycle.lock` and the
installed app sit beside them.

### Signing setup

See [desktop signing](../../SIGNING.md) for the validated identity input,
explicit development trust, Developer ID provisioning, keychain entitlements
and notarization. The builder derives the team's keychain group from that input;
it rejects a missing or incompatible release provisioning profile.

## What the broker calls, in order

All of these are synchronous and not thread-safe; own them from one actor or
queue. Every user action that changes the vault is exactly one commit. The
owner keys never need the person: when the person must authenticate is the
broker's policy (below), not the vault's.

**Status.** `Vault.exists(at: root)` is false: set-up is required.
Otherwise the key policy record (`OwnerKeyPolicy.isCurrent`) must be there,
then `Vault.open(root:protectedStore:)` verifies the whole history from
public data; `vault.verifyHistory()` repeats the check later. A missing or
other policy, or any thrown `VaultError`, means the vault cannot be used;
show it and offer a reset, except for a newer format, which requires an update and never offers reset. There is no repair. `NotUnlockedSinceRestart`
from the protected store means nothing yet: the Mac has not been unlocked
since it started.

**Set up** (after authenticating the person):

1. `SecureEnclaveOwnerKeyStore.isAvailable`; refuse set-up without it.
2. Delete every `ProtectedName`, then
   `let owner = try SecureEnclaveOwnerKeyStore.create(in: protectedStore)`
   (`.privateKeyUsage`, `AfterFirstUnlockThisDeviceOnly`) and write
   `OwnerKeyPolicy.record()` as `.ownerKeyPolicy`.
3. `Vault.create(root:protectedStore:deviceName:owner:)`. `root` must not
   exist; its parent must.

Later launches use `SecureEnclaveOwnerKeyStore.load(from: protectedStore)`.

**A sign-in** (read-only unless the person allows the account):

1. `let unlocked = try vault.unlock(owner: owner)`, then
   `try unlocked.items(withinSite: site)` and
   `try unlocked.grant(for: GrantKey(deploymentId:workspaceId:site:))`.
2. A current permission grant whose pinned revision matches: authorize the login and `close()`; field releases are separate.
   Otherwise keep only the items' IDs, revisions, usernames and labels, and
   `close()`, so no password waits for the person.
3. When the person allows one, unlock again and authorize it only if
   `items(withinSite:)` still has it at that revision; for Allow, commit
   `VaultChanges(grant: [GrantChange(…)])` in the same unlock. After a
   authorization, keep only its descriptor. Each field release unlocks again;
   TOTP uses `item.totp?.code(at: Date())` and retains no seed in the transaction.

**Add, edit, delete and grants:**
`ItemDraft.validate()` first, so a bad form never costs an authentication.
Then `vault.unlock(...)`, one of `add([ItemDraft])`, `update(Item)`,
`delete(ids:)` or `commit(VaultChanges)`, then `close()`. `VaultChanges`
also sets grants (`grant`, for a saved login or one the commit adds) and
removes them (`revoke`); the commit that deletes a login, or changes its
origins, login URL or username, drops its grants. Use
`Origins.normalizeOrigin` and `Origins.normalizeLoginURL` on what the person
typed.

**Import:**

1. In the worker: `PasswordImporter.parse(data)` returns an `ImportResult`
   (`Codable`, for the trip back to the broker). `ImportError.description`
   is the text to show.
2. In the broker: unlock, then
   `try ImportPlan(candidates: result.candidates, existing: try unlocked.items())`.
   Show `plan.entries` (no passwords) with their classifications, and
   `result.skipped` and `result.ignoredURLs` (web addresses left out of
   imported logins). The plan refuses candidates that share a `sourceRow`,
   and keeps saved items' IDs only, never their passwords or seeds.
3. `try unlocked.commit(try plan.changes(selecting: rows))`, then `close()`.
   Updates are `CredentialReplacement`s the commit applies to each item as it
   is then. Selecting two rows of one conflict group throws.

Import rules worth knowing:

- Bitwarden CSV joins URIs with commas. A comma splits only when a scheme
  (`https://`, `androidapp://`, …) follows it, a part from a split never
  gains `https://`, and a cell whose URIs span sites skips the row: the JSON
  export keeps them apart.
- Bitwarden JSON `match` 4 (a regular expression) and 5 (never fill) are left
  out and listed; 0–3 and null become origins; any other value is refused.
- Limits apply while parsing: 16 MiB in, 20,000 rows, 1,024 columns,
  1,000,000 CSV cells kept (rows of the wrong width keep none), 20,000 JSON
  array elements and 2,000,000 JSON values, 10,000 candidates.
- A bare TOTP secret is always base32 (RFC 4648), never guessed as hex.
- Every parser folds case in ASCII only.

**Reset** (there is no recovery in Phase 1), after authenticating the
person: delete the vault folder, grants included, then `delete` every
`ProtectedName`, then set up again. Every saved password is gone for good;
only those the person also keeps elsewhere can be imported again.

## Secrets lifetime

- `UnlockedVault` holds the epoch key and the manifest (item IDs, revisions,
  hashes and the grants) only. Every read decrypts on demand; plaintext lives
  only in what you keep.
- Close it right after the selection or commit. Never keep one across user
  actions; `deinit` closes it as a backstop.
- `close()` drops the epoch key and the manifest. Every call after it throws
  `VaultError.closed`.
- Core wipes the key and item-plaintext copies it makes (`Data.wipe`) and
  returns CryptoKit's plaintext without copying it again. CryptoKit's own key
  storage wipes itself. A decrypted password is a Swift `String`, which
  cannot be wiped: keep it no longer than its use.

## Protected state

`ProtectedStore` holds the five `ProtectedName` values: the two Secure Enclave
key representations, the key policy record (canonical `{"policy":2,"v":1}`),
the checkpoint and a settings blob owned by the broker.
Production must implement it on the broker's data-protection keychain access
group. `FileProtectedStore` is for tests and development builds only: a
same-user process can read and roll back its files.

The checkpoint is canonical `{"hash","seq","v":1,"vaultId"}`, the newest head
this Mac accepted. A `Vault` may stay open for the broker's whole life, so it never
relies on what it verified earlier: every unlock and every commit first
verifies the folder against the current checkpoint and requires the head the
object holds (or, for a commit, the head its unlock read), holding a kernel
`flock` on `.<folder>.lock` beside the folder across the check and the use.
Opening refuses a folder whose history does not contain it
(`rollbackDetected`), and refuses a vault without one (`checkpointMissing`).
A newer head that chains from it and verifies is accepted, and the checkpoint
advances. Every checkpoint write is a compare-and-swap: it replaces only the
checkpoint the history was just verified against, so even a writer that does
not share the lock is refused (`headMoved`) rather than overwritten.

## Formats

All files are canonical JSON (RFC 8785; integers only, within ±(2^53−1)),
and parsing requires exactly canonical bytes. Binary fields are base64url
without padding; hashes and key IDs are lower-case SHA-256 hex. Every format
has `"v":1` except the manifest (`"v":2`, with grants) and passkey-bearing
items (`"v":2`). A version 1 manifest is never read as one without grants.
Newer item payloads are skipped and their entries and sealed bytes preserved;
newer manifest, commit, HEAD or checkpoint versions require an Opensteer
update, never Start Fresh. Integrity checks still apply.

```
<root>/HEAD                      {"hash","seq","v":1}
<root>/commits/<seq:012>.json    signed commits, contiguous from 0
<root>/objects/<sha256 hex>      sealed objects, content addressed
```

- **Sealed object:** `{"ct","keyCt","keyNonce","nonce","v":1}`. The payload is
  sealed (AES-256-GCM, 12-byte random nonce) under a fresh 32-byte data key,
  and the data key under the epoch key.
- **AAD bindings:**
  - item: `{"epoch","itemId","purpose":"item","revision","v":1,"vaultId"}`;
    its data key uses `"purpose":"item-key"`;
  - manifest: `{"epoch","purpose":"manifest","seq","v":1,"vaultId"}`, with
    `"manifest-key"` for its data key;
  - epoch key: `{"epoch","purpose":"epoch-key","v":1,"vaultId"}`, HPKE info
    `opensteer-passwords/v1/epoch-key`.
- **Item:** `{"createdAt","id","label","loginURL","origins","password","totp","updatedAt","username","v":1}`,
  with `totp` = `{"algorithm","digits","period","secret"}` or null.
  - Limits, in UTF-8 bytes: username ≤ 1,024; password 1–4,096; label null or
    1–200; login URL ≤ 2,048. At most 8 origins and 10,000 items.
  - Strings are kept byte for byte.
- **Item v2:** `{"createdAt","id","label","loginURL","origins","passkeys","password","totp","updatedAt","username","v":2}`.
  Password is null or 1–4,096 bytes; 0–8 passkeys. At least one credential
  is required. A password with no passkeys always encodes byte-identically as v1.
  This reader release creates no passkeys or v2 items.
- **Passkey:** `{"algorithm":-7,"createdAt","credentialId","privateKey","rpId","userDisplayName","userHandle","userName","v":1}`.
  ES256 only; credential ID 16–1,023 bytes, user handle 1–64 bytes, private
  key PKCS#8 P-256 DER. Names are at most 1,024 UTF-8 bytes (empty allowed).
  The lower-case DNS relying party follows the strict origin host rules and
  shares a registrable domain with an item origin. Credential IDs and
  (relying party, user handle) pairs are unique within the item.
- **Manifest:** `{"grants":[…],"items":[{"hash","id","revision"}],"seq","v":2,"vaultId"}`,
  items sorted by ID. Unchanged items keep their object and revision; a
  change is revision + 1 with a fresh data key.
- **Grant:** `{"deploymentId","deploymentName","loginId","permissionVersion":4|5,"revision","site","workspaceId","workspaceName"}`:
  agents in that Workspace of that Deployment may sign in to `site`
  (`https://<registrable domain>`) as that login. Version 4 allows browser
  origins only; version 5 also allows apps without destination verification. Sorted by
  (deploymentId, workspaceId, site) in UTF-8 byte order, so at most one per
  key; each names a login the manifest lists, with an origin within the site
  when written. Legacy grants without permission version and revision remain readable,
  cannot authorize, and are dropped on the next commit. Names are display text,
  1–512 bytes; at most 1,000 grants.
- **Commit:** `{"createdAt","envelopes":[{"ct","enc","recipient"}],"epoch","manifest","membership":{"owners":[{"agreement","deviceName","signing"}]},"parent","seq","signature","signer","v":1,"vaultId"}`.
  - Keys are X9.63 P-256. A key ID is the SHA-256 of the X9.63 bytes.
  - Envelopes go to exactly the owners' agreement keys, sorted by recipient.
  - The signature is a raw 64-byte, low-S ECDSA P-256/SHA-256 signature over
    `opensteer-passwords commit v1\n` followed by the canonical commit
    without `signature`, so an owner key's signature over anything else is
    never a commit's. The commit hash covers the whole file.
- **Authority:** genesis (seq 0, parent null, epoch 0) is signed by an owner
  in its own membership. Every later commit is signed by an owner in the
  **previous** commit's membership. An owner's agreement key may only be
  removed with `epoch = parent.epoch + 1`. A later version adds a `recovery`
  member next to `owners`.
- **Writes:** objects, then the commit (exclusive create), then the
  checkpoint, then HEAD. Neither HEAD nor the open `Vault` ever moves past
  what the checkpoint pins, so nothing is released from a head a rolled-back
  folder could quietly undo. A failed checkpoint write removes the commit
  file again and throws. Each file is a temp file, `F_FULLFSYNC`, rename, then
  an fsync of the directory. Files are opened without blocking and must be
  regular files, so a named pipe planted in the folder cannot stall a read. Open adopts (and pins) a verified commit at
  HEAD + 1 left by a crash. Anything else inconsistent is an error.

## Sites and origins

- `Origins.normalizeOrigin` accepts HTTPS DNS names that have a registrable
  domain. It refuses IP literals, `localhost`, public suffixes, userinfo and
  trailing dots, and anything where Foundation and WHATWG could disagree.
- IDN is converted only if the punycode decodes back to exactly what was
  typed (NFC, ASCII lower-cased). An `xn--` label is accepted only if the text
  it decodes to comes back out of that same strict path as exactly the same
  label, as UTS46 requires.
- `Origins.isWithinSite(origin, site:)` is
  `registrableDomain(originHost) == siteHost`, ignoring ports.
- `Resources/public_suffix_list.dat` is publicsuffix/list at `54ed390`
  (MPL-2.0), the list tldts 6.1.86 was built from. Move it only together with
  the Host's tldts.
- The shared fixtures `Tests/PasswordsCoreTests/Fixtures/origin-fixtures.json`
  and `site-fixtures.json` keep this in step with WHATWG and tldts; the Host
  side reads `site-fixtures.json` in
  [password-site-parity.test.ts](../../../../packages/browser-profile/src/password-site-parity.test.ts).
- tldts 6.1.86 departs from the PSL algorithm for 8 hosts that sit beside a
  wildcard (`ex.futurecms.at`, `sub.wc.psl.hrsn.dev`, …). This code follows
  the algorithm and refuses them; see `SiteTests`.

## Packaging

The suffix list is compiled into the code (`embedInCode`), so the broker and
the import worker look nothing up at run time and the hand-assembled app has
no resource bundle to lose.

## The broker

- **Socket and methods.** Protocol versions **4 and 5**; the first frame is
  `hello {client:{version},protocolVersion:4|5}`. The broker echoes the selected
  version and pins it for that connection. An unsupported version receives the
  latest version (5) and the connection closes. Requests and releases must use
  the negotiated version's shape; a v4 connection cannot send v5 variants.
  Peers are verified by audit token before a byte is read. Frames are at most
  256 KiB. Methods are `hello`, `status`, `window.open`, `signin.probe`,
  `signin.request`, `signin.approve`, `signin.release` and `signin.cancel`.
- **Status.** `{agentSignIns, vault}`. Before the first Mac unlock, status,
  request and approval return the unlock sentence as an `unavailable` error;
  probe answers `unavailable`. The vault is examined again on the next
  status, probe or request and on unlock. A vault missing the current owner
  key policy needs reset; its credentials are never migrated.
- **Probe.** `signin.probe {site}` reads without prompting, in this order:
  `unavailable`, `not-set-up`, `off`, then `has-login` or `no-login`.
- **Transactions.** Connection-owned, unique per (deployment, runtime,
  session, site) for v4 and (deployment, Workspace, site) for v5. Every
  transaction pins its permission version: 4 on protocol 4, 5 on protocol 5,
  including Only this time when there is no grant. Four may wait for approval
  and four may be under way, counted separately. More answer `unavailable: busy` and leave no trace.
  Cancel (idempotent), connection loss and expiry end authority. The deadline
  is capped at 60 minutes. A screen lock hides the window's logins but leaves
  authorized transactions live.
- **Authorization.** `signin.request` has requester fields plus `expiresAt`,
  `runtimeId`, `sessionId`, `site`, `transactionId` and `workspaceId` on v4.
  On v5, it has requester fields plus `protocolVersion:5`, `permissionVersion:5`,
  `expiresAt`, `site`, `transactionId` and `workspaceId`, with no runtime or
  session. Neither variant takes a page origin. It answers
  `{decision:"authorized",login}` for a grant covering the transaction's
  permission version and exactly deployment + Workspace + site, or
  `{decision:"approve",accounts}`. V5 requires new approval for a v4 grant;
  remembered approval writes version 5. V4 can use either supported grant
  version, but its transaction remains origin-only. Accounts retain their whole
  username for the person's choice; `onPage` is false because no page was supplied. The login descriptor is
  `{id,revision,account,hasTOTP}` with a masked account, never a credential.
  `signin.approve {transactionId,loginId,revision,remember}` authenticates the
  person and pins that login and revision for both Allow and Only this time.
  Allow writes its grant with the transaction's permission version in the same
  vault unlock. V5 authentication says the account may be used “on websites
  and in apps your agents use” and warns that a tricked agent could expose the
  password. V4 keeps its original consent. Changed/deleted choices
  return the current accounts with a message. No field value is released.
- **Field release.** V4 `signin.release {transactionId,field,origin}` takes
  `username`, `password` or `totp` and an exact HTTPS origin. V5 requires
  `{transactionId,field,kind:"browser",origin}` or
  `{transactionId,field,kind:"app"}`. App requests have no origin; omitting an
  origin never implies app scope. App release requires transaction permission
  version 5 and, when remembered, a current version-5 grant. Browser release
  checks its exact HTTPS origin on both protocol versions. It returns
  `{released:true,value}` or `{released:false,reason}`. Reasons are `ended`,
  `revoked`, `wrong-site`, `no-totp` and `passwords-off`. Each release checks
  live transaction authority and deadline, current login ID and revision,
  the current remembered grant (same key, login and revision), agent sign-ins
  on, the browser origin's registrable site when applicable, and that the
  login has a saved website on the transaction's site. A v4 grant never
  authorizes app release. The broker releases plaintext only to desktop main;
  sealing for the receiver belongs to that authority, not to this broker.
  Checks run in queue order with vault writes and again after waits. TOTP
  returns a current code; the seed stays in the broker. Values never enter
  logs or errors.
- **Activity.** The first password release records `used` once per
  transaction. Authorization and username/TOTP release claim no sign-in
  success. Cancelling an already-used transaction adds no second entry.
  Historical activity outcomes remain readable.
- **Grants.** Permission versions 4 and 5 pin the login revision. Both remain
  readable, appear in the allowed list and survive later vault commits. Scope
  is checked at lookup and every remembered release. A version-5 approval
  replaces the same key's version-4 grant; it does not delete other v4 grants.
  Earlier, unversioned grants
  remain readable in old manifests, are absent from authorization and the
  window's allowed list, and are deleted on the next vault commit. Removal,
  edits and the off switch are checked at every later release. Removal only
  removes the exact grant shown, so it cannot remove a newer approval.
- **Queued work.** Transaction authority guards approval commits and field
  release on the serial vault queue. Cancelled, lost and expired work cannot
  write a grant or release a value after resuming. An authentication still
  showing is withdrawn and a late result discarded.
- **Authentication.** `PresenceChecker.authenticate(reason:)`
  (`.deviceOwnerAuthentication`: Touch ID or the Mac password, no reuse of an
  earlier unlock) is asked for setup, Start Fresh, each Allow or Only this
  time, opening the window's saved logins, and every
  change of a login's websites, login page or username. Only a presence
  checker makes an `Authentication`, and the vault calls made for the person
  take one. Ending the action cancels its task, which withdraws a prompt
  still showing; a late result is discarded.
- **The window's visit.** One authentication opens the saved logins until
  the window closes, the screen locks, the Mac sleeps or five minutes pass
  without a window action. Within it, add, a password, two-factor or label
  edit, delete and import ask nothing more. The broker refuses every list
  and change outside a live visit, whatever the window shows.
- **What the person sees.** The accounts offered and the prompts carry the
  whole username; the activity history masks it. Names from the Host are
  cleaned of control and format characters.
- **Import.** The export's open file is the worker's standard input; the
  worker is killed after 20 seconds or 64 MiB of output, and its answer is
  read as canonical JSON with closed key sets (`ImportWire`). The visit
  covers the preview and the import's single commit. The broker owns each
  import by an `ImportID`: closing the window, Cancel, the end of the visit
  and quitting end it, dropping the unlocked vault, and a file read that
  finishes after that prepares nothing.

## Testing

Use the [cheapest relevant checks](../../../../docs/testing.md#how-to-test),
not a journey per broker edge case. `PasswordsCoreTests` cover vault/crypto rules;
`PasswordsBrokerTests` use real brokers on temporary sockets with a Swift JSON
client. `PasswordsAnywhereTests` covers consent and cross-version authority.
They are pure logic with software keys and scripted authentication, so they run
on the host with the command above (`--filter` picks a class while you work).
Two classes stay off the host: `SnapshotTests` builds real AppKit windows, and
`SecureEnclaveTests` needs real Secure Enclave keys, which a VM can't provide
either. Neither is in an automatic lane, and a skip never counts as a pass.

`WireFixtureTests` compares the broker's types with
`Tests/Fixtures/passwords-wire.json`, which the TypeScript broker-wire test reads.
Regenerate it only for an intentional contract change with
`OPENSTEER_WRITE_WIRE_FIXTURE=1`.

The existing tests emit socket frames under
`$TMPDIR/opensteer-passwords-broker-swift-e2e.json`
(`OPENSTEER_PASSWORDS_BROKER_ARTIFACT`) and window PNGs under
`$TMPDIR/opensteer-passwords-ui/` (`OPENSTEER_PASSWORDS_UI_ARTIFACTS`). Retain these
only for manual acceptance or release checks.
Reuse the [saved-login surface journey](../../../../docs/passwords.md#verification)
for end-to-end acceptance.

The release keychain store requires a signed release build with its entitlement;
without it, Security returns `errSecMissingEntitlement`.
