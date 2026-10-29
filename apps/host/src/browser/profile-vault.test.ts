import { createId, OpensteerError, type BrowserProfileId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  BrowserProfileVault,
  type BrowserProfileRevisionRepository,
  type EncryptedBrowserProfileRevision,
} from "./profile-vault.js";

class MemoryRepository implements BrowserProfileRevisionRepository {
  readonly rows = new Map<
    BrowserProfileId,
    EncryptedBrowserProfileRevision & { createdAt: Date }
  >();

  commitBrowserProfileRevision(input: {
    ciphertext: Uint8Array;
    ciphertextSha256: string;
    expectedRevision: number;
    profileId: BrowserProfileId;
  }): Promise<EncryptedBrowserProfileRevision> {
    const current = this.rows.get(input.profileId);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      return Promise.reject(new OpensteerError({ code: "conflict", message: "stale revision" }));
    }
    const row = {
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      ciphertext: Buffer.from(input.ciphertext),
      ciphertextSha256: input.ciphertextSha256,
      revision: input.expectedRevision + 1,
    };
    this.rows.set(input.profileId, row);
    return Promise.resolve(row);
  }

  readBrowserProfileRevision(profileId: BrowserProfileId) {
    return Promise.resolve(this.rows.get(profileId) ?? null);
  }
}

describe("BrowserProfileVault", () => {
  it("prepares an encrypted revision without mutating persistence", async () => {
    const repository = new MemoryRepository();
    const profileId = createId("browserProfile");
    const vault = new BrowserProfileVault({ key: Buffer.alloc(32, 9), repository });
    const snapshot = {
      cookies: [
        {
          domain: ".example.com",
          expires: 2_000_000_000,
          httpOnly: true,
          name: "session",
          path: "/",
          sameSite: "Lax" as const,
          secure: true,
          value: "prepared-secret-cookie",
        },
      ],
      origins: [],
    };

    const prepared = vault.prepareRevision({ expectedRevision: 0, profileId, snapshot });

    expect(prepared.revision).toBe(1);
    expect(prepared.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(prepared.ciphertext).includes("prepared-secret-cookie")).toBe(false);
    expect(repository.rows.size).toBe(0);
    await expect(vault.load(profileId)).resolves.toEqual({
      revision: 0,
      savedAt: null,
      snapshot: { cookies: [], origins: [] },
    });
    vault.destroy();
  });

  it("encrypts immutable revisions with optimistic concurrency", async () => {
    const repository = new MemoryRepository();
    const profileId = createId("browserProfile");
    const vault = new BrowserProfileVault({ key: Buffer.alloc(32, 7), repository });
    await expect(vault.load(profileId)).resolves.toEqual({
      revision: 0,
      savedAt: null,
      snapshot: { cookies: [], origins: [] },
    });
    const snapshot = {
      cookies: [
        {
          domain: ".example.com",
          expires: 2_000_000_000,
          httpOnly: true,
          name: "session",
          path: "/",
          sameSite: "Lax" as const,
          secure: true,
          value: "secret-cookie",
        },
      ],
      origins: [],
    };
    await expect(vault.commit({ expectedRevision: 0, profileId, snapshot })).resolves.toMatchObject(
      {
        revision: 1,
      },
    );
    expect(
      Buffer.from(repository.rows.get(profileId)?.ciphertext ?? []).includes("secret-cookie"),
    ).toBe(false);
    await expect(vault.load(profileId)).resolves.toEqual({
      revision: 1,
      savedAt: new Date("2026-10-01T00:00:00.000Z"),
      snapshot,
    });
    await expect(vault.commit({ expectedRevision: 0, profileId, snapshot })).rejects.toMatchObject({
      code: "conflict",
    });
    vault.destroy();
  });
});
