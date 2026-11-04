# Native event fixtures

Recorded native input in its actual order, with UTF-16 selections and trust flags; each companion
JSON holds expectations and a `qualification` verdict, and raw Expo packets also have recorded
hashes. The evidence rules are in [Remote editing](../README.md#native-evidence).

macOS captures use physical CGEvents in disposable VMs. Web Android captures use Gboard in Android
System WebView and do not qualify Android Chrome. Expo captures use the production native control
with a default-ack recorder, not the Expo bridge or a remote target.

Original capture evidence is not in the repo. Electron evidence is under its VM run's
`guest/viewer-native-traces/` directory in the VM artifact store.

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
