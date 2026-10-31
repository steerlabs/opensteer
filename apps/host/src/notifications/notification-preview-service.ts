import type { AesGcmSecretVault } from "@opensteer/access";
import {
  NotificationPreviewKeySchema,
  OpensteerError,
  type AuthSessionId,
  type UserId,
} from "@opensteer/core";
import type {
  NotificationPreviewKeyRecord,
  NotificationPreviewKeyStore,
} from "@opensteer/database";

export class NotificationPreviewService {
  readonly options: {
    readonly store: NotificationPreviewKeyStore;
    readonly vault: AesGcmSecretVault;
    readonly issuer: string;
    readonly onError: (code: "notification-preview-key-unavailable") => void;
  };
  constructor(options: NotificationPreviewService["options"]) {
    this.options = options;
  }

  async register(input: {
    readonly userId: UserId;
    readonly authSessionId: AuthSessionId;
    readonly installationId: string;
    readonly accountId: string;
    readonly keyId: string;
    readonly key: string;
  }): Promise<void> {
    try {
      const sealed = await this.options.vault.seal({ key: input.key }, keyContext(input));
      await this.options.store.register({
        ...input,
        issuer: this.options.issuer,
        encryptedKey: sealed.envelope,
        encryptionKeyVersion: sealed.keyVersion,
      });
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        (error.code === "forbidden" || error.code === "conflict")
      )
        throw error;
      throw new OpensteerError({
        code: "internal",
        message: "Notification preview key could not be registered",
      });
    }
  }

  async keys(userId: UserId, accountIds: readonly string[]) {
    const rows = await this.options.store.eligible(userId, accountIds);
    const keys: {
      readonly accountId: string;
      readonly installationId: string;
      readonly keyId: string;
      readonly key: string;
    }[] = [];
    for (const row of rows) {
      try {
        const payload = await this.options.vault.open(row.encryptedKey, keyContext(row));
        const key = NotificationPreviewKeySchema.safeParse(payload.key);
        if (!key.success) throw new Error("Invalid notification preview key");
        keys.push({
          accountId: row.accountId,
          installationId: row.installationId,
          keyId: row.keyId,
          key: key.data,
        });
      } catch {
        this.options.onError("notification-preview-key-unavailable");
      }
    }
    return keys;
  }
}

function keyContext(
  input: Pick<
    NotificationPreviewKeyRecord,
    "userId" | "authSessionId" | "accountId" | "keyId" | "installationId"
  >,
) {
  return {
    purpose: "notification-preview-key-v1",
    scope: input.userId,
    recordId: input.installationId,
    binding: JSON.stringify([input.authSessionId, input.accountId, input.keyId]),
  };
}
