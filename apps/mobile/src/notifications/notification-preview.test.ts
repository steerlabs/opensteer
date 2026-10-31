import { describe, expect, it, vi } from "vitest";
import { NotificationPreviews } from "./notification-preview.js";
import type { PushRegistration } from "./push-registration.js";
function fixture() {
  const native = {
    notificationPreviewVersion: 1,
    deployments: vi.fn(async () => ["dep"]),
    prepare: vi.fn(async () => {}),
    key: vi.fn(async () => ({ keyId: "key-id", key: "key" })),
    existing: vi.fn(async () => ({ keyId: "key-id", key: "key" })),
    erase: vi.fn(async (_id: string | null) => {}),
  };
  const push = {
    previewFailed: vi.fn(async () => {}),
    registeredAccountSubject: async () => "subject",
    getSnapshot: () => ({ status: "registered" }),
    installationId: async () => "install",
  } as unknown as PushRegistration;
  const controller = new NotificationPreviews(native, push, async () => "subject");
  const dispatch = vi.fn(async (_command: unknown) => {});
  return { native, controller, dispatch };
}
describe("private preview lifecycle", () => {
  it("does no key or RPC work for old Hosts", async () => {
    const f = fixture();
    f.controller.attach({
      deploymentId: "dep",
      capabilities: [],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.native.key).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("persists before registration and erases before unregister, even on erasure failure", async () => {
    const f = fixture();
    f.controller.attach({
      deploymentId: "dep",
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.dispatch).toHaveBeenCalledWith({
      type: "notification.preview.register",
      installationId: "install",
      accountId: "subject",
      keyId: "key-id",
      key: "key",
    });
    f.native.erase.mockRejectedValueOnce(new Error("locked"));
    await f.controller.clear("dep");
    expect(f.dispatch).toHaveBeenLastCalledWith({
      type: "notification.preview.unregister",
      installationId: "install",
      keyId: "key-id",
    });
    expect(f.native.erase.mock.invocationCallOrder[0]).toBeLessThan(
      f.dispatch.mock.invocationCallOrder.at(-1)!,
    );
    f.dispatch.mockClear();
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
      deploymentId: "dep",
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    const clear = f.controller.clear("dep");
    release({ keyId: "id", key: "key" });
    await clear;
    expect(
      f.dispatch.mock.calls.every(
        ([c]) => (c as { type: string }).type === "notification.preview.unregister",
      ),
    ).toBe(true);
  });
  it("erases every Deployment before attempting Account sign-out unregisters", async () => {
    const f = fixture();
    f.native.deployments.mockResolvedValue(["one", "two"]);
    const unregister = vi.fn(async (_id: string, _command: unknown) => {});
    f.controller.unregister = unregister;
    await f.controller.clear(null);
    expect(f.native.erase).toHaveBeenCalledWith(null);
    expect(unregister.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    expect(f.native.erase.mock.invocationCallOrder[0]).toBeLessThan(
      unregister.mock.invocationCallOrder[0]!,
    );
  });
  it("retries failed erasure before generating a fresh login key", async () => {
    const f = fixture();
    f.native.erase.mockRejectedValueOnce(new Error("locked"));
    await f.controller.clear("dep");
    f.controller.signedIn("dep");
    f.controller.attach({
      deploymentId: "dep",
      capabilities: ["notification-preview-v1"],
      current: () => true,
      dispatch: f.dispatch,
    });
    await f.controller.reconcile();
    expect(f.native.erase).toHaveBeenCalledTimes(2);
    expect(f.native.erase.mock.invocationCallOrder[1]).toBeLessThan(
      f.native.key.mock.invocationCallOrder[0]!,
    );
  });
});
