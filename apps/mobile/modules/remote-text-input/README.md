# Remote text input

## Native ordering

`src/editing-proxy.tsx` adapts native input to `@opensteer/client/editing`.
Use its shared reducer; React scheduling must not reorder native delivery.
Selections and marked ranges use UTF-16. Rebuild the custom client after native
changes; Metro exports cannot add a module to an installed binary.

Every native default waits for its numbered acknowledgement. Generated proxy sets
belong in that acknowledgement, after the default and before later FIFO input.
Never set text while marked. Old-context text is fenced, but composition endings,
blur and key releases must still close transactions and held keys.

Context replacement ends old composition under the old context ID, waits for its
acknowledgement, then resets text/traits before queued new-context input. Do not add
a second React finish/reset. Pointer interruption commits old preedit before target
pointer dispatch. Removed views cannot report failures to replacements. Refused or
stale edits retain focus; authoritative blur, Done and release dismiss it.

Android must request the soft keyboard when its window gains focus. Return retains
focus for continued typing; queued keys sample composition state at dispatch.
Clipboard chords use native intent independently of local proxy selection: copied
text comes from the target. Baseline input disables correction and refuses
replacements requiring verified ranges rather than reconstructing a remote field.
See `src/legacy-input.tsx` and `apps/mobile/src/browser/browser-editing.ts`.

## Display and clipboard boundaries

Only active pages receive clipboard delivery. Connection or display-generation
changes retire pending operations. Keep preedit local; map touches through the
actual frame/letterboxing and cancel them when layout changes. Blur, leaving and
backgrounding reset input and cancel composition. Passive previews never opt into
interactive editing. See `apps/mobile/src/computers/display-input.tsx`.

Clipboard writes preserve arrival order. Empty/refused results leave it unchanged;
cut and nontext paste are visibly refused. Expo cannot atomically preserve arbitrary
mixed image/HTML or multiple items; report unsupported formats. Android Mac owner
views use their own [authority](../../../../docs/computer-use.md#negotiated-mac-owner-input).
iOS Mac video requires a native binary advertising decoder recovery.

## Qualification

Use [test-mobile-editing](../../../../.agents/skills/test-mobile-editing/SKILL.md).
Scripted component tests mock decoder/input boundaries. Native local-protocol
fixtures exercise production editing, not a real Host, producer or decoder.
InputConnection/setMarkedText instrumentation is not a real soft-IME recording.
Qualifying autocorrect, predictive, Japanese, Korean, emoji or Gboard gestures
requires actual keyboard input with provenance and replay into the shared reducer.
