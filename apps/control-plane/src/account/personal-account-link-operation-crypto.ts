import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CompletePersonalHostAccountLinkResponseSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  type CompletePersonalHostAccountLinkResponse,
  type PersonalHostAccountLinkChallengeId,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type PersonalHostAccountLinkOperationId,
} from "@opensteer/control-plane-protocol";

const sealedPayloadPattern =
  /^(pli1|plr1)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/u;
const maximumPlaintextBytes = 64 * 1_024;
const maximumSealedBytes = 96 * 1_024;

/** Retry-safe encrypted storage for the one-time Account-link result. */
export class PersonalAccountLinkOperationCipher {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encodedKey) {
      throw new TypeError("Personal Account-link operation key must encode exactly 32 bytes");
    }
    this.#key = key;
  }

  seal(
    challengeId: PersonalHostAccountLinkChallengeId,
    response: CompletePersonalHostAccountLinkResponse,
  ): string {
    const parsed = CompletePersonalHostAccountLinkResponseSchema.parse(response);
    return this.#seal("plr1", resultAad(challengeId), parsed);
  }

  sealIssue(
    operationId: PersonalHostAccountLinkOperationId,
    response: IssuePersonalHostAccountLinkChallengeResponse,
  ): string {
    return this.#seal(
      "pli1",
      issueAad(operationId),
      IssuePersonalHostAccountLinkChallengeResponseSchema.parse(response),
    );
  }

  #seal(prefix: "pli1" | "plr1", associatedData: Buffer, value: unknown): string {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.byteLength > maximumPlaintextBytes) {
      throw new TypeError("Personal Account-link result is too large");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${prefix}.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  open(
    challengeId: PersonalHostAccountLinkChallengeId,
    sealed: string,
  ): CompletePersonalHostAccountLinkResponse {
    if (Buffer.byteLength(sealed, "utf8") > maximumSealedBytes) {
      throw new Error("Stored Personal Account-link result is too large");
    }
    const match = sealedPayloadPattern.exec(sealed);
    if (!match || match[1] !== "plr1") {
      throw new Error("Stored Personal Account-link result is invalid");
    }
    const [, , encodedNonce, encodedCiphertext, encodedTag] = match;
    if (!encodedNonce || !encodedCiphertext || !encodedTag) {
      throw new Error("Stored Personal Account-link result is invalid");
    }
    const nonce = canonicalBase64Url(encodedNonce, 12);
    const ciphertext = canonicalBase64Url(encodedCiphertext);
    const tag = canonicalBase64Url(encodedTag, 16);
    if (ciphertext.byteLength > maximumPlaintextBytes + 32) {
      throw new Error("Stored Personal Account-link result is too large");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(resultAad(challengeId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > maximumPlaintextBytes) {
      throw new Error("Stored Personal Account-link result is too large");
    }
    return CompletePersonalHostAccountLinkResponseSchema.parse(
      JSON.parse(plaintext.toString("utf8")),
    );
  }

  openIssue(
    operationId: PersonalHostAccountLinkOperationId,
    sealed: string,
  ): IssuePersonalHostAccountLinkChallengeResponse {
    if (Buffer.byteLength(sealed, "utf8") > maximumSealedBytes) {
      throw new Error("Stored Personal Account-link issue result is too large");
    }
    const match = sealedPayloadPattern.exec(sealed);
    if (!match || match[1] !== "pli1") {
      throw new Error("Stored Personal Account-link issue result is invalid");
    }
    const [, , encodedNonce, encodedCiphertext, encodedTag] = match;
    if (!encodedNonce || !encodedCiphertext || !encodedTag) {
      throw new Error("Stored Personal Account-link issue result is invalid");
    }
    const nonce = canonicalBase64Url(encodedNonce, 12);
    const ciphertext = canonicalBase64Url(encodedCiphertext);
    const tag = canonicalBase64Url(encodedTag, 16);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(issueAad(operationId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return IssuePersonalHostAccountLinkChallengeResponseSchema.parse(
      JSON.parse(plaintext.toString("utf8")),
    );
  }
}

function canonicalBase64Url(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error("Stored Personal Account-link result is not canonical base64url");
  }
  return decoded;
}

function resultAad(challengeId: PersonalHostAccountLinkChallengeId): Buffer {
  return Buffer.from(`opensteer-personal-account-link-result-v1\0${challengeId}`, "utf8");
}

function issueAad(operationId: PersonalHostAccountLinkOperationId): Buffer {
  return Buffer.from(`opensteer-personal-account-link-issue-v1\0${operationId}`, "utf8");
}
