---
name: prepare-mobile-golden
description: Prepare the licensed Xcode and iOS runtime inputs and bootstrap the mobile VM golden used by `pnpm test:vm -- --mobile`.
---

# Prepare the mobile VM golden

Bootstrap needs the stopped `opensteer-gui-golden` and its existing SSH key; no
new key is generated. Keep the source checkout clean.

1. Make a real, non-symlink input directory outside the checkout, holding only
   trusted licensed inputs as regular files: `xcode.tar` rooted at `Xcode.app/`,
   `runtime.tar` rooted at `runtime.exportedBundle/` with the complete exported
   arm64 runtime, and `manifest.json`.
2. Archive Xcode:

   ```sh
   COPYFILE_DISABLE=1 tar -cf /absolute/inputs/xcode.tar -C /Applications Xcode.app
   ```

3. Export the runtime with Apple's supported command:

   ```sh
   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
     xcodebuild -downloadPlatform iOS -buildVersion 27.1 -architectureVariant arm64 \
     -exportPath /absolute/runtime-export
   ```

   Xcode 27.1 exports an `.exportedBundle` directory with restore metadata; its
   inner cryptex DMG alone is not the complete input. Check that
   `ExportedMetadata.plist` names final build `24A94425` and architecture
   `arm64`. Rename a task-owned copy of the export to `runtime.exportedBundle/`
   and archive the whole directory as `/absolute/inputs/runtime.tar`. The export
   command may also install the runtime on the downloading Mac; it boots no
   simulator. See
   [Apple's exported runtime format](https://developer.apple.com/documentation/xcode-release-notes/xcode-26_4-release-notes).

4. Write `manifest.json` pinning Xcode 27.1 build `27A9275` and iOS 27.1 build
   `24A94425`, with each archive's real byte count and SHA-256:

   ```json
   {
     "xcode": { "version": "27.1", "build": "27A9275", "bytes": 123, "sha256": "<64 hex>" },
     "runtime": { "version": "27.1", "build": "24A94425", "bytes": 123, "sha256": "<64 hex>" }
   }
   ```

5. Budget host storage for the inputs, installed Xcode, imported runtime and
   clone writes. The 40 GiB admission and 30 GiB floor still apply; a catalog
   download size is not an installed-space estimate, and growing a logical disk
   frees nothing on the host.
6. Bootstrap, then run mobile work against a revision:

   ```sh
   pnpm test:vm -- --mobile-golden --tooling-inputs /absolute/inputs
   pnpm test:vm -- --mobile --revision <commit> bash -c 'cd ../mobile; YOUR_COMMAND'
   ```

Guest provisioning (`scripts/test-vm/provision-mobile.sh`) extracts the runtime
onto APFS, verifies its metadata, imports it and removes only the temporary
extraction.
