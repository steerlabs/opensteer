# Dictation

Dictation turns speech into message text in the composer. Apple's on-device
`SpeechAnalyzer` with `SpeechTranscriber` does the recognition on the person's own Mac
or iPhone. Audio never leaves that device's native process and is never written to
disk; only text, an input level and the session's lifecycle reach JavaScript. No Host,
Runner or server takes part, and dictated words reach the Host only when the person
sends the message.

There is one engine and no substitute. Where it cannot run, the composer has no
microphone button rather than a different recognizer.

## Contract

[`@opensteer/protocol/dictation`](../packages/protocol/src/dictation.ts) is the single
authority for the shapes every platform implements and the composer consumes:
`DictationAvailability`, `DictationEvent` and the `DictationPort` commands.

- **Availability** never prompts, downloads or opens the microphone. It is either a
  resolved language (the first of the system's preferred languages Apple supports,
  never a substituted one), whether its model is installed, and the microphone
  permission; or the reason the button is absent. A denied microphone stays available
  because Settings can fix it; device policy (`restricted`) cannot be fixed, so it is
  a reason for absence.
- **Commands acknowledge; events decide.** `download`, `start`, `stop` and `cancel`
  resolve when accepted. Every outcome, including a start that cannot begin, is exactly
  one `ended` event for that session, and nothing follows it. `error` is present on
  every `ended`, non-null exactly when the reason is `failed`. A rejected command means
  the transport failed.
- **Sessions are fenced.** The controller creates each session id; native code echoes it
  unchanged. `seq` starts at 1 and rises by one per event, so a receiver ignores stale
  events and treats a gap as a failure, keeping the text it already has.
- **Text arrives as segments.** A `text` event carries the segments finalized since the
  previous one and the whole current tentative tail, both in audio order. Native code
  sends each segment exactly as Apple produced it: it never adds, trims or joins
  whitespace or punctuation. The composer controller alone decides whether one space
  goes between two segments, and between the transcript and the draft around it, so
  `["Hello.", "Next"]` reads `Hello. Next` while `["日本語", "です"]` reads `日本語です`
  on every platform.
- **Bounds** are in UTF-16 code units. Real dictation stays far below them, so exceeding
  one fails the session rather than truncating it.

## Composer controller

Create one DictationController from @opensteer/client/dictation per app runtime
and share it across composers. Supply the platform port and a lowercase UUID v4
generator; clock and timers can be injected. Call refresh() at startup, on focus
or foreground, and after returning from microphone Settings. Availability starts
unknown (hide the mic); denied permission keeps the mic visible with Open Settings.

Subscribe with useSyncExternalStore(controller.subscribe, controller.getSnapshot).
Snapshots retain identity between changes. Subscribe the waveform separately with
subscribeLevel; levels never publish snapshots. Dispose the controller at runtime
teardown. Each target has a stable owner, reads the latest draft, and commits into
that original draft even after its composer leaves.

The state machine is idle → starting → listening → finishing → idle, or idle →
downloading → idle. A download never starts capture automatically. Disable other
owners' mic controls while a session is active. Render shared presentation labels,
status formatters and owner-scoped notices from the same export.

Preview stays null until speech arrives. Then render its text over the unchanged
draft, and apply its UTF-16 selection only when the preview text changes. Selection
moves alone do not relocate dictation. On completion the controller inserts final
segments at the captured selection, or appends if the draft changed externally.
Failures also retain the last tentative tail. Cancel discards the preview.

For Send/Enter, await stop() (one shared promise per session). Send the explicit
text on committed; use the current draft on idle/empty; never send on failed/aborted.
Re-check existing send gates and mounted ownership after awaiting, and deduplicate
Send presses in the composer. Typing, paste, cut, delete and IME start must adopt
the displayed edit into the draft and call release(owner) in the same handler.
Selection moves are not edits.

Call leave(owner) on unmount, hide or thread switch: starting cancels; listening
stops and commits; finishing continues into the original target. Send waiters abort
immediately. Downloads continue across composer changes. Native owners handle
window destruction. The ten-minute timer starts on listening and stops with a limit
notice. Sequence gaps and rejected commands retain received text and cancel native
work through the same idempotent termination path.

Show notices only for their owner. The next mic action, an edit in that composer,
or dismiss clears them; empty/downloaded dismiss after five seconds. Announce
state changes and notices once, rather than announcing text, level or timer ticks.
