# Native event fixtures

## Evidence boundary

Fixtures preserve actual native order, UTF-16 selection and trust flags. Their
companion JSON contains provenance and expectations; raw Expo packets also have
recorded hashes. Do not rewrite failed observations into intended results.
Passing replay proves handling of the delivered events, not success of the
native journey. Scripted reducer tests are separate evidence.

macOS captures use physical CGEvents in disposable VMs. Web Android captures use
Gboard in Android System WebView; they do not qualify Android Chrome. Expo
captures use the production native control with a default-ack recorder, not the
Expo bridge or remote target. Full mount/end-to-end qualification is separate.
See [web replay](../native-traces.test.ts),
[native recorder](../../../../../apps/web/src/components/remote-editing/native-trace.cjs)
and [Expo replay](../../../../../apps/mobile/modules/remote-text-input/tests/native-traces.test.ts).

## Qualification traps

A failed held-key capture producing `e1` does not qualify accent picking.
Later successful held-accent captures do; consumed repeats and candidate digits
must not create remote characters. Failed Latin-output Korean/Pinyin attempts
do not qualify those IMEs. Untrusted Chromium composition ends remain failed
qualifications even when replay passes. Partial Safari preedits stay open in
expectations, with no invented commit. Firefox's AltGraph Option handling and
post-composition native inputs must not duplicate text.

Gboard candidate replacement can delete and reinsert unchanged text without any
DOM composition event. Neither that replacement nor caret movement qualifies
Gboard DOM composition. Failed swipe captures do not invalidate earlier successful
swipe evidence. Native Character Viewer opening without insertion does not
qualify emoji insertion; local picker chords must never leak remote keystrokes.
Expo's actual emoji prediction insertion is distinct evidence from those failed
macOS picker journeys.

Password comparisons require complete native EditorInfo equivalence, including
inputType and imeOptions, not just absence of visible suggestions. A probe word
absent from later candidates is an observation, not proof of no keyboard
learning. Corrected fixtures omit unspecified inputmode to preserve the native
password action key; the earlier forced-text capture remains failed keyboard
equivalence. Normal mirrors omit NO_SUGGESTIONS; legacy mirrors retain it.
