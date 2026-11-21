import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { confine } from "./paths.js";

// Review G9: provisioner-named host paths stay under their configured roots.
it("accepts a file inside its root and refuses one that leaves it", async () => {
  const top = await mkdtemp(join(tmpdir(), "osp-paths-"));
  const root = join(top, "profiles");
  await mkdir(root);
  await writeFile(join(root, "a.ext4"), "");
  await writeFile(join(top, "outside.ext4"), "");
  await mkdir(join(root, "dir"));
  await symlink(join(top, "outside.ext4"), join(root, "link.ext4"));
  expect(await confine(join(root, "a.ext4"), root, "profile")).toMatch(/a\.ext4$/u);
  await expect(confine(`${root}/../outside.ext4`, root, "profile")).rejects.toThrow("plain");
  await expect(confine(join(top, "outside.ext4"), root, "profile")).rejects.toThrow("outside");
  await expect(confine(join(root, "link.ext4"), root, "profile")).rejects.toThrow("link");
  await expect(confine(join(root, "dir"), root, "profile")).rejects.toThrow("not a profile");
  await expect(confine(join(root, "missing.ext4"), root, "profile")).rejects.toThrow("exist");
  // A root that is a prefix of a sibling's name does not admit the sibling.
  await mkdir(join(top, "profiles-other"));
  await writeFile(join(top, "profiles-other", "b.ext4"), "");
  await expect(confine(join(top, "profiles-other", "b.ext4"), root, "profile")).rejects.toThrow(
    "outside",
  );
});
