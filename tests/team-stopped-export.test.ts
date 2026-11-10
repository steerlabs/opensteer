import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "../packages/core/src/ids.js";
import { afterEach, expect, it } from "vitest";
import { exportStoppedSnapshot } from "../scripts/teams/export-stopped-snapshot.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "team-offline-export-"));
  temporaryRoots.push(root);
  const source = join(root, "stopped");
  await mkdir(source);
  await mkdir(join(source, "bytes"));
  await writeFile(join(source, "bytes/project.txt"), "Project file");
  await writeFile(join(source, "bytes/private.txt"), "Private file");
  const ownerId = createId("user");
  const projectId = createId("workspace");
  const privateId = createId("workspace");
  const snapshot = {
    format: "opensteer-stopped-content-v1",
    state: "stopped",
    workspaces: [
      { id: projectId, kind: "project", name: "Shared" },
      { id: privateId, kind: "main", name: "Main", ownerId },
    ],
    chats: [
      {
        workspaceId: projectId,
        threadId: "shared-thread",
        title: "Project chat",
        messages: [{ author: "Person", at: "2026-11-10", text: "Shared conversation" }],
      },
      {
        workspaceId: privateId,
        threadId: "private-thread",
        title: "Private chat",
        messages: [{ author: "Person", at: "2026-11-10", text: "Confidential conversation" }],
      },
    ],
    files: [
      { workspaceId: projectId, path: "project.txt", source: "bytes/project.txt" },
      { workspaceId: projectId, path: "remote.txt", source: null },
      { workspaceId: privateId, path: "private.txt", source: "bytes/private.txt" },
    ],
  };
  await writeFile(join(source, "snapshot.json"), JSON.stringify(snapshot));
  return { root, source, snapshot, ownerId, projectId, privateId };
}

it("keeps private and Project exports separate, hashes available bytes, names missing bytes, and leaves unkeyed private data quarantined", async () => {
  const prepared = await fixture();
  const output = join(prepared.root, "export");
  const manifest = await exportStoppedSnapshot({ snapshot: prepared.source, output });
  expect(manifest.complete).toBe(false);
  expect(manifest.bundles[1]).toMatchObject({
    state: "quarantined-source",
    files: [],
    missing: [],
  });
  expect(manifest.bundles[0]!.missing).toEqual(["remote.txt"]);
  const file = manifest.bundles[0]!.files.find((item) => item.path.endsWith("project.txt"))!;
  expect(file).toMatchObject({ bytes: 12, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const chats = await readFile(join(output, "projects", prepared.projectId, "chats.json"), "utf8");
  expect(chats).toContain("Shared conversation");
  expect(chats).not.toContain("Confidential conversation");
  expect(await readFile(join(output, "manifest.json"), "utf8")).not.toContain("Private chat");
});

it("encrypts private metadata and bytes using the owner key without exporting credentials or authority", async () => {
  const prepared = await fixture();
  const key = randomBytes(32);
  const output = join(prepared.root, "encrypted-export");
  const manifest = await exportStoppedSnapshot({
    snapshot: prepared.source,
    output,
    ownerKeys: new Map([[prepared.ownerId, key]]),
  });
  const encrypted = manifest.bundles[1]!.files[0]!;
  const ciphertext = await readFile(join(output, encrypted.path));
  expect(ciphertext.toString("utf8")).not.toContain("private.txt");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce!, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag!, "base64"));
  const metadata = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  expect(metadata).toContain("private.txt");
  expect(metadata).not.toContain(prepared.root);
  expect(JSON.stringify(manifest)).not.toContain(key.toString("hex"));
  expect(manifest.obligations.join(" ")).toContain("restores no identity");
});

it("rejects traversal, symlinks, and non-content snapshot sections rather than copying or running them", async () => {
  const prepared = await fixture();
  const path = join(prepared.source, "snapshot.json");
  await writeFile(
    path,
    JSON.stringify({
      ...prepared.snapshot,
      files: [{ workspaceId: prepared.projectId, path: "../escape", source: "bytes/project.txt" }],
    }),
  );
  await expect(
    exportStoppedSnapshot({ snapshot: prepared.source, output: join(prepared.root, "unsafe") }),
  ).rejects.toThrow("Unsafe snapshot path");
  await writeFile(
    path,
    JSON.stringify({ ...prepared.snapshot, authSessions: [{ token: "do-not-export" }] }),
  );
  await expect(
    exportStoppedSnapshot({
      snapshot: prepared.source,
      output: join(prepared.root, "credentials"),
    }),
  ).rejects.toThrow();
  await writeFile(path, JSON.stringify(prepared.snapshot));
  await rm(join(prepared.source, "bytes/project.txt"));
  await symlink(
    join(prepared.source, "bytes/private.txt"),
    join(prepared.source, "bytes/project.txt"),
  );
  await expect(
    exportStoppedSnapshot({ snapshot: prepared.source, output: join(prepared.root, "symlink") }),
  ).rejects.toThrow("Snapshot symlinks are not permitted");
});
