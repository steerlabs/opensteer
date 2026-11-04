# Test iPhone apps

The Swift cores and Swift↔TypeScript wire vectors run on the host; none prove real Calendar,
Contacts or Reminders grants.

```sh
pnpm exec tsx scripts/generate-apple-data-contracts.ts
swift test --package-path packages/apple-data
swift test --package-path apps/mobile/modules/iphone-apps/ios
swift build --package-path apps/mobile/modules/iphone-apps/ios --product IphoneAppsVectors
OPENSTEER_IPHONE_APPS_NATIVE_TESTS=1 pnpm exec vitest run tests/iphone-apps-wire.test.ts tests/helper-data-contracts.test.ts
```

**Native journey.** A real Host and disposable PostgreSQL bridge frames to the production Swift
proofs, wire and dispatch, with fake Calendar, Location and Photos OS ports. From a clean revision:

```sh
pnpm test:vm -- --mobile --revision <SHA> bash -c 'set -e; cd ../..; export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; bash apps/mobile/modules/iphone-apps/journey/run-in-vm.sh'
```

`native-journey-result.json` lists real CoreLocation, PhotoKit and consent dialogs as unverified.
The URLSession adapter and real Apple stores need the simulator journey; a simulator pregrant cannot
prove a consent dialog. The signed Release install and consent journey belong to the phone's owner.

**Store fixtures**, in an owned mobile VM with `OPENSTEER_IPHONE_APPS_EVIDENCE_DIR` outside the
checkout: `seed` creates one synthetic event, reminder and two contacts, and `snapshot` with the
same marker reads the system stores independently of Opensteer. A missing writable calendar or
reminder source is a recorded prerequisite failure.

```sh
apps/mobile/modules/iphone-apps/fixture/run.sh <simulator-udid> seed iphone-apps-fixture-<unique-id>
apps/mobile/modules/iphone-apps/fixture/run.sh <simulator-udid> snapshot iphone-apps-fixture-<unique-id>
```
