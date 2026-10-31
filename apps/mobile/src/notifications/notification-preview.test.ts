import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { NotificationPreviews } from "./notification-preview.js";
import type { PushRegistration } from "./push-registration.js";
function fixture() {
  const native = {
    notificationPreviewVersion: 1,
    prepare: vi.fn(async () => {}),
    key: vi.fn(async () => ({ keyId: "key-id", key: "key" })),
    erase: vi.fn(async (_id: string | null) => {}),
  };
  const registeredAccountSubject = vi.fn(async () => "acct_00000000-0000-4000-8000-000000000001");
  const push = {
    registeredAccountSubject,
    getSnapshot: () => ({ status: "registered" }),
    installationId: async () => "install",
  } as unknown as PushRegistration;
  const controller = new NotificationPreviews(
    native,
    push,
    async () => "acct_00000000-0000-4000-8000-000000000001",
  );
  const dispatch = vi.fn(async (_command: unknown) => {});
  return {
    native,
    controller,
    dispatch,
    registeredAccountSubject,
    deploymentId: createId("deployment"),
  };
}
describe("private preview lifecycle", () => {
  it("does no key or RPC work for old Hosts", async () => {
    const f = fixture();
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: [],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.native.key).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does no key or RPC work for a different Account push subject", async () => {
    const f = fixture();
    f.registeredAccountSubject.mockResolvedValue("acct_00000000-0000-4000-8000-000000000002");
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.native.key).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("persists before registration and clears without remote work, even on erasure failure", async () => {
    const f = fixture();
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.dispatch).toHaveBeenCalledWith({
      type: "notification.preview.register",
      installationId: "install",
      accountId: "acct_00000000-0000-4000-8000-000000000001",
      keyId: "key-id",
      key: "key",
    });
    expect(f.native.key.mock.invocationCallOrder[0]).toBeLessThan(
      f.dispatch.mock.invocationCallOrder[0]!,
    );
    f.native.erase.mockRejectedValueOnce(new Error("locked"));
    f.dispatch.mockClear();
    await f.controller.clear(f.deploymentId);
    expect(f.native.erase).toHaveBeenCalledWith(f.deploymentId);
    await f.controller.reconcile();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("fences a key lookup across sign-out", async () => {
    const f = fixture();
    let release!: (key: { keyId: string; key: string }) => void;
    f.native.key.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    const clear = f.controller.clear(f.deploymentId);
    release({ keyId: "id", key: "key" });
    await clear;
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.native.erase).toHaveBeenCalledWith(f.deploymentId);
  });
  it("erases every Deployment on Account sign-out", async () => {
    const f = fixture();
    await f.controller.clear(null);
    expect(f.native.erase).toHaveBeenCalledWith(null);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("creates a key on a fresh authenticated attachment after sign-out", async () => {
    const f = fixture();
    await f.controller.clear(f.deploymentId);
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.native.erase.mock.invocationCallOrder[0]).toBeLessThan(
      f.native.key.mock.invocationCallOrder[0]!,
    );
    expect(f.dispatch).toHaveBeenCalled();
  });
  it("lands a registration still in flight before the next one after sign-out", async () => {
    const f = fixture();
    const landed: string[] = [];
    let releaseOld!: () => void;
    const oldDispatch = vi.fn(
      (command: { keyId: string }) =>
        new Promise<void>((resolve) => {
          releaseOld = () => {
            landed.push(command.keyId);
            resolve();
          };
        }),
    );
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: oldDispatch,
    });
    await vi.waitFor(() => expect(oldDispatch, "old registration never sent").toHaveBeenCalled(), {
      timeout: 1_000,
    });
    await f.controller.clear(null);
    f.native.key.mockResolvedValue({ keyId: "new-key-id", key: "new-key" });
    f.controller.attach({
      deploymentId: f.deploymentId,
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: async (command) => {
        landed.push(command.keyId);
      },
    });
    const fresh = f.controller.reconcile();
    // Let every queued continuation run: an unordered registration would land here.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseOld();
    await fresh;
    expect(landed).toEqual(["key-id", "new-key-id", "new-key-id"]);
  });
});
