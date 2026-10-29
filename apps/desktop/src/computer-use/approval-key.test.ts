import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerAppSetupRequestSchema } from "@opensteer/integration-core";
import { verifyComputerAppApproval } from "@opensteer/runner-auth";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSecretCryptography } from "../secrets/protected-json-file.js";
import { ComputerUseApprovalKey } from "./approval-key.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ComputerUseApprovalKey", () => {
  it("persists only protected key material and reloads the same signing authority", async () => {
    const directory = await directoryForTest();
    const cryptography = fakeCryptography();
    const first = new ComputerUseApprovalKey({
      cryptography,
      dataDirectory: directory,
      platform: "darwin",
    });
    const publicKey = await first.publicKey();
    const serialized = await readFile(
      path.join(directory, "computer-use-approval-key.v1.json"),
      "utf8",
    );
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).toContain("ciphertext");

    const reloaded = new ComputerUseApprovalKey({
      cryptography,
      dataDirectory: directory,
      platform: "darwin",
    });
    expect(await reloaded.publicKey()).toEqual(publicKey);
    const request = setupRequest();
    const approval = await reloaded.sign(request, "deny");
    expect(
      verifyComputerAppApproval({
        approval,
        decision: "deny",
        publicKey: publicKey.publicKey,
        request,
      }),
    ).toBe(true);
    expect(verifyComputerAppApproval({ approval, publicKey: publicKey.publicKey, request })).toBe(
      false,
    );
  });

  it("fails closed when protected storage is unavailable and retries after it returns", async () => {
    const directory = await directoryForTest();
    let available = false;
    const cryptography = fakeCryptography({ available: () => available });
    const key = new ComputerUseApprovalKey({
      cryptography,
      dataDirectory: directory,
      platform: "darwin",
    });
    await expect(key.publicKey()).rejects.toThrow(/macOS Keychain/u);
    available = true;
    await expect(key.publicKey()).resolves.toMatchObject({
      keyId: expect.stringMatching(/^sha256:/u),
    });
  });

  it("preserves a corrupt protected file instead of silently rotating its key", async () => {
    const directory = await directoryForTest();
    const cryptography = fakeCryptography();
    const file = path.join(directory, "computer-use-approval-key.v1.json");
    await writeFile(file, "corrupt ciphertext\n", { mode: 0o600 });
    const key = new ComputerUseApprovalKey({
      cryptography,
      dataDirectory: directory,
      platform: "darwin",
    });
    await expect(key.publicKey()).rejects.toThrow(/corrupt/u);
    expect(await readFile(file, "utf8")).toBe("corrupt ciphertext\n");
    await expect(key.publicKey()).rejects.toThrow(/corrupt/u);
  });
});

async function directoryForTest(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-approval-key-"));
  directories.push(directory);
  return directory;
}

function fakeCryptography(
  options: { readonly available?: () => boolean } = {},
): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString("utf8").slice("protected:".length), "base64").toString(
        "utf8",
      ),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) =>
      Buffer.from(`protected:${Buffer.from(plaintext).toString("base64")}`),
    getSelectedStorageBackend: () => "keychain",
    isAsyncEncryptionAvailable: async () => options.available?.() ?? true,
  };
}

function setupRequest() {
  return ComputerAppSetupRequestSchema.parse({
    access: "read",
    app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    definitionDigest: "sha256:test",
    definitionId: "macos-app",
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: "00000000-0000-4000-8000-000000000002",
    kind: "app",
    ownerUserId: "usr_00000000-0000-4000-8000-000000000003",
    policyAppApproval: null,
    reason: null,
    runnerId: "rnr_00000000-0000-4000-8000-000000000004",
    threadId: null,
    threadTitle: null,
    workspaceId: null,
    workspaceName: null,
  });
}
