import { withTimeout } from "@opensteer/shared/withTimeout";
import { prepareElectronLocalProfiles } from "../../src/browser/electron-local-profile.js";

export const smokeProtectedStorageUnavailablePrefix =
  "Protected storage unavailable for keychain-backed browser profile journey";

/**
 * Verifies OS protected storage (e.g. macOS login keychain) responds and is
 * unlocked within a few seconds, failing the journey at once instead of letting
 * Chromium or safeStorage hang on a keychain prompt.
 */
export async function requireSmokeProtectedStorage(
  options: {
    readonly check?: () => Promise<boolean>;
    readonly timeoutMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const check = options.check ?? prepareElectronLocalProfiles;
  let available: boolean;
  try {
    available = await withTimeout(check(), timeoutMs, {
      timeoutError: () =>
        new Error(
          `${smokeProtectedStorageUnavailablePrefix}: protected storage did not answer within ${timeoutMs}ms (locked login keychain?).`,
        ),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(smokeProtectedStorageUnavailablePrefix))
      throw error;
    throw new Error(
      `${smokeProtectedStorageUnavailablePrefix}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!available) {
    throw new Error(
      `${smokeProtectedStorageUnavailablePrefix}: OS protected storage is unavailable or the login keychain is locked.`,
    );
  }
}
