---
name: iphone-screen
description: Use when building or testing the desktop iPhone bridge (`apps/desktop/iphone-bridge`) or the Mac Runner's iPhone screen driver, changing its patched go-ios copy, or qualifying a Mac-driven iPhone on real hardware over USB and the same Wi‑Fi.
---

# iPhone screen

Procedures for a Mac driving an iPhone's screen.

## Safety rules

- Phones have one owner: never take another task's iPhone, Mac or VM slot.
- Stop every desktop, Host and bridge you start by captured PID, even after a failure; never kill
  by name.
- Never drive the host screen: GUI and Electron checks run only in the VM (`pnpm test:vm`).
- Never read or operate signing keys, Apple accounts or release credentials.
- Never touch the live install. Phone reservations live in each build's own data directory
  ([bridge-paths.ts](../../../apps/desktop/src/iphone/bridge-paths.ts)), so a source build stays
  out of an installed app's folder; don't point `OPENSTEER_DESKTOP_DATA_DIR` at it.
- Never type or record a passcode; the person unlocks the phone.
- Keep UDIDs, pair records, phone content and typed text out of logs, fixtures and evidence.
- Skipped, blocked or unrun checks are unverified, never passed. A build or a passing synthetic
  suite proves nothing about a phone.

## Build and test

Every test here is synthetic and never discovers a phone. The bridge writes scrubbed
diagnostics to stderr, which desktop keeps in `logs/iphone-bridge.log` in its data directory;
read it first when a phone step fails.

```sh
go -C apps/desktop/iphone-bridge test ./...
go -C apps/desktop/iphone-bridge/third_party/go-ios test ./...
pnpm --filter @opensteer/runner build:native-fs:test
pnpm exec vitest run apps/desktop/iphone-bridge/ipc.test.ts apps/desktop/src/iphone apps/runner/src/computer-apps/iphone-screen-driver.test.ts
```

A development desktop runs the unsigned bridge from `apps/desktop/generated-native`
(`darwin-amd64` on Intel):

```sh
pnpm --filter @opensteer/desktop build:iphone-bridge
```

A packaged desktop refuses a bridge without its `release.json` digest and Developer ID signature.

## The go-ios copy

`third_party/go-ios` is a patched subset of MIT go-ios, wired in by a `replace` in `go.mod`.
Record every change and its reason in
[PROVENANCE.md](../../../apps/desktop/iphone-bridge/third_party/go-ios/PROVENANCE.md) and keep the
upstream licences beside it. Never copy pymobiledevice3 or any other GPL source or tests, even
upstream go-ios files that copied GPL code. A new direct `require` in the bridge's `go.mod` needs
its notice in `THIRD_PARTY_NOTICES.md`; [the guard](../../../tests/third-party-notices.test.ts)
checks.

## Hardware qualification

Run before claiming a capability works. Use dedicated iPhones on iOS 27 with Developer Mode on,
test accounts and disposable content, and a Mac with Xcode's developer image installed. Record
phone model and iOS build, Mac architecture and macOS build, bridge revision, Xcode build,
transport and each capability probe, never identifiers.

1. **Setup.** Begin before connecting a phone: missing Xcode offers its App Store page; installed
   Xcode without iPhone support offers Open Xcode. Install support while setup stays open and
   verify it continues without restarting Opensteer. Connect one phone (automatic selection), then
   several (explicit choice). Deny then accept Trust, try a locked phone, and turn on the revealed
   Developer Mode switch with its restart. Setup must continue itself after each phone action,
   through preparation and first observe, stopping for Wi-Fi and naming. Verify an existing
   Device's Fix setup without detaching, cancellation during preparation, and recovery after a
   dispatched attach. Lose the Host during Add and retry: the same command must complete. Lose
   the Runner, close setup, reconnect and begin a fresh attempt. A cold chooser identifies
   trusted phones; an unsupported phone shows its reason and fix. Update Xcode during a blocked
   preparation and retry with its compatible image. Nothing asks for a developer team or passcode.
2. **USB control.** Observe, tap, long press, swipe, drag, scroll, Home and other advertised
   buttons, installed apps and launch, on at least two iPhone models and both Mac architectures
   where available. Count accepted but unapplied inputs separately.
3. **Input authority.** Show input works without a video stream or viewer for over ten minutes
   while control is authorized. Stop, close, disconnect and quitting desktop mid-gesture leave
   no held contact. Nothing is replayed.
4. **Geometry.** Portrait and landscape, Display Zoom, larger text, keyboard up, sheets and
   alerts, edges and corners: screenshot pixels land where they point.
5. **Lock and sleep.** Screen off, locked, unknown lock state, reboot, Mac sleep, Developer Mode
   off and an iOS update. Hidden content never leaks; control returns only after a fresh observe.
   The front app is a label: check it names Home Screen and an ordinary app, that the Opensteer
   app's own screen stays hidden, and that an unnamed app still shows its screenshot.
6. **Wi‑Fi.** After USB setup, unplug and drive the phone over the same Wi‑Fi for over ten
   minutes. Cover Local Network permission denied then granted, Wi‑Fi off and on, an access point
   change, two phones with the same name and Mac sleep.
7. **Switching.** USB to Wi‑Fi and back, unplugging during an action, and replugging after
   offline: one Device, stale observations refused, no repeated input.
8. **Authority.** Two phones on one Mac, two supervised Deployments, a removed iPhone Device, a
   removed Mac Runner, a reattach and owner Stop while an agent observes or acts. Each phone stops
   alone, and another Deployment never drives a reserved phone.
9. **Coexistence.** Xcode, QuickTime and another controller before and after: Opensteer stops or
   unmounts nothing it does not own. Camera and calls work around a session, and closing releases
   it.
10. **Removal.** Remove while the Mac is offline, remove then replug, restart desktop: only that
    mapping goes, nothing reattaches by itself, and old approvals never reach a new Device.

Typing, clearing, element-index targets, wake, person input and live video stay unavailable until
their own qualification passes.
