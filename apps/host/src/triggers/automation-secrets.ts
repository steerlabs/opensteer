import type { AesGcmSecretVault } from "@opensteer/access/host";
import { OpensteerError, type TriggerId } from "@opensteer/core";
import {
  AutomationSecretNameSchema,
  AutomationSecretValueSchema,
  automationSecretsTotalBytes,
  MAX_AUTOMATION_SECRETS,
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
} from "@opensteer/triggers";

export interface AutomationSecretsPatch {
  readonly remove?: readonly string[] | undefined;
  readonly set?: Readonly<Record<string, string>> | undefined;
}

export interface SealedAutomationSecrets {
  readonly envelope: Buffer;
  readonly keyVersion: number;
}

export interface AppliedAutomationSecrets {
  readonly changed: boolean;
  readonly names: readonly string[];
  readonly sealed: SealedAutomationSecrets | null;
}

/**
 * Write-only sealed environment values for a single automation (Y1).
 * Names can be listed; values are opened only to launch that automation's script.
 */
export class AutomationSecrets {
  readonly #vault: Pick<AesGcmSecretVault, "open" | "seal">;

  constructor(vault: Pick<AesGcmSecretVault, "open" | "seal">) {
    this.#vault = vault;
  }

  /** Applies set/replace/remove edits and returns the new sealed envelope, or null when empty. */
  async apply(
    triggerId: TriggerId,
    currentSealed: Buffer | null,
    patch: AutomationSecretsPatch,
  ): Promise<SealedAutomationSecrets | null> {
    return (await this.applyWithMeta(triggerId, currentSealed, patch)).sealed;
  }

  /**
   * Applies set/replace/remove edits, returning whether anything changed and the sorted names.
   * When an existing ciphertext cannot be decrypted (e.g. a different credentialKey, S6), starts
   * from empty and marks `changed: true` so the person can remove or re-enter secrets to recover.
   */
  async applyWithMeta(
    triggerId: TriggerId,
    currentSealed: Buffer | null,
    patch: AutomationSecretsPatch,
  ): Promise<AppliedAutomationSecrets> {
    const setEntries = Object.entries(patch.set ?? {});
    const removeNames = patch.remove ?? [];

    for (const [name, value] of setEntries) {
      const parsedName = AutomationSecretNameSchema.safeParse(name);
      if (!parsedName.success) {
        throw new OpensteerError({
          code: "bad_request",
          reason: "automation-secret-invalid-name",
          message: `${name}: Invalid secret name.`,
        });
      }
      const parsedValue = AutomationSecretValueSchema.safeParse(value);
      if (!parsedValue.success) {
        throw new OpensteerError({
          code: "bad_request",
          reason: "automation-secret-invalid-value",
          message: `${name}: Invalid secret value.`,
        });
      }
    }

    let current: Record<string, string> = {};
    let unreadableCurrent = false;
    if (currentSealed) {
      try {
        current = { ...(await this.values(triggerId, currentSealed)) };
      } catch {
        current = {};
        unreadableCurrent = true;
      }
    }
    const next: Record<string, string> = { ...current };
    for (const name of removeNames) {
      delete next[name];
    }
    for (const [name, value] of setEntries) {
      next[name] = value;
    }

    const keys = Object.keys(next);
    const seenLower = new Map<string, string>();
    for (const key of keys) {
      const lower = key.toLowerCase();
      const existing = seenLower.get(lower);
      if (existing && existing !== key) {
        throw new OpensteerError({
          code: "bad_request",
          reason: "automation-secret-case-conflict",
          message: `Secret "${key}" conflicts with "${existing}" which already exists with different casing.`,
        });
      }
      seenLower.set(lower, key);
    }
    if (keys.length > MAX_AUTOMATION_SECRETS) {
      throw new OpensteerError({
        code: "bad_request",
        reason: "automation-secret-limit",
        message: `An automation can hold at most ${MAX_AUTOMATION_SECRETS} secrets.`,
      });
    }
    const totalBytes = automationSecretsTotalBytes(next);
    if (totalBytes > MAX_AUTOMATION_SECRETS_TOTAL_BYTES) {
      throw new OpensteerError({
        code: "bad_request",
        reason: "automation-secret-size-limit",
        message: `Automation secrets total size exceeds ${MAX_AUTOMATION_SECRETS_TOTAL_BYTES} bytes.`,
      });
    }
    const sortedNames = keys.toSorted();
    const currentKeys = Object.keys(current).toSorted();
    const changed =
      unreadableCurrent ||
      sortedNames.length !== currentKeys.length ||
      sortedNames.some((key, index) => key !== currentKeys[index] || next[key] !== current[key]);

    if (keys.length === 0) {
      return { changed, names: [], sealed: null };
    }
    if (!changed && currentSealed) {
      return {
        changed: false,
        names: sortedNames,
        sealed: { envelope: currentSealed, keyVersion: 1 },
      };
    }

    const sealed = await this.#vault.seal(next, context(triggerId));
    return {
      changed: true,
      names: sortedNames,
      sealed: { envelope: sealed.envelope, keyVersion: sealed.keyVersion },
    };
  }

  /** Sorted names of secrets stored on this automation (never values). */
  async names(triggerId: TriggerId, sealed: Buffer | null): Promise<readonly string[]> {
    if (!sealed) return [];
    const stored = await this.values(triggerId, sealed);
    return Object.keys(stored).toSorted();
  }

  /** Opens the secret map solely for injecting into the automation's script process environment. */
  async values(
    triggerId: TriggerId,
    sealed: Buffer | null,
  ): Promise<Readonly<Record<string, string>>> {
    if (!sealed) return {};
    return this.#vault.open(sealed, context(triggerId));
  }
}

function context(triggerId: TriggerId) {
  return { purpose: "automation-secrets", recordId: triggerId, scope: "trigger" };
}
