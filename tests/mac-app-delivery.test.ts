import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  copyMacApp,
  readMacAppManifest,
  verifyMacAppTree,
  writeMacAppManifest,
} from "../scripts/mac-app-delivery.js";
import { runBounded } from "../scripts/command-runner.js";

// Real BSD copy and Python inventory exceed the usual unit budget; this guards
// destination group inheritance that an in-memory inventory would not reproduce.
it.runIf(process.platform === "darwin")(
  "accepts an admin-group prepared copy while still rejecting changed bytes and modes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-app-group-"));
    try {
      const source = path.join(root, "source.app");
      const parent = path.join(root, "admin-applications");
      await mkdir(source);
      await mkdir(parent);
      const uid = (await lstat(source)).uid;
      await chown(source, uid, 20);
      await chown(parent, uid, 80);
      const payload = path.join(source, "payload");
      await writeFile(payload, "original", { mode: 0o644 });
      await chown(payload, uid, 20);
      const context = {
        sourceDirectory: path.resolve(import.meta.dirname, ".."),
        stateDirectory: root,
        identity: { sourceRevision: "a".repeat(40), version: "0.1.210" },
        run: runBounded,
      };
      const filename = path.join(root, "app-tree.json");
      const digest = await writeMacAppManifest(source, filename, context);
      const manifest = await readMacAppManifest(filename, digest, context);
      const prepared = path.join(parent, "Prepared.next");
      await copyMacApp(source, prepared, context);
      const copiedPayload = path.join(prepared, "payload");
      // Reproduce the group of the 0.1.210 clone even if cp preserves it here.
      await chown(copiedPayload, uid, (await lstat(parent)).gid);
      expect((await lstat(payload)).gid).toBe(20);
      expect((await lstat(copiedPayload)).gid).toBe(80);
      await verifyMacAppTree(prepared, manifest, context);

      await writeFile(copiedPayload, "tampered");
      await expect(verifyMacAppTree(prepared, manifest, context)).rejects.toThrow(
        "App tree manifest differs",
      );
      await writeFile(copiedPayload, "original");
      await chmod(copiedPayload, 0o600);
      await expect(verifyMacAppTree(prepared, manifest, context)).rejects.toThrow(
        "App tree manifest differs",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
