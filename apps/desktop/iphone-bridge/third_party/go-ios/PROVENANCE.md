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
- A supplied-channel display constructor, typed CoreDevice errors, and media stop
  using this client's UUID with stopAll=false. Rejection/channel loss is an error;
  there is no global-stop fallback. Apple's scoped-stop behavior is unqualified.
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
are not distributed by this module. Dependencies resolve from go.sum without vendoring. THIRD_PARTY_NOTICES.md lists
every module linked into the bridge.
