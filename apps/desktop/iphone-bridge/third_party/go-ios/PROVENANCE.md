# go-ios source subset

Source: https://github.com/danielpaulus/go-ios
Upstream revision: e5833ad1c5b64833ba8cb267eadc50e265bf164e
Resolved version: v0.0.0-20261116112947-e5833ad1c5b6
License: MIT; the upstream LICENSE is retained beside this file.

Only the linked ios, golog, http, xpc, coredevice, display, imagemounter and
userspace-tunnel packages are carried. Upstream tests, CLI, kernel/QUIC tunnels,
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
