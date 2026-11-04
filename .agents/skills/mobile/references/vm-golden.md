# Prepare the mobile VM golden

Bootstrap needs the stopped `opensteer-gui-golden`, its existing SSH key and a clean checkout.
[test-vm.ts](../../../../scripts/test-vm.ts) validates the inputs;
[provision-mobile.sh](../../../../scripts/test-vm/provision-mobile.sh) imports the runtime in the
guest.

Make a real, non-symlink directory outside the checkout holding only trusted licensed regular files:
`xcode.tar` rooted at `Xcode.app/`, `runtime.tar` rooted at `runtime.exportedBundle/`, and
`manifest.json`.

```sh
COPYFILE_DISABLE=1 tar -cf /absolute/inputs/xcode.tar -C /Applications Xcode.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -downloadPlatform iOS -buildVersion 27.1 -architectureVariant arm64 \
  -exportPath /absolute/runtime-export
```

The export may also install the runtime on this Mac; it boots no simulator. The whole
`.exportedBundle` with restore metadata is the input, not its inner cryptex DMG. Check
`ExportedMetadata.plist` names build `24A94425` and `arm64`, rename a task-owned copy to
`runtime.exportedBundle/` and archive it as `runtime.tar`. Then write `manifest.json` with each
archive's real byte count and SHA-256:

```json
{
  "xcode": { "version": "27.1", "build": "27A9275", "bytes": 123, "sha256": "<64 hex>" },
  "runtime": { "version": "27.1", "build": "24A94425", "bytes": 123, "sha256": "<64 hex>" }
}
```

Budget host space for inputs, installed Xcode, the imported runtime and clone writes (admission
needs 40 GiB free; work stops below 30 GiB). Bootstrap, then run mobile work against a revision:

```sh
pnpm test:vm -- --mobile-golden --tooling-inputs /absolute/inputs
pnpm test:vm -- --mobile --revision <commit> bash -c 'cd ../mobile; YOUR_COMMAND'
```

Provisioning refuses an existing golden; never replace one to force a retry. A listed simulator type
does not prove the pinned runtime supports it; only a cold boot with real simulator proof certifies
the golden.
