# go-ios source subset

Source: https://github.com/danielpaulus/go-ios
Upstream revision: e5833ad1c5b64833ba8cb267eadc50e265bf164e
Resolved version: v0.0.0-20261116112947-e5833ad1c5b6
License: MIT; the upstream LICENSE is retained beside this file.

Only the linked ios, golog, http, xpc, coredevice, display, imagemounter and
userspace-tunnel, RemotePairing, OPACK, SRP and TLS-PSK packages are carried. Upstream tests, CLI, kernel/QUIC tunnels,
HTTP tunnel agent, network discovery, image downloads, supervised pairing and
supervision-certificate helpers are excluded. Tests here are newly authored
synthetic fixtures and never discover devices.

Opensteer patches:

- `ios.PairingAttempt` retains one private certificate set and HostID across pending
  Trust responses, following upstream `ios/pair.go`'s same Pair request and save flow.
  A changed device public key, BUID or Wi-Fi identity refuses reuse. The bridge drops
  the attempt after acceptance or binding release; nothing is added to the wire.
- Image identity lookup reports a typed incompatibility when no hardware identity
  matches. A composite rejection permits trying another installed image only when
  every mounter refused compatibility; network or uncertain mount failures stop.
- The bridge's independent Instruments foreground reader follows MIT upstream
  `ios/instruments/helper.go`, `instruments_deviceinfo.go` and DTX channel negotiation
  over `com.apple.instruments.dtservicehub`. It requires an explicit
  `foregroundRunning=true` and an exact executable-to-installed-app mapping;
  missing or ambiguous flags never imply foreground. CoreDevice `appservice.ListProcesses`
  only exposes PIDs and paths, so it cannot establish foreground by itself. The pinned
  upstream maps no foreground field; current iOS flag availability remains unqualified.
  No additional upstream packages or GPL source/tests are copied.
- Context-owned usbmux/lockdown connections, typed pairing/session errors, fixed
  system usbmux socket, and explicit transfer of a service connection from setup
  to session lifetime. In-process service dialers return net.Conn; no localhost
  forwarder or kernel-tunnel fallback is retained.
- A userspace TCP+UDP stack built with gVisor's public channel endpoint, restricted
  to the negotiated IPv6 peer. Strict CDTunnel header/address/MTU/port validation;
  stream packet framing retained from upstream; cancellation/EOF/corruption/write
  failure closes both packet pumps and the stack.
- The upstream rwcendpoint.go is deliberately excluded: its header acknowledges
  copying GPL tun2socks code. The channel-based packet pump in userspace.go is
  independently implemented against gVisor's Apache-2.0 public API.
- Supplied-connection RSD constructor, expected-identity validation before host
  announcement, validated service maps/ports and propagated announcement errors.
- Bounded HTTP/2 frame and stream input. Existing bounded XPC decoder retained.
- A supplied-channel display constructor and typed CoreDevice errors. Stop uses
  this client's UUID and upstream's required `stopAll=true`; EOF, closed-channel
  and connection-reset responses after sending stop count as success. Explicit
  rejection, malformed replies, send failure and cancellation remain errors.
  The bridge does not start media streams for input.
- Context-bound Apple TSS client without proxies or redirects and with a bounded
  response; safe personalization error types. No image-download implementation
  or convenience mount that unmounts another client's image is carried.
- Go 1.26.0 module directive, using the installed go1.26.2 toolchain rather than
  automatically downloading the upstream go1.26.5 toolchain.

- Supplied-connection RemotePairing setup/verify, TCP listener and TLS-PSK feed
  the same userspace stack. Peer Ed25519 proofs, physical identity, pairing states,
  listener ports, TLS version and handshake sizes are validated. No automatic
  re-pairing, kernel tunnel or exported network listener is retained.
- RemotePairing JSON framing and IRK auth-tag matching follow the MIT idevice
  implementation at revision 2dca9a58a9a1dd02ec7d6213fcfd8fe861e74132.
  Its notice is retained in LICENSE.idevice and THIRD_PARTY_NOTICES.md.

No pymobiledevice3 or other GPL source/tests were copied. Apple developer images
are not distributed by this module. Dependencies resolve through go.mod/go.sum without vendoring.
THIRD_PARTY_NOTICES.md lists every module linked into the bridge.

- N2 carries the upstream DTX encoder, message and primitive dictionary subset.
  A supplied-net.Conn raw constructor bounds frame/fragment/message/aggregate
  sizes and rejects compressed packets (compression is negotiated off). The AX
  archive subset resolves unknown classes as inert dictionaries, limits object
  counts/depth/UID cycles, and encodes only primitives, arrays and dictionaries.
  There are no Objective-C factories, audit fallback or device fixtures.
- PlistCodec.DecodeLimit lets installation-proxy consumers cap a chunk before
  allocating its body. Native screen endpoints remain in internal/phone.

Hardware-path corrections:

- Carry only `ios/amfi`'s connection and `RevealDevMode` (action 0) from the
  pinned MIT upstream. Enable/reboot operations are excluded. Unlike upstream,
  reveal requires a boolean `success=true`, not merely a present success key.
- Use upstream `NewImageMounter` and its existing iOS 17+ composite to try
  cryptex first and personalized mounting second. A direct RemotePairing tunnel
  with no usbmux device uses cryptex without a lockdown version lookup; the
  personalized fallback requires a lockdown route. Never unmount another image.
  Cryptex comparison uses the installed DDI's `CFBundleVersion` from
  `cryptex_info`, not manifest `Cryptex1,Version`. A numerically newer build in
  the same major/minor release train is accepted; older or other trains are
  left alone and reported in use. The bridge also accepts already working
  developer services without replacing their image.
- The input media gate is removed. Upstream [#887](https://github.com/danielpaulus/go-ios/pull/887),
  merged as `63c0d5705a010b03c340de888ba6c7c4052d763b`, explicitly reports Indigo
  contacts working without a display stream on an iPhone Duo running iOS 27.1,
  on both displays and in each orientation. The older `hid.Session` raw-report
  prerequisite does not apply to `hid.DigitizerSession`. Its wire tests keep
  each contact's display fixed. Upstream `display/receiver.go`'s userspace-stream
  refusal therefore does not block Indigo input. UDP support is retained in
  the general userspace tunnel, but input has no RTP receiver or stream dependency.
- Native bridge behavior follows pinned upstream `ios/hid/controls.go`'s
  250 ms close grace after the last attempted event, including abort releases;
  `ios/screencapture`'s `displayUniqueID`; `ios/hid/digitizer.go`'s numeric
  `displayId` target and native normalized axes; and `ios/accessibility`'s
  `com.apple.accessibility.axAuditDaemon.remoteserver` service name.
- Lock state uses lockdown `GetValue("PasswordProtected")`: paired usbmux
  lockdown over USB, and `ConnectToShimService` with RSD check-in on
  `com.apple.mobile.lockdown.remote.trusted` over Wi-Fi. The MIT upstream
  `ios/mcinstall/mcinstall.go` documents this as current passcode demand.
  The Mac-side CoreDevice lock-state action is never sent to deviceinfo.
  `unlockedSinceBoot` is dropped: it has no established device-side source and
  is unnecessary for the current-lock gate; unreadable values remain unknown.
- Vendored `GetValue` and `GetValueForDomain` propagate send, read, plist and
  device errors, so an error response cannot masquerade as a readable value.
  Shim connections are bound to their request context before RSD check-in and
  closed if check-in fails; this also bounds cancellation during negotiation.
- Display selection accepts nonzero integrated, non-external displays, preferring
  active over primary. A primary display may omit `uniqueId`: screenshot capture
  then defaults to the main display, while Indigo uses that primary's numeric
  `displayId`. Non-primary capture still requires `uniqueId`. Integral XPC
  float64 dimensions/IDs share the checked integer decoder; `activeOn` means on,
  and `inactiveOn` means off. Frame changes also invalidate screenshot geometry.

Synthetic qualification covers the raw redacted iPhone18,2 seven-display XPC
response (iOS 27.0.1, build 24A446), with float64 sizes/bounds/scales and uint64
display IDs. The iPhone19,4 two-display fixture was transformed by devicectl;
its raw shape remains unverified. Tests also cover lockdown values/errors,
shim check-in cancellation/cleanup, primary capture/HID addressing, all rotations,
selection and state changes, release grace, refresh, automatic remount, AMFI reveal,
media-stop transport failures, logging scrubbing and shutdown with open stdin.
Hardware qualification remains necessary for iOS 27.2+ Indigo touch/button delivery
without video, cancellation releases and grace on USB/Wi-Fi, fold/rotation transitions,
AMFI Settings visibility, cryptex-to-personalized fallback and post-reboot recovery,
compatibility of newer DDI builds, and AX service availability/coordinate accuracy.
No hardware was accessed while applying these corrections.
