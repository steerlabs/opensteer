import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { BrowserProfileId } from "@opensteer/core";
import {
  EmptyBrowserProfileSnapshot,
  decodeBrowserProfileSnapshot,
  encodeBrowserProfileSnapshot,
  type BrowserProfileSnapshot,
} from "@opensteer/browser-profile/snapshot";

const envelopeVersion = 1;
const nonceBytes = 12;
const tagBytes = 16;

export interface EncryptedBrowserProfileRevision {
  readonly ciphertext: Uint8Array;
  readonly ciphertextSha256: string;
  readonly revision: number;
}

export interface BrowserProfileRevisionRepository {
  commitBrowserProfileRevision(input: {
    readonly ciphertext: Uint8Array;
    readonly ciphertextSha256: string;
    readonly expectedRevision: number;
    readonly periodic?: boolean;
    readonly profileId: BrowserProfileId;
  }): Promise<EncryptedBrowserProfileRevision>;
  readBrowserProfileRevision(
    profileId: BrowserProfileId,
  ): Promise<(EncryptedBrowserProfileRevision & { readonly createdAt: Date }) | null>;
}

export interface LoadedBrowserProfile {
  readonly revision: number;
  readonly snapshot: BrowserProfileSnapshot;
}

export class BrowserProfileVault {
  readonly #key: Buffer;
  readonly #repository: BrowserProfileRevisionRepository;

  constructor(options: {
    readonly key: Uint8Array;
    readonly repository: BrowserProfileRevisionRepository;
  }) {
    if (options.key.byteLength !== 32) throw new TypeError("Browser profile key must be 32 bytes.");
    this.#key = Buffer.from(options.key);
    this.#repository = options.repository;
  }

  async load(
    profileId: BrowserProfileId,
  ): Promise<LoadedBrowserProfile & { readonly savedAt: Date | null }> {
    const stored = await this.#repository.readBrowserProfileRevision(profileId);
    if (!stored) return { revision: 0, savedAt: null, snapshot: EmptyBrowserProfileSnapshot };
    return {
      revision: stored.revision,
      savedAt: stored.createdAt,
      snapshot: this.#open(profileId, stored.revision, stored.ciphertext),
    };
  }

  async commit(input: {
    readonly expectedRevision: number;
    readonly periodic?: boolean;
    readonly profileId: BrowserProfileId;
    readonly snapshot: BrowserProfileSnapshot;
  }): Promise<LoadedBrowserProfile> {
    const prepared = this.prepareRevision(input);
    const stored = await this.#repository.commitBrowserProfileRevision({
      ciphertext: prepared.ciphertext,
      ciphertextSha256: prepared.ciphertextSha256,
      expectedRevision: input.expectedRevision,
      periodic: input.periodic ?? false,
      profileId: input.profileId,
    });
    return { revision: stored.revision, snapshot: input.snapshot };
  }

  /**
   * Encrypt a revision without writing it. Callers that must create a Profile,
   * its first revision, an authority grant, and a terminal Request atomically
   * can prepare the opaque bytes first and commit all relational state in one
   * database transaction.
   */
  prepareRevision(input: {
    readonly expectedRevision: number;
    readonly profileId: BrowserProfileId;
    readonly snapshot: BrowserProfileSnapshot;
  }): EncryptedBrowserProfileRevision {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError("Expected browser profile revision is invalid.");
    }
    const revision = input.expectedRevision + 1;
    const ciphertext = this.#seal(input.profileId, revision, input.snapshot);
    return {
      ciphertext,
      ciphertextSha256: createHash("sha256").update(ciphertext).digest("hex"),
      revision,
    };
  }

  destroy(): void {
    this.#key.fill(0);
  }

  #seal(profileId: BrowserProfileId, revision: number, snapshot: BrowserProfileSnapshot): Buffer {
    const plaintext = encodeBrowserProfileSnapshot(snapshot);
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(profileId, revision));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);
    return Buffer.concat([Buffer.from([envelopeVersion]), nonce, tag, ciphertext]);
  }

  #open(
    profileId: BrowserProfileId,
    revision: number,
    envelope: Uint8Array,
  ): BrowserProfileSnapshot {
    if (envelope.byteLength < 1 + nonceBytes + tagBytes || envelope[0] !== envelopeVersion) {
      throw new Error("Browser profile envelope is invalid.");
    }
    const bytes = Buffer.from(envelope);
    const nonce = bytes.subarray(1, 1 + nonceBytes);
    const tag = bytes.subarray(1 + nonceBytes, 1 + nonceBytes + tagBytes);
    const ciphertext = bytes.subarray(1 + nonceBytes + tagBytes);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(aad(profileId, revision));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return decodeBrowserProfileSnapshot(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }
}

function aad(profileId: BrowserProfileId, revision: number): Buffer {
  return Buffer.from(`opensteer/browser-profile/v1\0${profileId}\0${revision}`, "utf8");
}
