/** Hex SHA-256 digests of secrets, and their constant-time comparison. */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The one digest a stored or compared secret uses. Identity, personal remote
 * access, and local bootstrap each carried a private copy; a stored digest
 * format must not drift between the writer and the reader.
 */
export function digestSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Compares two hex digests without leaking where they differ. */
export function equalSecretDigests(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
