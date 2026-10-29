import { randomBytes } from "node:crypto";
import type { OpensteerStore } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { CredentialService } from "./credential-service.js";

describe("CredentialService vault startup", () => {
  it("fails immediately when a restored database is paired with the wrong key", async () => {
    let canary: { encryptedPayload: Buffer; keyVersion: number } | null = null;
    const store = {
      createCredentialVaultCanary: vi.fn(async (input: typeof canary) => {
        canary = input;
      }),
      credentialVaultCanary: vi.fn(async () => canary),
    } as unknown as OpensteerStore;
    const key = randomBytes(32);
    await expect(new CredentialService({ key, store }).initialize()).resolves.toBeUndefined();
    await expect(
      new CredentialService({ key: Buffer.from(key), store }).initialize(),
    ).resolves.toBeUndefined();
    await expect(
      new CredentialService({ key: randomBytes(32), store }).initialize(),
    ).rejects.toThrow(/could not be decrypted/);
  });
});
