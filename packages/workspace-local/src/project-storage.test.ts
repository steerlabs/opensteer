import { createId } from "@opensteer/core";
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalWorkspaceAuthority } from "./driver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "team-project-storage-"));
  roots.push(root);
  const environmentId = createId("environment");
  const options = {
    namespace: { kind: "owner-scoped" as const },
    registryFilePath: join(root, "private", "registry.json"),
    visibleRootPath: join(root, "files"),
  };
  const authority = new LocalWorkspaceAuthority(options);
  const legacyId = await authority.storageAuthorityId();
  authority.selectProjectStorage(environmentId);
  const binding = {
    bindingId: createId("workspaceBinding"),
    generation: 1,
    ownerEnvironmentId: environmentId,
    storageAuthorityId: await authority.storageAuthorityId(),
    workspaceId: createId("workspace"),
  };
  return { root, options, authority, binding, legacyId };
}

it("persists deployment-owned storage without a Main or creator and reuses its binding after restart", async () => {
  const f = await fixture();
  const path = await f.authority.provisionProject(f.binding, "project-creation");
  expect(path).toBe(join(`${f.options.visibleRootPath}-team`, "projects", f.binding.workspaceId));
  await writeFile(join(path, "keep.txt"), "project work");
  const reopened = new LocalWorkspaceAuthority(f.options);
  expect(await reopened.storageAuthorityId()).toBe(f.legacyId);
  reopened.selectProjectStorage(f.binding.ownerEnvironmentId);
  expect(await reopened.provisionProject(f.binding, "project-creation")).toBe(path);
  expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("project work");
  expect(await reopened.inspect(f.binding)).toEqual({ status: "ready" });
  const document = JSON.parse(await readFile(`${f.options.registryFilePath}.team`, "utf8"));
  expect(document.namespace.kind).toBe("team-project");
  expect(document.bindings[0].createdBy).toBeUndefined();
  expect(JSON.parse(await readFile(f.options.registryFilePath, "utf8")).namespace.kind).toBe(
    "owner-scoped",
  );
  await reopened.destroy(f.binding);
  expect((await reopened.inventory()).bindings).toEqual([]);
  expect(await reopened.destroy(f.binding)).toMatchObject({ outcome: "destroyed" });
});

it("refuses legacy provisioning, a replaced disk and symlinked Project parents", async () => {
  const f = await fixture();
  await expect(
    f.authority.provision({
      binding: f.binding,
      fingerprint: { createdBy: createId("user"), workspaceKind: "project" },
      idempotencyKey: "legacy",
    }),
  ).rejects.toThrow("legacy provisioning");
  await expect(
    f.authority.provisionProject(
      { ...f.binding, storageAuthorityId: createId("storageAuthority") },
      "replacement",
    ),
  ).rejects.toThrow();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(`${f.options.visibleRootPath}-team`, "projects"));
  await expect(f.authority.provisionProject(f.binding, "symlink")).rejects.toThrow();
});
