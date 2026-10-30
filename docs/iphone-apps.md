# iPhone apps

Opensteer on an iPhone can serve Calendar, Contacts, Reminders, current Location and Photos metadata to agents while the app is open. It is a local Runner with only the integrations module. It does not expose the phone screen, files, other apps, Messages or a local MCP server. Calendar and Reminders support their shared Mac operation contracts; Contacts is read only. The Host decides each app's agent access, and iOS independently decides whether Opensteer may use the underlying store.

## Enrollment and secrets

The owner starts **Add this iPhone** in the mobile app. JS uses the owner session to mint a single iPhone enrollment and approve app access. The native module creates two independent Ed25519 keys and a durable prepared record before the first mint request. It holds the enrollment token only in the device Keychain. The JS bridge receives the Runner ID and a stable mint idempotency key, but never a private key, token after `enroll`, stream ticket or signature. Native connects directly to the Host target from the pairing result. Discovery must name the same Deployment and Host instance before it sends the token or a proof. Redirects are refused.

## Admission and backgrounding

The native executor is created by an Expo app delegate subscriber, before JS loads. Returning from the background replaces its transport generation; returning from a permission prompt preserves the connection. Both reread OS permission state. Only a live stream with an unexpired continuous clock lease admits work. A write crosses a second synchronous fence immediately before the EventKit save. Backgrounding closes admission and drains admitted work. Heartbeats can renew an unexpired lease during that drain, but new invokes receive a background refusal and no new write can start. Expiry closes both sockets. A lost write answer is unknown to the Host and is never replayed on reconnect. `disconnect()` fences admission synchronously before network cleanup.

## Local identity

The identity marker is `Application Support/iphone-apps/enrollment.json`, excluded from backup and protected until first user authentication. The Runner key, approval key and pending enrollment token use Keychain service `com.opensteer.mobile.iphone-apps`, `WhenUnlockedThisDeviceOnly`, with synchronization disabled. An absent or malformed marker wipes those items; a present marker with a missing key is wiped. A temporarily unavailable protected Keychain read defers this judgment until unlock. Removing the phone clears the marker first so an unavailable Keychain deletion cannot restore sharing on restart.

## OS consent

Permission prompts happen only after a person taps the mobile UI action. Invocations never prompt. The answer is read back before anything is requested or signed, and a refusal stops new access there ([mobile lifecycle](mobile.md#this-iphones-apps)). Calendar requires full event access, Reminders full reminder access, and Contacts either full or limited access. Limited Contacts exposes only the OS-selected contacts; iOS 18's system picker can expand that selection. The generated Info.plist strings live in `apps/mobile/app.config.ts`.

## Read-only providers

Location is a foreground-only, read-only coordinate fix, labelled precise or approximate. It requests only When In Use permission on a person’s tap; Allow Once has the same native state and may expire later. A tool call never requests authorization. A positive maximum age can use a cached fix; zero requires a new fix. Acquisition stops after the last pending read, cancellation, backgrounding or its deadline.

Photos offers read-only asset and regular-album metadata. It returns no image bytes, filenames, EXIF or coordinates and never requests an iCloud download. PhotoKit’s permission API uses the broader read/write label, but Opensteer’s provider has no write operations. Limited access returns only selected assets, including a successful empty selection. The limited-library picker is person-initiated; the automatic selection alert is disabled. Paging binds cursors to the query and order but does not promise a library snapshot.

A new device approval requires an authenticated iPhone status that reports its definition. Offline, connecting and older app versions receive distinct refusals before any request is saved. Lowering and revocation keep working offline. Before starting new setup, the mobile controller also requires the installed build to report the app's permission and the Host's catalog to list its definition ([mobile lifecycle](mobile.md#this-iphones-apps)).

## Native packaging

`packages/apple-data` contains the single Swift implementation of the Calendar, Reminders and Contacts data providers used by both the Mac helper and iPhone pod. Expo's data-only Swift package needs the local Podfile config plugin because it has no JS Module class for autolinking. `apps/mobile/modules/iphone-apps` depends on that pod and keeps its platform adapters separate from the SwiftPM core.

See `apps/mobile/modules/iphone-apps/ios` and its adjacent tests for the native
contract. Use [test-iphone-apps](../.agents/skills/test-iphone-apps/SKILL.md) for
verification. Fake OS ports and simulator pregrants cannot prove real consent dialogs.
