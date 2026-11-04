# Dictation

Dictation turns speech into composer text on the device. It is not durable and carries no
authority. Procedures are in the [mobile skill](../.agents/skills/mobile/SKILL.md) and the
[mac-gui skill](../.agents/skills/mac-gui/SKILL.md).

Apple's on-device SpeechAnalyzer and SpeechTranscriber are the only recognizer. Audio stays in
native process memory and never reaches disk, JavaScript, a Host or a Runner; only text, levels and
lifecycle cross the bridge, and words reach the Host on Send. Where it is unsupported, hide
dictation rather than substitute a cloud recognizer. Availability must not prompt, download or open
the microphone, and a download never starts capture. Do not announce partial text, levels or timer
ticks to assistive technology.

One [DictationController](../packages/client/src/dictation/controller.ts) per runtime serves every
composer. Its target includes Deployment, user, Thread and composer instance, so finishing commits
into the original draft after navigation, and one composer cannot stop or discard another's session.
Commands acknowledge admission; ordered, session-fenced events decide outcomes. Every accepted
session ends exactly once, and a sequence gap fails while keeping received words. Native sends
Apple's segments unchanged and only the controller joins them. Selections and wire bounds are
UTF-16, and exceeding a bound fails rather than truncating
([dictation.ts](../packages/protocol/src/dictation.ts)).

The draft stays unchanged under preview. Typing or an IME start adopts the displayed text and
releases dictation in the same handler. Completion inserts at the captured selection, or appends if
the draft changed elsewhere; cancel discards tentative words, other endings keep them. Send awaits
finalization, then rechecks ownership and send gates; failed finalization never sends. Leaving while
starting cancels; leaving while listening stops and commits into the original draft without sending.

[apple-dictation](../packages/apple-dictation) owns capture, model reservations and teardown.
Readiness comes from `SpeechTranscriber.installedLocales`, not `AssetInventory` status or
`reservedLocales`: on macOS 26, idle-killing the speech service can empty the reservation view while
installed models keep working. The microphone opens as soon as permission allows, and up to 10
seconds of audio wait in memory while the recognizer prepares; overflow fails explicitly. Input
device or format changes end capture; output route changes do not.

On iPhone, dictation needs iOS 26 and the optional native module; Android hides the mic. Only a
microphone usage description is required, with no speech authorization or background audio mode.
Backgrounding interrupts under a background task and keeps the text already delivered.

On Mac, the `Opensteer Dictation.app` helper runs on Apple silicon with macOS 26 or later and owns
dictation's microphone consent. Both socket peers authenticate with audit tokens and code
requirements, and frames are bounded
([dictation-helper.ts](../packages/protocol/src/dictation-helper.ts)). Electron main delivers events
only to the owning WebContents, and destroying, crashing or navigating that renderer cancels its
work. Sleep and screen lock interrupt. A used session ID is refused before ownership, so a replay
cannot produce another terminal event.
