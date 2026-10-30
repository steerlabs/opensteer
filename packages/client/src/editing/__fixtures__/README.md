# Native event fixtures

## Evidence boundary

Fixtures preserve actual native order, UTF-16 selection and trust flags. Their
companion JSON holds expectations; raw Expo packets also have recorded hashes.
Where each capture came from is under [Provenance](#provenance). Do not rewrite failed observations into intended results.
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

## Provenance

Original capture evidence is not in the repo. Electron evidence is under its
VM run's `guest/viewer-native-traces/` directory in the VM artifact store.

| Fixtures                                                       | Source revision                            | VM run                      |
| -------------------------------------------------------------- | ------------------------------------------ | --------------------------- |
| `electron-*.json`                                              | `d679445234e758319a829b9d2b10ab68dfe350ce` | `20261027T212330Z-02c7f7cc` |
| `*-repeat.json`, `android-gboard-existing-word-candidate.json` | `f3016481de544be4599efcb7e52ffe6ab3cdcd82` |                             |
| `android-corrected3-*.json`                                    | `828645aed7b3e5928ffdf9464eb5183e3aeecfc2` |                             |
| `android-corrected6-*.json`                                    | `a0035f1300a6df64e7d3e8898ca9bc406ce8129c` |                             |
| `macos1-*.json`                                                | `444f12dce66f4fcb55e5a66015a8f2a62c2181ad` | `20261028T060214Z-81a94ac5` |
| `macos2-*-accent-hold.json`                                    | `e082eb7139132d47a6878168edddd8099386657b` | `20261028T072822Z-6715893f` |
| `macos3-*.json`                                                | `47e7bfc0da3a6f169030636f0f06f9b430eb86fc` | `20261028T081344Z-bd1545f1` |
| `expo-android-us-emoji-prediction*`                            | `95bb4db7930dfc9dd79307182c2faa26fad92ab8` |                             |
| `expo-android-autocorrect*`                                    | `5248d68b94e3d103dde70cd1eb912d41f68da778` |                             |
