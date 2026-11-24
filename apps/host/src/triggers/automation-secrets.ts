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
    const setEntries = Object.entries(patch.set ?? {});
    const removeNames = patch.remove ?? [];

    for (const [name, value] of setEntries) {
      const parsedName = AutomationSecretNameSchema.safeParse(name);
      if (!parsedName.success) {
        throw new OpensteerError({
          code: "bad_request",
          message: `${name}: Invalid secret name.`,
        });
      }
      const parsedValue = AutomationSecretValueSchema.safeParse(value);
      if (!parsedValue.success) {
        throw new OpensteerError({
          code: "bad_request",
          message: `${name}: Invalid secret value.`,
        });
      }
    }

    const next: Record<string, string> = currentSealed
      ? { ...(await this.values(triggerId, currentSealed)) }
      : {};
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
          message: `Secret "${key}" conflicts with "${existing}" which already exists with different casing.`,
        });
      }
      seenLower.set(lower, key);
    }
    if (keys.length > MAX_AUTOMATION_SECRETS) {
      throw new OpensteerError({
        code: "bad_request",
        message: `An automation can hold at most ${MAX_AUTOMATION_SECRETS} secrets.`,
      });
    }
    const totalBytes = automationSecretsTotalBytes(next);
    if (totalBytes > MAX_AUTOMATION_SECRETS_TOTAL_BYTES) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Automation secrets total size exceeds ${MAX_AUTOMATION_SECRETS_TOTAL_BYTES} bytes.`,
      });
    }
    if (keys.length === 0) return null;

    const sealed = await this.#vault.seal(next, context(triggerId));
    return { envelope: sealed.envelope, keyVersion: sealed.keyVersion };
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
