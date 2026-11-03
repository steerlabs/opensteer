import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@opensteer/core";
import { NativeFsHelper } from "@opensteer/workspace-local";
import { expect, it } from "vitest";
import { resolveAppWorkspaceRoot } from "./app-workspace-root.js";

it("resolves an app's Workspace through the native root identity check and refuses replacement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "app-workspace-root-")));
  const filesystem = new NativeFsHelper({
    binary: fileURLToPath(
      new URL(
        `../../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
        import.meta.url,
      ),
    ),
    rootPolicy: "managed-local",
  });
  const binding = {
    bindingId: createId("workspaceBinding"),
    generation: 1,
    workspaceId: createId("workspace"),
    ownerEnvironmentId: createId("environment"),
    storageAuthorityId: createId("storageAuthority"),
  };
  const signal = AbortSignal.timeout(5_000);
  try {
    const rootIdentity = await filesystem.directoryIdentity({ root, path: "." }, signal);
    const read = { ...binding, root, rootIdentity };
    const authority = { resolveReadAuthority: async () => read };
    await expect(resolveAppWorkspaceRoot(authority, filesystem, binding, signal)).resolves.toBe(
      root,
    );
    await expect(
      resolveAppWorkspaceRoot(
        {
          resolveReadAuthority: async () => ({
            ...read,
            rootIdentity: { ...rootIdentity, fileId: "0" },
          }),
        },
        filesystem,
        binding,
        signal,
      ),
    ).rejects.toThrow("The Workspace root was replaced");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
