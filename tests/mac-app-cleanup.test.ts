import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cleanupMacApp } from "../scripts/release-beta-mac.js";
import { acquireReleaseLock, runBounded } from "../scripts/command-runner.js";

// Real filesystem and kernel-lock collaborators guard deletion boundaries;
// Python startup makes these integration checks exceed the 100 ms unit budget.
it("removes all owned copies only after success, preserves unknown names, and skips a live lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-app-cleanup-"));
  const app = path.join(root, "Opensteer Beta.app");
  const revision = "a".repeat(40);
  const target = {
    id: "local",
    applicationPath: app,
    stagingDirectory: path.join(root, "stage"),
    runtimeStatusUrl: null,
  };
  const context = {
    sourceDirectory: root,
    stateDirectory: root,
    identity: { sourceRevision: revision, version: "1" },
    run: runBounded,
  };
  try {
    await mkdir(path.join(app, "Contents"), { recursive: true });
    await writeFile(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>OpensteerSourceRevision</key><string>${revision}</string></dict></plist>`,
    );
    const previous = `${app}.${revision}.previous`;
    const next = `${app}.${"b".repeat(40)}.next`;
    await mkdir(previous);
    await mkdir(next);
    const unlock = await acquireReleaseLock(`${app}.install.lock`);
    try {
      await cleanupMacApp(target, context);
      await access(previous);
      await access(next);
    } finally {
      await unlock();
    }
    await cleanupMacApp(target, context);
    expect((await readdir(root)).sort()).toEqual([
      "Opensteer Beta.app",
      "Opensteer Beta.app.install.lock",
    ]);

    const unknown = `${app}.${revision}.previous.kept`;
    await mkdir(unknown);
    await writeFile(path.join(unknown, "keep"), "unowned");
    const link = `${app}.${"c".repeat(40)}.previous`;
    await symlink(unknown, link);
    await mkdir(next);
    const held = await acquireReleaseLock(`${app}.install.lock`);
    try {
      await cleanupMacApp(target, { ...context, heldApplicationLock: `${app}.install.lock` });
    } finally {
      await held();
    }
    expect(await readFile(path.join(unknown, "keep"), "utf8")).toBe("unowned");
    await access(link);
    await expect(access(next)).rejects.toThrow();
    // An old receipt must never clean a newer installation.
    await mkdir(next);
    await cleanupMacApp(target, {
      ...context,
      identity: { ...context.identity, sourceRevision: "d".repeat(40) },
    });
    await access(next);
    // Cleanup command failures are warnings, not install failures.
    await expect(
      cleanupMacApp(target, {
        ...context,
        run: async () => {
          throw new Error("disk denied");
        },
      }),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
