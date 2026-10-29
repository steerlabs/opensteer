import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopPrivateFilesystem } from "./desktop-private-files.js";
import {
  ProtectedJsonFile,
  ProtectedStateUnreadableError,
  type DesktopSecretCryptography,
  type ProtectedJsonContent,
} from "./protected-json-file.js";
import { z } from "zod";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ProtectedJsonFile", () => {
  it("discards rebuildable content this release cannot read", async () => {
    const file = await protectedFile("rebuildable");
    await writeRetiredState(file);

    await expect(file.read()).resolves.toBeNull();
    await expect(lstat(file.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await file.write({ schemaVersion: 2, value: "rebuilt" });
    await expect(file.read()).resolves.toEqual({ schemaVersion: 2, value: "rebuilt" });
  });

  it("refuses to silently reset critical content", async () => {
    const file = await protectedFile("critical");
    const retired = await writeRetiredState(file);

    const error = await file.read().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProtectedStateUnreadableError);
    expect(error).toMatchObject({ message: "The store is incompatible or corrupt." });
    expect(await readFile(file.filePath, "utf8")).toBe(retired);
  });

  it.each([
    ["an envelope that is not JSON", "not json\n", "The store is corrupt."],
    [
      "an envelope of another shape",
      '{"ciphertext":"AAAA","schemaVersion":2}\n',
      "The store is corrupt.",
    ],
    ["an empty ciphertext", '{"ciphertext":"A","schemaVersion":1}\n', "The store is corrupt."],
    [
      "more plaintext than the file may hold",
      `${JSON.stringify({
        ciphertext: Buffer.from(Buffer.from("x".repeat(4_097)).toString("base64")).toString(
          "base64",
        ),
        schemaVersion: 1,
      })}\n`,
      "The store is too large.",
    ],
  ])("names %s as unreadable state and keeps the file", async (_case, content, message) => {
    const file = await protectedFile("critical");
    await writeFile(file.filePath, content, { mode: 0o600 });

    // Failure mode: a plain error, which crash recovery retries forever.
    const error = await file.read().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProtectedStateUnreadableError);
    expect(error).toMatchObject({ message });
    expect(await readFile(file.filePath, "utf8")).toBe(content);
  });

  it("leaves a disk error reading the file as it is", async () => {
    const failure = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    const file = await protectedFile("critical", {
      readFile: async () => {
        throw failure;
      },
    } as unknown as DesktopPrivateFilesystem);

    // Failure mode: a fault that can pass is named unreadable state for good.
    await expect(file.read()).rejects.toBe(failure);
  });
});

async function protectedFile(
  content: ProtectedJsonContent,
  privateFiles?: DesktopPrivateFilesystem,
): Promise<ProtectedJsonFile<{ readonly schemaVersion: 2; readonly value: string }>> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-protected-json-"));
  directories.push(directory);
  return new ProtectedJsonFile({
    content,
    cryptography: fakeCryptography(),
    filePath: path.join(directory, "state.json"),
    maxFileBytes: 8_192,
    maxPlaintextBytes: 4_096,
    messages: { protectedState: "The state", protectedStore: "The store" },
    ...(privateFiles ? { privateFiles } : {}),
    schema: z.strictObject({ schemaVersion: z.literal(2), value: z.string() }),
  });
}

async function writeRetiredState(file: ProtectedJsonFile<unknown>): Promise<string> {
  const encrypted = await fakeCryptography().encryptStringAsync(
    JSON.stringify({ schemaVersion: 1, value: "retired" }),
  );
  const serialized = `${JSON.stringify({
    ciphertext: encrypted.toString("base64"),
    schemaVersion: 1,
  })}\n`;
  await writeFile(file.filePath, serialized, { mode: 0o600 });
  return serialized;
}

function fakeCryptography(): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) =>
      Buffer.from(Buffer.from(plaintext, "utf8").toString("base64"), "utf8"),
    getSelectedStorageBackend: () => "keychain",
    isAsyncEncryptionAvailable: async () => true,
  };
}
