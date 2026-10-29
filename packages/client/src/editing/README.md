# Shared editing core

Platform adapters deliver `EditingProxyEvent`s in native event order to
`reduceEditing`. Keep the returned state for the next event, send each operation
once through the surface's target wire, and apply its proxy instruction. Offsets
and marked ranges are UTF-16 units. `markedRange` is optional; native text controls
should provide it when their platform exposes marked text.

The core keeps text typed locally since the last reset. A printable key is its
operation's sole producer; the following native input binds to that pending key.
Native replacements use exact surrounding `before` and `after` text, with caret
moves after a replacement when needed. Compositions have their own transaction
and retain the context where they began. Native `compositionupdate` snapshots
with a marked range can publish preedit without a separate input event.

An ordinary printable key can precede native compositionstart. The transaction
takes over that already produced character, and its admitted keyup still releases
it while the IME owns input. macOS Ctrl–Command–Space stays with the local Character
Viewer; the resulting emoji insertion supplies the remote edit.

For `insertReplacementText`, beforeinput's replacement text identifies the full
native span, including an unchanged prefix or suffix. The core verifies that span
against both snapshots and retains it even for an unchanged-word replacement.
An inconsistent hint is refused before sending an edit. The optional internal
`EditingState.replacement` field carries the hint only until the next input;
adapters need no new event fields.

macOS repeat keys and keys choosing from a native picker wait for a confirming native
beforeinput/input before becoming keystroke producers. The optional internal
`EditingState.nativeKey` holds that decision. Repeats that insert text still
produce separate keystrokes; consumed repeats and candidate digits do not.
The native replacement supplies the edit instead.

Apply `instruction.set` only outside composition and after input/composition
listeners return. Context changes and pointer/blur interruptions close the old
transaction. A native control that has ended composition must still report its
end event; the core fences its late commit. Replacing the native control creates
a fresh reducer state after closing its old transaction.

Abilities describe the target, not the viewer. Targets without range edits keep
no mirror and disable autocorrect. Targets without live composition use a local
preedit overlay and receive the final edit. Unsupported operations return a
refusal. The core uses `unicode-segmenter/grapheme` for cursor distances so it also
runs in native engines without `Intl.Segmenter`.

The web proxy enables platform suggestions and correction only for a range-edit
target with a non-sensitive editable field. It omits `autocomplete`, enables
spellchecking and WebKit autocorrection, and mirrors the field's capitalization,
input mode and enter-key hint. The proxy has no form owner, name, id or associated
label; enclosing forms cannot change its keyboard policy. Sensitive and legacy
proxies use `autocomplete="off"`, disable spellchecking and correction, and use
a password input for sensitive fields. The same pure attribute policy serves the
viewer and native recorder.

Web copy/cut operations are produced from the native clipboard event, where the
browser's write gesture is available. Desktop adapters with a native clipboard
port can produce them directly from the resolved key binding. Paste bytes come
from the trusted local paste event. Clipboard arming and transport belong to the
adapter and target wire; the reducer has no DOM, browser clipboard or Node APIs.

Native browser recorder journeys run in a disposable macOS VM:

```sh
pnpm test:vm -- bash ../../scripts/test-vm/capture-native-traces.sh
```

The macOS batch uses physical CGEvents on this same `ProxyField` in Electron,
Chrome, Safari and Firefox. Input modes enable their parent method before the
mode, and the recorder saves enable/select results and the observed source.
HTTP only resets and reads the proxy; it does not synthesize input. Select a
focused batch with `OPENSTEER_NATIVE_TRACE_ENGINES` and
`OPENSTEER_NATIVE_TRACE_CASES` inside the guest command. An engine-specific
`OPENSTEER_NATIVE_TRACE_CASES_ELECTRON` (or `_CHROME`, `_SAFARI`, `_FIREFOX`)
overrides the common case list, so already captured cases need not run again.
The report lists requested cases. Qualification requires trusted native input,
the intended final value, and completed composition transactions; reconversion
requires both the initial and reconversion transactions. Evidence is under the
VM job's `guest/viewer-native-traces/`, including source revision, intended keys,
trusted event orders, native screenshots and explicit captured/failed/blocked
results. An absent browser or wrong native result fails the batch.

The checked-in Android captures preserve native Gboard input from Android System
WebView. Their source revisions, original evidence paths and independent password
and textarea controls are documented in [fixture provenance](__fixtures__/README.md).
They record the complete EditorInfo and actual keyboard behavior. Normal mirrors
omit `NO_SUGGESTIONS`; legacy mirrors retain it. Password comparisons use the
native TEXT / WEB_PASSWORD class and compare complete `inputType` and `imeOptions`
when no keyboard hint is supplied. An omitted inputmode stays absent so Chromium
can select its native password action key. These observations do not qualify
Android Chrome or Gboard DOM composition where no completed composition was captured.

`native-traces.test.ts` replays only checked-in real captures and asserts the
exact expected text producers, verified ranges and per-transaction commits.
It also compares the complete forwarded key sequence, live preedits with marked
selection, final proxy mirror and target caret anchor.
Expectations describe the intended native journey; they never come from reducer
output. The historical `electron-held-key-no-accent-picker.json` is a failed
picker journey whose observed literal `e1` remains a useful replay. Its passing
replay does not certify press-and-hold. Missing native matrix captures remain
unqualified.
