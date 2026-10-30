# Shared editing core

## Adapter contract

Adapters preserve native event order and send each returned operation exactly
once. Offsets and marked ranges are UTF-16; cursor distances are graphemes.
Abilities describe the target, not the viewer. A target without range editing
must not acquire a mirror or autocorrection; without live composition, preedit
stays local until the final edit. See [reducer](reducer.ts) and
[regressions](reducer.test.ts).

A character needs one producer. Native echoes must not duplicate printable
keys; composition may take over a character whose key preceded compositionstart
while still releasing its admitted keyup. Consumed picker/repeat keys are local
until native input confirms insertion. Ctrl–Command–Space belongs to the local
Character Viewer, not the remote target.

Native replacement spans include unchanged prefixes/suffixes and unchanged-word
replacements. Verify exact surrounding snapshots before sending edits; a
plausible diff alone cannot identify what the IME replaced.

Apply proxy writes outside composition and after native listeners return.
Context changes, pointer interruptions and blur close the old transaction, but
the adapter must still report a native composition end so late commits are
fenced. Replacing the control requires fresh reducer state.

## Privacy and clipboard boundaries

Suggestions/correction are only for non-sensitive range-edit targets. Sensitive
fields use native password semantics with correction disabled. Keep the proxy
without form ownership, name, id or associated labels so surrounding forms cannot
change keyboard policy. An unspecified input mode must stay absent: forcing text
changes Chromium's native password action key. See
[proxy attributes](../../../../apps/web/src/components/remote-editing/proxy-attributes.ts).

Web copy/cut must originate from native clipboard events where the browser grants
write access; native clipboard ports may resolve key bindings directly. Paste
bytes come from trusted local paste events. The reducer owns no clipboard or
platform I/O.

## Native evidence

[Fixture qualifications](__fixtures__/README.md) distinguish native evidence from
scripted regressions. Passing replay of a failed native attempt does not qualify
the intended action. Expectations must come from the native journey, never
reducer output. Recorder qualification requires trusted input, intended final
text and closed composition transactions, including both transactions for
reconversion. See [native replay tests](native-traces.test.ts).
