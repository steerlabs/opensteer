# Remote editing

The shared editing core lets a local proxy field type into a remote target: a browser page, an Agent
Phone or a Mac app view. [The reducer](reducer.ts) turns native input events into target operations
and owns no clipboard or platform I/O. Adapters are the web proxy
([remote-editing](../../../../apps/web/src/components/remote-editing)), the Expo module
([remote-text-input](../../../../apps/mobile/modules/remote-text-input/src/editing-proxy.tsx)) and
the display viewer ([phone-display.tsx](../../../../apps/web/src/components/phone-display.tsx)).
Browser targets are in [Browser sessions](../../../../docs/browser-sessions.md); phone targets in
[Agent Phone](../../../../docs/agent-phone.md#live-display). Procedures are in the
[mobile skill](../../../../.agents/skills/mobile/SKILL.md).

## Adapter contract

Adapters keep native event order, so React scheduling must not reorder delivery, and send each
returned operation exactly once. Offsets and marked ranges are UTF-16; cursor distances are
graphemes. Abilities describe the target, not the viewer: a target without range editing gets no
mirror or autocorrection, and without live composition preedit stays local until the final edit.

A character has one producer. Native echoes must not duplicate printable keys; composition may take
over a character whose key preceded compositionstart but must still release its keyup. Consumed
picker and repeat keys stay local until native input confirms insertion. Ctrl–Command–Space belongs
to the local Character Viewer, never the target.

Native replacement spans include unchanged prefixes, suffixes and words. Verify the exact
surrounding text before sending an edit; a plausible diff cannot show what the IME replaced. Apply
proxy writes outside composition and after native listeners return. Context changes, pointer
interruptions and blur close the old transaction, but the adapter must still report the native
composition end so late commits are fenced. A new control needs fresh reducer state.

On Expo, every native default waits for its numbered acknowledgement, and proxy sets belong in that
acknowledgement before later input. Never set text while marked. A context change ends the old
composition under the old context ID before resetting for the new one. Android must request the soft
keyboard when its window gains focus. Baseline input disables correction and refuses replacements
that need verified ranges rather than reconstructing a remote field. Expo cannot atomically keep
mixed image and HTML or multiple clipboard items, so report unsupported formats. Native changes need
a rebuilt custom client.

## Privacy and clipboard

Suggestions and correction are only for non-sensitive range-edit targets; sensitive fields use
native password semantics with correction off. The proxy has no form owner, name, id or label, so
surrounding forms cannot change keyboard policy. An unspecified input mode stays absent: forcing
text changes Chromium's native password action key
([proxy attributes](../../../../apps/web/src/components/remote-editing/proxy-attributes.ts)).

Web copy and cut come from native clipboard events where the browser grants write access; paste
bytes come from trusted local paste events. Only active views receive clipboard data, copied text
comes from the target, and empty or refused results leave the local clipboard alone. Connection or
display generation changes retire pending operations.

Clipboard items are representations of one copy. Adapters report every one they read and the
reducer alone keeps what the target's `clipboard` accepts: a `text` target gets the copy's plain
text and refuses only a copy without any, so a web page's text-and-HTML copy still pastes.

## Display viewers

Phone and Mac display targets show preedit locally and receive one text edit on commit, using the
same lease and sequence as pointer and scroll input. A receipt means dispatched, never applied. The
Mac helper admits four pending batches per window, so pointer moves and wheel turns merge while a
receipt is pending. Phone and Mac targets take plain text only. Cut needs
separate phone, Host and viewer agreement (`displayCut`); Mac targets never offer it, and sensitive
phone fields disable export. No Android API level is inferred from the editing version. Baseline Mac
app views and Mac task Watch stay view-only.

## Native evidence

Scripted reducer tests and native captures are separate evidence; [fixtures](__fixtures__) hold the
captures and their provenance. Expectations come from the native journey, never from reducer output,
and a failed observation is never rewritten into the intended result. Passing replay of a failed
attempt does not qualify the action. Qualifying a keyboard behavior (autocorrect, prediction, CJK,
emoji, swipe) needs actual keyboard input with provenance, trusted events, the intended final text
and closed composition transactions; InputConnection or setMarkedText instrumentation is not a
soft-IME recording. A password comparison needs full native EditorInfo equivalence, not just absent
suggestions. Gboard candidate replacement can delete and reinsert unchanged text with no DOM
composition event. See [native replay tests](native-traces.test.ts).
