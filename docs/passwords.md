# Opensteer Passwords

Saved logins let agents fill websites or type into permitted Mac and Android apps, and let the
person fill Opensteer browser pages themselves ([Filling for people](#filling-for-people)) and keep
a login they typed there ([Saving for people](#saving-for-people)); saved cards work only in
websites. Website fills work only in the personal hosting computer's browser, never
a browser on another computer or phone; the Host refuses an agent's fill there with
`main-browser-required`. The Personal Mac
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

A person's request to sign in covers that sign-in's SMS/email code: the agent retrieves the fresh
code through an already granted integration and enters it into the genuine website or app without
asking again, unless the person said not to. A second prompt only repeated a decision they had
already made. Matching the site is the guard, because a tricked agent can relay a code to a
look-alike site. The code enters the agent transcript; it must not be repeated in replies or
retained. This does not authorize approving an Opensteer Request or granting access.

## Authority

The broker owns keys, grants and release; desktop main owns browser checks and sealing; the Host
owns personal admission and memory-only leases and stores neither vault data nor released values.
Only the local personal Host can present the per-person consent key to the vault; team IDs and
folders never become consent identities.

Agents use `use_saved_login` for logins and `use_card` for checkout; Chrome cookie copying is a
separate tool, `copy_chrome_cookies`. The agent chooses between them: the Host never falls from one
to the other, because only the agent can see whether a site accepted copied cookies, and banks often
refuse them. Probes never prompt. Every path refuses loopback and the Deployment's own sites before
creating a Request. A login reference never grants access to a
browser, phone or Mac app: each use still needs the Run's current authority over that surface.

`use_saved_login` and `use_card` report what Passwords still needs instead of a separate tool suggesting it, so the
suggestion can't depend on a model remembering to call anything. Clients show it from that result
at the end of the conversation until the person next speaks; absent, Passwords can't help here
(a team server or an unsupported Mac) and nothing offers it.

Setup happens in a window agents cannot observe. The Host tracks an outstanding offer and wakes
its Thread when a login becomes available; the person must not have to report completion. A
decline or stopped Thread ends the offer, and offers never override Requests or a finished task.
Cards have no such wake. [The offer service](../apps/host/src/browser/passwords-offers.ts) owns
this lifecycle.

## Grants and consent

A remembered grant in the signed vault maps Deployment, person and site to a login revision.
The per-person consent key remains stable across tasks and Browser Sessions. Allow remembers access; Only this time creates no grant. Both pin the login ID, revision
and consent version on the broker transaction, and the mobile app asks for device-owner
authentication before either. The person sees the full username; the agent gets it masked.

Current consent covers "websites and apps your agents use" and warns that a tricked agent could
expose the password. Only current per-person consent authorizes release; old scope keys or protocol versions
never become new consent.
Each release rechecks the pinned revision and, for remembered access, the current grant. Editing a
login needs approval again; changing its websites, login page or username, or deleting it, removes
its grants. Removals send no push, so `use_saved_login` can return `ready` until a release notices.

## The login lease

A memory-only opaque reference binds the person and site to a live broker operation with
the pinned login. The person's Runs may reuse it only with their own current surface authority. One absolute deadline covers approval and lease, with no
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

## Filling for people

A person fills their own saved login into an Opensteer browser page from any viewer, through one
path: the runtime binds the field the person activated, offers that site's logins to that viewer
only, accepts the choice only from that viewer, and desktop main releases each value from the broker
into the bound elements. The saved value travels only broker → desktop main → page on the vault
Mac; the Host, Runners and viewers carry IDs, usernames and status. After insertion the page and
any agent JavaScript in it can read the value, exactly as if the person had typed it. Agents have no
tool for this; they keep `use_saved_login`.

Only the viewer that activated the field receives and accepts its offer. A changed document,
origin or bound element ends the fill; an agent command withdraws it. Native input on the vault
Mac requires fresh OS presence there, and a missing native view refuses rather than downgrades.
Other viewers use their own consent path, with device-owner authentication on mobile.

A person fill creates no agent grant or reference. Its short-lived reuse is bound to that viewer,
tab, site, login revision and presence. Activity records credential release, not successful sign-in.

## Saving for people

When a person signs in by hand on a page in the personal hosting computer's browser, the viewer they
typed from offers to keep that login. Saving follows fill's locality: a page on any other browser
is never read, so a saved login is always one Opensteer can fill. Version 1 adds new logins only;
a changed password, a different username for a saved one, and a form with two different
passwords are not offered.

Saving requires attributable person input, never an agent or script write. An agent listener may
still alter a value the person typed, so Save can add a wrong login; it must never edit an existing
one or grant agent access. Submit binds the site's document origin before navigation, and the
broker owns the captured values from then. Only the originating viewer can answer the offer.

A successful-looking navigation decides when to offer, never authority. Agent activity before the
offer appears or the viewer leaving ends it. The broker commits a new login
only if no matching username exists, discarding its temporary values on expiry or cancellation.
Sign-ins from a phone may save while the vault Mac is locked, as remembered sign-ins do.

## Typing in apps

The Host resolves saved references for the calling person and seals every field before any action
in a batch runs; agents cannot supply sealed envelopes. Android sets text without readback. Mac
writes the selected text or, for a secure field, its value, else types Unicode keystrokes, and
refuses CR, LF and tab before that action. Receipts name only the field kind, never value, label or
length. Secure fields omit values and labels from accessibility reads, which does not mask
screenshots or an app that shows a password as ordinary text.

## Sealed delivery

App delivery seals fields to one authenticated receiver connection and exact operation. Reconnect
retires its key and replay state. Authenticate the complete batch before effects and recheck
expiry and identity at release; lost answers never authorize resending. The Host, Runners and
tunnels carry ciphertext. [The wire](../packages/protocol/src/password-sign-in.ts) owns bindings;
[the sealer](../apps/desktop/src/passwords/login-envelope.ts) owns cryptography.

## Requests and results

The requester decides through Host commands from any client. Chooser details stay outside shared
Request events, agent projections and caches. Broker preparation grants and releases nothing:
only durable Host settlement can publish a live lease. A lost commit response may leave the pinned
grant, never a live lease; cancellation must not erase a newer grant. Continuations get references
from the live registry, never historical Request data.

## Runtime and compatibility

Each hop negotiates the sign-in features; an unknown version or a missing hop or receiver key
disables the feature. Only broker protocol 10 is accepted; each connection echoes that exact version and refuses
older protocols without downgrade. App release needs an explicit app kind, never inferred from a missing origin, and
never falls back to the legacy session-bound protocol; browser release needs an exact HTTPS origin
on the saved site. Historical Request and result shapes stay readable and never create a live lease. Cards reuse the
existing sign-in Request kind with a credential discriminator; older clients can only decline a
card Request, because their login decision cannot authorize it.
Versions live in the [broker wire](../packages/protocol/src/passwords-broker.ts).

## The broker

The [broker](../apps/desktop/native/passwords/README.md) alone owns vault keys. Both it and desktop
verify the signed live peer with audit tokens before exchanging data. Development has a separate
identity and vault, whose weaker rollback protection must never ship.

Setup, Start Fresh, opening saved logins, changing a login's websites, login page or username, and a
person's own fill from the Mac's page each need fresh device-owner authentication (Touch ID or the
Mac password), never an earlier unlock. Agent sign-in consent never prompts on the vault Mac. An authenticated window visit covers adding,
editing, deleting and importing, and ends on close, lock, sleep or idle; every change checks the
live visit. The one write without a visit is a person's save: adding exactly the login the broker
holds for them, never a change, deletion or grant ([Saving for people](#saving-for-people)). Prompts use the broker's own wording, never agent text. Unreadable settings fail off.
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
closed with no automatic repair. Nothing releases from a head its protected checkpoint does not
cover. A checkpoint write that reports an error may still have landed, so read it back; opens require regular files so a planted FIFO cannot stall them.

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
