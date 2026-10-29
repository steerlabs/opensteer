import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DesktopPrivateFilesystemError,
  openDesktopPrivateFilesystem,
  openDesktopPrivateFilesystemSync,
} from "./desktop-private-files.js";
import { ProtectedJsonFile } from "./protected-json-file.js";
import { z } from "zod";

const helper = path.resolve(
  import.meta.dirname,
  `../../../runner/native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
);
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await import("node:fs/promises").then(({ access }) => access(helper));
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Desktop private filesystem authority", () => {
  it("initializes the startup root and directories synchronously", async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, "Opensteer");
    const files = openDesktopPrivateFilesystemSync({ binary: helper, root });
    const session = path.join(root, "session");

    files.ensureDirectorySync(session);

    await expect((await import("node:fs/promises")).stat(session)).resolves.toMatchObject({});
  });

  it("creates private directories and performs bounded atomic file operations", async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, "Opensteer");
    const files = await openDesktopPrivateFilesystem({ binary: helper, root });
    const secrets = path.join(root, "deployments", "one", "secrets.json");

    await files.ensureDirectory(path.dirname(secrets));
    await files.writeFileExclusive(secrets, "one");
    await expect(files.writeFileExclusive(secrets, "two")).rejects.toMatchObject({
      code: "already-exists",
    });
    expect(await files.readFile(secrets, 32)).toEqual(Buffer.from("one"));
    await files.writeFileAtomic(secrets, "two");
    expect(await files.readFile(secrets, 32)).toEqual(Buffer.from("two"));
    expect(await files.fileExists(secrets)).toBe(true);
    expect(await files.directoryEmpty(path.dirname(secrets))).toBe(false);
    expect(await files.removeFile(secrets)).toBe(true);
    expect(await files.removeFile(secrets)).toBe(false);
    expect(await files.readFile(secrets, 32)).toBeNull();
    expect(await files.directoryEmpty(path.dirname(secrets))).toBe(true);
  });

  it("pins the root identity and refuses a replaced app data directory", async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, "Opensteer");
    const files = await openDesktopPrivateFilesystem({ binary: helper, root });
    await files.writeFileExclusive(path.join(root, "state.json"), "safe");
    await rename(root, `${root}.replaced`);
    await mkdir(root, { mode: 0o700 });

    await expect(files.readFile(path.join(root, "state.json"), 32)).rejects.toMatchObject({
      code: "root-replaced",
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlink traversal and fails closed on unsafe owner modes",
    async () => {
      const base = await temporaryDirectory();
      const root = path.join(base, "Opensteer");
      const outside = await temporaryDirectory();
      const files = await openDesktopPrivateFilesystem({ binary: helper, root });
      await writeFile(path.join(outside, "outside.json"), "outside");
      await symlink(outside, path.join(root, "escape"), "dir");

      await expect(
        files.readFile(path.join(root, "escape", "outside.json"), 32),
      ).rejects.toBeInstanceOf(DesktopPrivateFilesystemError);

      const privateDirectory = path.join(root, "private");
      await mkdir(privateDirectory, { mode: 0o777 });
      await chmod(privateDirectory, 0o777);
      await expect(files.ensureDirectory(privateDirectory)).rejects.toMatchObject({
        code: "unsafe-permissions",
      });
    },
  );

  it("rejects paths outside the initialized app data root before invoking the helper", async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, "Opensteer");
    const files = await openDesktopPrivateFilesystem({ binary: helper, root });

    await expect(files.readFile(path.join(base, "outside.json"), 32)).rejects.toThrow(
      /outside its initialized root/u,
    );
  });

  it("backs encrypted JSON stores with the same native authority", async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, "Opensteer");
    const privateFiles = await openDesktopPrivateFilesystem({ binary: helper, root });
    const protectedFile = new ProtectedJsonFile({
      content: "critical",
      cryptography: {
        decryptStringAsync: async (encrypted) => ({
          result: encrypted.toString("utf8"),
          shouldReEncrypt: false,
        }),
        encryptStringAsync: async (plaintext) => Buffer.from(plaintext, "utf8"),
        getSelectedStorageBackend: () => "keychain",
        isAsyncEncryptionAvailable: async () => true,
      },
      filePath: path.join(root, "protected.json"),
      maxFileBytes: 4_096,
      maxPlaintextBytes: 1_024,
      messages: { protectedState: "State", protectedStore: "Store" },
      privateFiles,
      schema: z.strictObject({ value: z.string() }),
    });

    await protectedFile.write({ value: "secret" });
    await expect(protectedFile.read()).resolves.toEqual({ value: "secret" });
    await protectedFile.remove();
    await expect(protectedFile.read()).resolves.toBeNull();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-private-files-"));
  temporaryDirectories.push(directory);
  return directory;
}
