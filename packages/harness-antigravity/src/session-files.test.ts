import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryAntigravitySession } from "./session-files.js";

const temporaryDirectories: string[] = [];
const sessionId = "10000000-0000-4000-8000-000000000001";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(field: number, payload: Buffer | string): Buffer {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.byteLength), bytes]);
}

function writeSessionDatabase(path: string, id: string, workspacePath: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE trajectory_metadata_blob (id INTEGER PRIMARY KEY, data BLOB)");
    const uri = pathToFileURL(workspacePath).href;
    const blob = Buffer.concat([
      encodeLengthDelimited(1, encodeLengthDelimited(1, uri)),
      encodeLengthDelimited(6, id),
    ]);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (1, ?)").run(blob);
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Antigravity temporary session cleanup", () => {
  it("removes only a session whose metadata proves ownership by the scratch cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-session-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    const scratch = join(root, "scratch");
    await mkdir(conversations, { recursive: true });
    await writeFile(join(conversations, `${sessionId}.meta`), JSON.stringify({ cwd: scratch }));
    await writeFile(join(conversations, `${sessionId}.db`), "temporary session");

    await removeTemporaryAntigravitySession({ cwd: scratch, profileDirectory, sessionId });

    await expect(readFile(join(conversations, `${sessionId}.db`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to remove a session owned by a different cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-session-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    const database = join(conversations, `${sessionId}.db`);
    await mkdir(conversations, { recursive: true });
    await writeFile(
      join(conversations, `${sessionId}.meta`),
      JSON.stringify({ cwd: join(root, "someone-elses-directory") }),
    );
    await writeFile(database, "keep this session");

    await expect(
      removeTemporaryAntigravitySession({
        cwd: join(root, "our-scratch"),
        profileDirectory,
        sessionId,
      }),
    ).rejects.toThrow("ownership did not match");
    await expect(readFile(database, "utf8")).resolves.toBe("keep this session");
  });

  it("verifies ownership from Antigravity 1.5 SQLite trajectory_metadata_blob when no .meta exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-session-15-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const acp = join(profileDirectory, "antigravity-acp");
    const conversations = join(acp, "conversations");
    const annotations = join(acp, "annotations");
    const scratch = join(root, "scratch");
    await mkdir(conversations, { recursive: true });
    await mkdir(annotations, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);
    writeSessionDatabase(dbPath, sessionId, scratch);
    await writeFile(join(annotations, `${sessionId}.pbtxt`), "annotation");

    await removeTemporaryAntigravitySession({ cwd: scratch, profileDirectory, sessionId });

    await expect(readFile(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(annotations, `${sessionId}.pbtxt`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to remove a 1.5 SQLite session belonging to another workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-session-15-other-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const conversations = join(profileDirectory, "antigravity-acp", "conversations");
    const other = join(root, "other-workspace");
    const scratch = join(root, "our-scratch");
    await mkdir(conversations, { recursive: true });
    await mkdir(other, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const dbPath = join(conversations, `${sessionId}.db`);
    writeSessionDatabase(dbPath, sessionId, other);

    await expect(
      removeTemporaryAntigravitySession({ cwd: scratch, profileDirectory, sessionId }),
    ).rejects.toThrow("ownership did not match");
    await expect(readFile(dbPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses to delete through symlinked brain or annotations parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-antigravity-session-symlink-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    const acp = join(profileDirectory, "antigravity-acp");
    const conversations = join(acp, "conversations");
    const outsideBrain = join(root, "outside-brain");
    const outsideBrainSession = join(outsideBrain, sessionId);
    const outsideAnnotations = join(root, "outside-annotations");
    const scratch = join(root, "scratch");
    await mkdir(conversations, { recursive: true });
    await mkdir(outsideBrainSession, { recursive: true });
    await mkdir(outsideAnnotations, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await writeFile(join(outsideBrainSession, "keep.txt"), "do not delete");
    await writeFile(join(outsideAnnotations, `${sessionId}.pbtxt`), "do not delete");
    await symlink(outsideBrain, join(acp, "brain"));
    await symlink(outsideAnnotations, join(acp, "annotations"));
    const dbPath = join(conversations, `${sessionId}.db`);
    writeSessionDatabase(dbPath, sessionId, scratch);

    await removeTemporaryAntigravitySession({ cwd: scratch, profileDirectory, sessionId });

    // Owned DB is removed, while symlinked outside directories remain untouched.
    await expect(readFile(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outsideBrainSession, "keep.txt"), "utf8")).resolves.toBe(
      "do not delete",
    );
    await expect(readFile(join(outsideAnnotations, `${sessionId}.pbtxt`), "utf8")).resolves.toBe(
      "do not delete",
    );
  });
});
