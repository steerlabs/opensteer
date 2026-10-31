import { randomBytes } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access";
import { createId } from "@opensteer/core";
import type {
  NotificationPreviewKeyRecord,
  NotificationPreviewKeyStore,
} from "@opensteer/database";
import { expect, it, vi } from "vitest";
import { NotificationPreviewService } from "./notification-preview-service.js";

it("seals key material with the login binding and isolates unavailable vault records", async () => {
  const records: NotificationPreviewKeyRecord[] = [];
  const store = {
    register: async (input: Parameters<NotificationPreviewKeyStore["register"]>[0]) => {
      const existing = records.find((row) => row.installationId === input.installationId);
      if (existing) {
        records.splice(records.indexOf(existing), 1);
      }
      records.push({ ...input, createdAt: new Date(), updatedAt: new Date() });
    },
    eligible: async () => records,
  } as unknown as NotificationPreviewKeyStore;
  const vault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
  );
  const onError = vi.fn();
  const service = new NotificationPreviewService({
    store,
    vault,
    issuer: "https://accounts.invalid",
    onError,
  });
  const input = {
    userId: createId("user"),
    authSessionId: createId("authSession"),
    accountId: `acct_${crypto.randomUUID()}`,
    installationId: "test-installation",
    keyId: randomBytes(16).toString("base64url"),
    key: randomBytes(32).toString("base64url"),
  };
  await service.register(input);
  await service.register(input);
  expect(records[0]!.encryptedKey.toString()).not.toContain(input.key);
  expect(await service.keys(input.userId, [input.accountId])).toEqual([
    {
      accountId: input.accountId,
      installationId: input.installationId,
      keyId: input.keyId,
      key: input.key,
    },
  ]);
  await service.register({ ...input, installationId: "other-installation" });
  records[0] = { ...records[0]!, authSessionId: createId("authSession") };
  expect(await service.keys(input.userId, [input.accountId])).toHaveLength(1);
  expect(onError.mock.calls).toEqual([["notification-preview-key-unavailable"]]);
  const lostVault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(new Map([[2, randomBytes(32)]]), 2),
  );
  const lost = new NotificationPreviewService({
    store,
    vault: lostVault,
    issuer: "https://accounts.invalid",
    onError,
  });
  expect(await lost.keys(input.userId, [input.accountId])).toEqual([]);
});
