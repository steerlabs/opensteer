# Display viewer editing

`useComputerDisplay` retains the same `editing: 1` target for both transport and
shared decoder. The Host's `display.state.editingVersion` selects behavior.
Baseline phones keep their committed-text input. Baseline Mac app views remain
view-only; Mac task Watch and phone owner views remain view-only. A negotiated
Mac owner view offers the same Take over / Give back actions as phone task Watch.
The shipped Mac helper and Runner gate owner input off pending native qualification:
Mac owner views receive no editing version and offer no Take over action.

`DisplayEditingSession` adapts the shared proxy to the lease, without another
input authority. The lease reports batch sequences before send, including each
split frame. Context and pending operations retire on control, socket or display
generation changes. Input uses the currently drawn generation; clipboard results only
settle an awaited copy or Cut. Empty/refused results leave the viewer clipboard alone.
The proxy owns the browser gesture/native desktop clipboard port.

Phone and Mac targets show preedit locally, then receive one text edit on commit.
The phone verifies ranges on API 33+; API 30–32 refusals appear in the control bar.
No Android API level is inferred from editing version. A receipt says dispatched,
never applied. Plain paste uses Unicode-safe pieces within the display text bound;
rich paste forwards metadata for explicit refusal. Cut additionally requires the phone and Host
`displayCut: 1` confirmation and viewer `?editing=1&displayCut=1`. Its menu/chord sends the
current context ID; the awaited `display.clipboard` outcome `cut` writes through the same
clipboard port. Old phones and Hosts refuse Cut visibly; Mac paths remain inert. The phone
menu is bound to the editing context and sensitive fields disable export. Caret geometry
comes from the presented, fitted picture.

Mac pointerdown captures the pointer; the paired mousedown supplies the browser's
native click count. Pointer moves carry hover/drag, buttons and modifiers, with one
release per button. Input, pointer and scroll batches share one lease sequence.
Blur/unmount ends held input; F6 and hiding/leaving give back control. The enlarged
phone view is the sole active proxy while open. Stop uses its existing task path.

## Checks

From the repository root, the following single-file checks need no GUI or database:

```sh
pnpm exec vitest run apps/web/src/components/phone-display.test.tsx
pnpm exec vitest run packages/client/src/integrations/phone-display-stream.test.ts
pnpm exec vitest run apps/host/src/computer-use/display-editing-viewer.journey.test.ts
```

The last check uses production Host display routes/hubs over real TCP with fake
authorization stores and phone/Mac producers. Set
`OPENSTEER_DISPLAY_EDITING_EVIDENCE_DIR` to retain its six-case JSON report and
exact wire. The `baseline-host` cases strip viewer opt-in to exercise the old Host
projection; they do not run an old Host binary. The standalone equivalent is:

```sh
pnpm --filter @opensteer/host exec tsx src/computer-use/display-editing-viewer.test-support.ts
```

Component events are scripted DOM events. Native keyboard, clipboard and desktop
pixels need separate `pnpm test:vm` evidence; target application behavior belongs
to the phone and Mac native qualification.

Desktop renderer smoke:

```sh
pnpm test:vm -- bash ../web/scripts/run-display-editing-desktop-smoke.sh
```

It drives native typing/Cmd+A/C/V, the shipping preload/clipboard IPC, a visible
rich-paste refusal, Mac display-mode Cmd+Z/right double-click and give-back. It
uses a fake display producer and the real decoder/screens/transport; Mac owner
source admission is qualified by the separate Host journey. Guest artifacts are
`artifacts/display-editing/{result.json,wire.json,viewer.png}`. This is a renderer
smoke, not native target-application qualification or a full desktop certification.

To batch that smoke with the Chromium viewer journey in the same guest:

```sh
pnpm test:vm -- bash ../web/scripts/run-display-editing-viewer-checks.sh
```

The browser journey uses the real Host fixture, a legal H.264 fixture frame, native
browser typing/commands/clipboard and right double-click, plus explicitly scripted
replacement/IME events. It writes JSON, screenshots and Playwright traces under
`artifacts/display-editing-browser`. Clipboard actions run in the guest only.
