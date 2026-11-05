# Verify browser sessions

```sh
pnpm exec vitest run apps/browser-runtime/src/browser/editing.test.ts apps/browser-runtime/src/browser/navigation.test.ts apps/browser-runtime/src/browser/agent-cursor.test.ts
pnpm test:integration apps/host/src/browser/browser-editing.integration.test.ts
pnpm --filter @opensteer/web test:browser-navigation
pnpm --filter @opensteer/web test:agent-cursors
pnpm --filter @opensteer/web test:browser-downloads
```

For a real Electron boundary, pick the affected VM journey (guest commands start in `apps/desktop`).
Run the CDP-boundary smoke when changing the allowlist: private-world handles and events and
blocked-CORS headers must stay unavailable.

```sh
pnpm test:vm -- --mobile bash scripts/test-macos-journeys.sh native-browser
pnpm test:vm -- bash scripts/test-viewer-clipboard.sh --editing-v2
pnpm test:vm -- pnpm test:electron-downloads
pnpm test:vm -- pnpm test:electron-cdp-boundary
```

## Native profiles and bounded opening

Select the layer changed; keep every engine's cookie scope and durability checks.

```sh
pnpm exec vitest run packages/browser-runtime-core/src/native-profiles.test.ts packages/browser-runtime-core/src/local-profile-store.test.ts packages/browser-runtime-core/src/native-profile-ready.test.ts
pnpm exec vitest run apps/browser-runtime/src/browser/playwright-launcher.test.ts apps/browser-runtime/src/browser/persistent-launch-cleanup.test.ts
pnpm exec vitest run apps/desktop/src/browser/electron-browser-launcher.test.ts apps/desktop/src/browser/session-cookie-mirror.test.ts apps/desktop/src/browser/browser-session-policy.test.ts
pnpm exec vitest run packages/client/src/host/pending-browser-tabs.test.ts packages/client/src/host/browser-presentation-wait.test.ts
pnpm test:integration -- tests/browser-native-only-migration.integration.test.ts packages/database/src/operation-budget.integration.test.ts tests/browser-native-profiles.integration.test.ts tests/browser-profiles.integration.test.ts
```

- **Migration**: two fixed local bindings with native sentinels and cookie files present first.
  Owner, name, grants, history, tabs, binding and initialized facts survive; native bytes stay
  unchanged; pending deletion jobs keep archived stubs. New profiles stay empty and unbound until
  signed attach. Missing established data fails; never-created data may publish empty files
  atomically before any Session owns it.
- **Opening**: durable same-key replay, payload conflict, restart interruption, late success after
  terminal failure. The Host's 20-second budget covers locks, placement and relay; the client's 25
  seconds cover native mount, paint and frames. Retry reuses the same page, errors stay visible on
  it, and a hung persistent launch reaps its exact child before rejecting.
- **Lifecycle**: warm reuse, idle eviction, independent profiles, complete and interrupted
  inventories, immutable binding conflicts, tombstone reconciliation, and deletion with an offline
  owner and a Session held until exit; visible pending states precede erasure acknowledgement.

## Real Electron qualification

Only in a disposable VM, on request or after merge, from the integrated committed revision; unlock
only the golden's fixture keychain.

```sh
pnpm test:vm -- pnpm test:electron-profile-restore
pnpm test:vm -- pnpm test:electron-cookies
```

Qualify orderly quit, update-style restart and SIGKILL reopen with persistent, session and HttpOnly
cookies, duplicate CHIPS identities, localStorage, IndexedDB, service workers and CacheStorage,
crashing after controlled cookie writes. Session-cookie restore must restore no unauthorized tabs.
After killing the smoke's captured Network Service PID, check gate refusal and view closure,
explicit reopen, the first request, surviving workers, and that interrupted capture cannot shrink
the encrypted mirror. Missing or corrupt mirrors refuse opening without clearing data. Never admit a
Session with an unacknowledged cookie mutation.

Earlier browser releases are rejected by design: check the update refusal, and add no Vault,
preparation, snapshot or Guest-save adapters. For model-facing browser changes, use the
[run-agent-evals skill](../../run-agent-evals/SKILL.md).

## Certified H.264 browser qualification

JPEG remains an explicit qualification selection. Select H.264 before opening a
presentation with `VITE_BROWSER_PRESENTATION=h264` for web/streamed desktop or
`EXPO_PUBLIC_BROWSER_PRESENTATION=h264` for mobile. A missing producer owner or
native presentation-identity capability is an update/build error; it never selects
JPEG after an H.264 failure. Ordinary agent CDP never acquires this private owner.

Stock npm Electron does not contain the producer. After the producer owner has
linked and qualified the custom build, development Electron must use
`ELECTRON_OVERRIDE_DIST_PATH` pointing to the directory containing that local
Electron distribution.
Run Electron inside the disposable VM, with that distribution staged at the
configured path inside the guest. Do not launch Electron or drive the shared host
screen. Do not modify the external Electron build from this checkout.

Run the focused transport, owner and presenter checks:

```sh
pnpm exec vitest run packages/protocol/src/browser-video.test.ts packages/browser-runtime-core/src/browser/browser-presentation-session.test.ts apps/host/src/browser/browser-video-hub.test.ts packages/shared/src/mediaForwarder.test.ts packages/runner-client/src/browser-video-relay.test.ts apps/desktop/src/browser/electron-browser-presentation.test.ts apps/web/src/components/browser/browser-presenter.test.ts
pnpm exec vitest run apps/host/src/computer-use/display-stream-hub.test.ts apps/runner/src/computer-apps/mac-window-video-relay.test.ts apps/web/src/components/phone-display-media.test.ts packages/client/src/host/browser-watch.test.ts
swift test --package-path apps/mobile/modules/phone-display/ios
pnpm bench:browser-stream --producer fixture-h264 --profile all --source-profile weak-cell --devices 2 --out /tmp/browser-h264-fixture.json
```

For weak-cell fixture runs, inspect attach time, motion, key requests and each
device's independent recovery. Repeat with hardware and software backends against
the custom producer before qualification. Fixture AUs do not qualify encoder rate,
CPU, idle behavior or native input. Use reserved devices for `--viewer ios` and
`--viewer android`.

In the VM or reserved native job, use the existing PhoneDisplay fixture entry
under `apps/mobile/modules/phone-display/tests/native`. Exercise the
`PhoneDisplayVideo` view with the same AUs and full per-input identity metadata.
Check same-sized alternating colours, delayed/skipped output, a lone initial key,
a final delta, replay suppression, resize while touching and background/reset.
The iOS Simulator SDK has no Metal drawable presentation receipt and advertises
this capability as unsupported; use an owned physical iPhone for that acceptance.
An iOS drawable presentation or Android owned texture commit must identify the
visible colour; decoder admission and frame-rendered callbacks alone do not pass.
Check that native touch-start retains the old certificate through a later picture,
including touch-down while a newer frame is being submitted. Keep real Connect,
hardware/software encoders, text readability, popup exclusions, multi-device
handover and native disposal/cleanup as explicit unqualified boundaries until the
corresponding binary/device run passes.

## Browser-owned popup qualification

Use the reviewed private owner and a rebuilt native mobile presenter. There is no
CDP, DOM-setter or native-window fallback for a refused remote picker or edit.
Keep labels, values, IDs, typed text and schema errors out of diagnostics and
artifacts; retain only enum/count evidence. See [the disclosure and input
boundary](../../../../docs/browser-sessions.md#certified-h264-control).

For the integrated qualified Electron snapshot, archive `Electron.app` as
`Electron.tar` outside the checkout and stage that archive beside `SOURCE.txt`
as read-only VM inputs. Framework symlinks must be unpacked inside the guest;
the shared filesystem cannot reliably copy them directly. Select H.264 before payload
build and use the guest wrapper so the npm Electron launcher resolves the guest
copy before import:

```sh
VITE_BROWSER_PRESENTATION=h264 pnpm test:vm -- --inputs /absolute/popup-inputs --revision <commit> bash scripts/browser-popup-vm.sh
```

The selected `popups` journey uses the real Personal Host, the app's temporary
profile/database roots and a separate Chromium viewer process. The wrapper installs
the repository-pinned Playwright browser in the disposable guest; an explicit
`OPENSTEER_POPUP_VIEWER_EXECUTABLE` may name another qualified viewer. The exact
private owner contract (`process.versions.opensteer === "1"`) and the private owner
are preflight requirements; source hashes in `SOURCE.txt` record provenance, not
admission. Unit, native module or sheet-only evidence does
not qualify real H.264 input. Run the fixture on an owned physical iPhone and a
reserved Android device separately; the iOS Simulator cannot qualify Metal
presentation identity. Keep server-Deployment/Connect and weak-cell acceptance
explicitly unqualified until those actual routes pass.
