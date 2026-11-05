# Opensteer Passwords

Saved logins let agents fill websites or type into permitted Mac and Android apps; saved cards
work only in websites. The Personal Mac
owns the vault; the requester can approve a sign-in from any signed-in device. Cookie reuse is
[Chrome sign-ins](browser-sessions.md#chrome-sign-ins); passkeys use the [OS passkey
manager](browser-sessions.md#passkeys). Checks live in the [browser-and-passwords
skill](../.agents/skills/browser-and-passwords/SKILL.md).

## Promise and limits

Authorization and input results carry metadata and status, never saved values. The TOTP seed stays
in the broker, which releases only a current code. Agents must never read back, copy or reveal a
saved field, and a successful input proves neither a website sign-in nor the intended account: the
agent confirms both. After a browser fill, page scripts and agent JavaScript can read the value;
there is no CDP read filter. App delivery does not verify the app's association with the site, so
the agent judges the package, publisher and install source. A tricked agent can expose the password.
Secure-field observations suppress text, but screenshots and ordinary fields show what an app
displays. Revoking or turning off cannot recall input, sign anything out or undo actions.

## Authority

The broker owns keys, grants and release; desktop main owns browser checks and sealing; the Host
owns Workspace admission and memory-only leases and stores neither vault data nor released values.
Only Personal's local Host can name a Workspace to the vault.

Agents use `sign_in` for logins and `use_card` for checkout. Probes never prompt. For login
requests given a Browser Session, the Host checks
access to it first; a Chrome grant for the session's Workspace wins, otherwise a saved login selects
Passwords, and Chrome can fill in when Passwords has none. Every path refuses loopback and the
Deployment's own sites before creating a Request. A login reference never grants access to a
browser, phone or Mac app: each use still needs the Run's current authority over that surface.

`sign_in` and `use_card` report what Passwords still needs instead of a separate tool suggesting it, so the
suggestion can't depend on a model remembering to call anything. Clients show it from that result
at the end of the conversation until the person next speaks; absent, Passwords can't help here
(a server Deployment or an unsupported Mac) and nothing offers it.

## Grants and consent

A remembered grant in the signed vault maps Deployment, Workspace and site to a login revision. The
calling Workspace owns the consent, even when it drives a Browser Session that belongs to another
Workspace. Allow remembers access; Only this time creates no grant. Both pin the login ID, revision
and consent version on the broker transaction, and the mobile app asks for device-owner
authentication before either. The person sees the full username; the agent gets it masked.

Current consent covers "websites and apps your agents use" and warns that a tricked agent could
expose the password. Older origin-only grants stay valid for legacy browser transactions but never
authorize app release; unversioned grants authorize nothing and disappear on the next vault commit.
Each release rechecks the pinned revision and, for remembered access, the current grant. Editing a
login needs approval again; changing its websites, login page or username, or deleting it, removes
its grants. Removals send no push, so `sign_in` can return `ready` until a release notices.

## The login lease

A memory-only opaque reference binds the calling Workspace and site to a live broker operation with
the pinned login. Any Run in that Workspace, including delegated work, can reuse it with its own
surface authority; other Workspaces cannot. One absolute deadline covers approval and lease, with no
extension on reuse. Closing the browser does not end it; restart, cancellation, expiry, turning off,
a lost connection or a changed login or grant does. Joining pending work never makes a Run the
approver.

## Saved cards

A card is not site-bound. Each use needs fresh person approval binding the top-level merchant site,
with one 30-minute deadline for approval and filling. No remembered grant applies to cards. Payment
fields may belong to a cross-origin provider frame embedded by that merchant; the approved
merchant stays the top-level authority. Approval permits filling, not a particular charge.

Cards work only in browser pages on a Personal Mac's Electron runtime. The native Passwords window
owns adding, editing and deleting cards, and stores the CVC too. Import remains passwords only.
After filling, the page, its provider and agent JavaScript can technically read the value. Agents
are told never to read back, print, log, copy or save card values, including to files or memory.
This is a behavioral boundary, not technical secrecy after filling.

## Filling a field

Browser fills bind the real focused field before release and never retry an unknown outcome. Open
shadow roots work; contenteditable editors and closed roots do not. For logins, an out-of-process focused frame
must itself have a committed HTTPS origin on the approved site. Cards may fill an embedded payment
provider frame with a committed HTTPS origin while the top-level site remains approved. Desktop main binds the exact
document and input before release, rechecks authority, focus and origin before dispatch, and the
main-world setter rechecks identity. The Host checks lease and session access on every fill.

## Typing in apps

The Host resolves saved references for the calling Workspace and seals every field before any action
in a batch runs; agents cannot supply sealed envelopes. Android sets text without readback. Mac
writes the selected text or, for a secure field, its value, else types Unicode keystrokes, and
refuses CR, LF and tab before that action. Receipts name only the field kind, never value, label or
length. Secure fields omit values and labels from accessibility reads, which does not mask
screenshots or an app that shows a password as ordinary text.

## Sealed delivery

Each authenticated receiver connection makes an ephemeral P-256 key; reconnecting discards it and
its replay state. Desktop main serializes an operation's releases and seals app fields right after
broker release. The envelope binds connection, Run, session, act, action index, field and expiry,
capped at the earliest of the lease deadline, the act deadline and 60 seconds. Receivers check
expiry and work budget on their own clock, authenticate the whole batch before input, claim replay
identities atomically and decrypt again just before typing. A lost act answer is never retried. The
Host, Runners, a receiving Mac's main process and tunnels carry only ciphertext. The [wire
schemas](../packages/protocol/src/password-sign-in.ts) own the bindings and the
[sealer](../apps/desktop/src/passwords/login-envelope.ts) owns the cryptography.

## Requests and results

The requester approves or declines through one Host command from any client. Chooser details are
fetched separately and never enter shared Request events, agent projections or client caches; names
and reasons are display context, never authority. Durable Request settlement is the commit point:
the broker first prepares the pinned choice without granting or releasing anything, and the Host
commits it and publishes a lease only after settlement succeeds. If the commit fails or authority
ends first, the Request becomes interrupted. A lost commit response can leave only the exact pinned
grant, never a live lease, and cancelling a preparation cannot erase a newer grant. A continuation
gets its login reference only from the live registry, never from Request data.

## Runtime and compatibility

Each hop negotiates the sign-in features; an unknown version or a missing hop or receiver key
disables the feature. The broker negotiates its protocol per connection, echoes it and never
silently upgrades. App release needs an explicit app kind, never inferred from a missing origin, and
never falls back to the legacy session-bound protocol; browser release needs an exact HTTPS origin
on the saved site. Historical Request and result shapes stay readable and never create a live lease. Cards reuse the
existing sign-in Request kind with a credential discriminator; older clients can only decline a
card Request, because their login decision cannot authorize it.
Versions live in the [broker wire](../packages/protocol/src/passwords-broker.ts).

## The broker

The [broker](../apps/desktop/native/passwords/README.md) is the only vault and key owner for a macOS
user. It accepts only the signed Opensteer desktop under the Developer ID team taken from its own
signature, checked by audit token before reading any byte; desktop verifies the broker's signature
and live peer too. Development uses a separate bundle, socket and vault, and its file protection
cannot resist same-user rollback, so it must never ship.

Setup, Start Fresh, opening saved logins and changing a login's websites, login page or username
each need fresh device-owner authentication (Touch ID or the Mac password), never an earlier unlock.
Sign-in consent never prompts on the vault Mac. An authenticated window visit covers adding,
editing, deleting and importing, and ends on close, lock, sleep or idle; every change checks the
live visit. Prompts use the broker's own wording, never agent text. Unreadable settings fail off.
Transactions belong to their connection, and queued work rechecks after every wait.

Keep vault work on one actor and close each unlocked vault right after selection or commit. Swift
password strings cannot be wiped, so keep their lifetime short. No field value belongs in logs,
errors or activity, which masks usernames and omits agent reasons.

## The vault

One vault belongs to the macOS user. Device-only Secure Enclave owner keys wrap item keys; they need
no user presence, so remembered sign-ins work while the Mac is locked, and the broker enforces
presence for vault management itself. Restarts and updates keep the keys; losing, replacing or
erasing the Mac does not, and there is no backup, sync or migration. Before the first unlock after a
restart the broker reports unavailable, never damaged. Start Fresh deletes the vault and grants for
good.

Signed commits and a protected checkpoint refuse rollback. Every open, unlock and commit verifies
history against the checkpoint under a kernel lock; missing, forked or rolled-back history fails
closed with no automatic repair. Writes publish objects, commit, checkpoint, then HEAD, and nothing
releases from a head the checkpoint does not protect. A checkpoint write that reports an error may
still have landed, so read it back; opens require regular files so a planted FIFO cannot stall them.

Canonical bytes matter: reject duplicate keys, noncanonical JSON and ambiguous encodings rather than
normalize on read. Credential bytes are never trimmed or Unicode-normalized. Unknown item versions
are skipped with their bytes preserved; newer manifest, commit or checkpoint versions need an
Opensteer update, never Start Fresh. Reads apply only structure and size limits, so a rule change
never makes a saved login unreadable; writes apply the current site rules.

Sites are HTTPS DNS origins on registrable domains. The compiled suffix list and the Host's tldts
must move together, fenced by [shared parity
fixtures](../packages/browser-profile/src/password-site-parity.test.ts); Swift deliberately refuses
hosts where PSL wildcard rules and tldts differ. Imports parse in a sandboxed worker, revalidated
before one atomic commit; never guess a TOTP secret as hex or merge conflicting accounts.
