import { withTimeout } from "@opensteer/shared/withTimeout";
import type { DesktopSecretCryptography } from "./protected-json-file.js";

const readinessProbe = "opensteer-desktop-protected-storage-readiness-v1";

export interface DesktopSecretCryptographyVerificationFailure {
  readonly error: unknown;
  readonly phase: "availability" | "decrypt" | "encrypt" | "round-trip";
}

/**
 * Electron can report that asynchronous encryption is available before the
 * operating-system key store has actually granted access. This adapter proves
 * the complete encrypt/decrypt path once and shares that result across every
 * protected Desktop store.
 */
export class VerifiedDesktopSecretCryptography implements DesktopSecretCryptography {
  readonly #cryptography: DesktopSecretCryptography;
  readonly #onVerificationFailure:
    ((failure: DesktopSecretCryptographyVerificationFailure) => void) | undefined;
  #verification: Promise<boolean> | null = null;
  #verified = false;

  constructor(
    cryptography: DesktopSecretCryptography,
    options: {
      readonly onVerificationFailure?: (
        failure: DesktopSecretCryptographyVerificationFailure,
      ) => void;
    } = {},
  ) {
    this.#cryptography = cryptography;
    this.#onVerificationFailure = options.onVerificationFailure;
  }

  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }> {
    return this.#cryptography.decryptStringAsync(encrypted);
  }

  encryptStringAsync(plainText: string): Promise<Buffer> {
    return this.#cryptography.encryptStringAsync(plainText);
  }

  getSelectedStorageBackend(): string {
    return this.#cryptography.getSelectedStorageBackend();
  }

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    if (this.#verified) return true;
    this.#verification ??= withTimeout(this.#verify(), 5_000, {
      timeoutError: () => new Error("Protected storage verification timed out."),
    }).catch(() => false);
    try {
      const verified = await this.#verification;
      if (verified) this.#verified = true;
      return verified;
    } finally {
      this.#verification = null;
    }
  }

  async #verify(): Promise<boolean> {
    let available: boolean;
    try {
      available = await this.#cryptography.isAsyncEncryptionAvailable();
    } catch (error) {
      this.#reportFailure("availability", error);
      return false;
    }
    if (!available) {
      this.#reportFailure("availability", new Error("The provider reported unavailable."));
      return false;
    }
    let encrypted: Buffer;
    try {
      encrypted = await this.#cryptography.encryptStringAsync(readinessProbe);
    } catch (error) {
      this.#reportFailure("encrypt", error);
      return false;
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
      this.#reportFailure("encrypt", new Error("The provider returned empty ciphertext."));
      return false;
    }
    let decrypted: { readonly result: string; readonly shouldReEncrypt: boolean };
    try {
      decrypted = await this.#cryptography.decryptStringAsync(encrypted);
    } catch (error) {
      this.#reportFailure("decrypt", error);
      return false;
    }
    if (decrypted.result !== readinessProbe) {
      this.#reportFailure("round-trip", new Error("The provider returned different plaintext."));
      return false;
    }
    return true;
  }

  #reportFailure(
    phase: DesktopSecretCryptographyVerificationFailure["phase"],
    error: unknown,
  ): void {
    try {
      this.#onVerificationFailure?.({ error, phase });
    } catch {
      // Diagnostics cannot change the protected-storage decision.
    }
  }
}
