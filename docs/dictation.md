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
  never joins text; the composer controller joins with one boundary rule.
- **Bounds** are in UTF-16 code units. Real dictation stays far below them, so exceeding
  one fails the session rather than truncating it.
