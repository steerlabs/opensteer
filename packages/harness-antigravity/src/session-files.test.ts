import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTemporaryAntigravitySession } from "./session-files.js";

const temporaryDirectories: string[] = [];
const sessionId = "10000000-0000-4000-8000-000000000001";

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
});
