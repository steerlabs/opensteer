import { createId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { type SavedHostView } from "@opensteer/client/host";
import { afterEach, expect, it, vi } from "vitest";
import { savedViewFixture } from "../../test-support/saved-views.js";
import { SavedViewCache } from "./saved-view-cache.js";
import { createPersonalSessionStore } from "./personal-session-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { MemorySecureStore } from "../platform/memory-secure-store.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const view = (): SavedHostView => ({
  schema: 1,
  epoch: hostApiVersion,
  hostIdentity: {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
  },
  loginId: globalThis.crypto.randomUUID(),
  userId: createId("user"),
  capturedAt: new Date().toISOString(),
  tasks: [],
});
it("persists denial before deletion, misses across restart, and clears only after successful deletion", async () => {
  const f = savedViewFixture(cleanup),
    value = view(),
    files = new MemoryPrivateFilesystem();
  const marker = `/private/denials/${value.hostIdentity.deploymentId}.deny`;
  const open = () => new SavedViewCache({ store: f.open(), files, directory: "/private/denials" });
  await f.open().write(value, () => true);
  f.keys.interrupt = (step) => {
    if (step.startsWith("delete:")) {
      expect(files.text(marker)).toBe("");
      throw new Error("locked");
    }
  };
  const first = open();
  const deleting = first.invalidate(value.hostIdentity.deploymentId);
  expect(files.text(marker)).toBe("");
  await deleting;
  expect(first.getFailure()).toMatch(/cleanup could not be completed/u);
  const restarted = open();
  expect(await restarted.load(value, () => true)).toBeNull();
  expect(f.keys.keys).toHaveLength(1);
  expect(files.text(marker)).toBe("");
  f.keys.interrupt = () => {};
  await restarted.retryInvalidation();
  expect(files.text(marker)).toBeNull();
  expect(f.keys.keys).toEqual([]);
  expect(await restarted.load(value, () => true)).toBeNull();
});
it("erases the key despite marker failure, misses immediately after restart, and retries the marker", async () => {
  const f = savedViewFixture(cleanup),
    value = view(),
    files = new MemoryPrivateFilesystem();
  await f.open().write(value, () => true);
  const write = vi.spyOn(files, "writeFileExclusive").mockRejectedValue(new Error("disk full"));
  const deletion = vi.spyOn(f.keys, "deleteItemAsync");
  const cache = new SavedViewCache({ store: f.open(), files, directory: "/private/denials" });
  await cache.invalidate(value.hostIdentity.deploymentId);
  expect(cache.isBlocked(value.hostIdentity.deploymentId)).toBe(true);
  expect(cache.getFailure()).toMatch(/cleanup could not be completed/u);
  expect(deletion).toHaveBeenCalledOnce();
  expect(f.keys.keys).toEqual([]);
  // Restart before storage is repaired or cleanup is retried.
  const restarted = new SavedViewCache({ store: f.open(), files, directory: "/private/denials" });
  expect(await restarted.load(value, () => true)).toBeNull();
  expect(await cache.load(value, () => true)).toBeNull();
  await cache.write(value, () => true);
  expect(f.keys.keys).toEqual([]);
  expect(cache.isPending(value.hostIdentity.deploymentId)).toBe(true);
  write.mockRestore();
  await cache.retryInvalidation();
  expect(cache.getFailure()).toBeNull();
  expect(f.keys.keys).toEqual([]);
});
it("misses across the credential/key crash boundary in either write order", async () => {
  const f = savedViewFixture(cleanup),
    value = view();
  const records = createSecureRecordStore({
    keyPrefix: "credential",
    secureStore: new MemorySecureStore(),
  });
  const sessions = createPersonalSessionStore(records);
  const session = {
    deploymentId: value.hostIdentity.deploymentId,
    viewLoginId: value.loginId,
    token: `${"a".repeat(43)}.${"b".repeat(43)}=`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    absoluteExpiresAt: "2099-02-01T00:00:00.000Z",
  };
  await sessions.save(session);
  const restartedSessions = () => createPersonalSessionStore(records);
  const load = async () =>
    f
      .open()
      .load(
        { ...value, loginId: (await restartedSessions().load(session.deploymentId))!.viewLoginId! },
        () => true,
      );
  await f.open().write(value, () => true);
  expect(await load()).toEqual(value);
  // A credential committed after key erasure, but before its replacement key:
  // the old ciphertext is still present and must not become readable.
  await f.keys.deleteItemAsync(f.keys.keys[0]!);
  const next = { ...value, loginId: globalThis.crypto.randomUUID() };
  await sessions.save({ ...session, viewLoginId: next.loginId });
  expect(f.list()).toHaveLength(1);
  expect(f.keys.keys).toEqual([]);
  expect(await load()).toBeNull();
  // Conversely, an existing key/ciphertext must not follow a newer credential ID.
  await f.open().write(next, () => true);
  expect(await load()).toEqual(next);
  await sessions.save({ ...session, viewLoginId: globalThis.crypto.randomUUID() });
  expect(f.keys.keys).toHaveLength(1);
  expect(await load()).toBeNull();
});
