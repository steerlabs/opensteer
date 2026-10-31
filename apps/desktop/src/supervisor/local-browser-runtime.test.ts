import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  prepare: vi.fn(async () => undefined),
  close: vi.fn(),
  runtime: vi.fn(),
  launcher: vi.fn(),
  start: vi.fn(async () => ({ host: "127.0.0.1", port: 1 })),
  serverClose: vi.fn(async () => undefined),
}));
vi.mock("../browser/electron-browser-launcher.js", () => ({
  ElectronBrowserLauncher: class {
    constructor(options: unknown) {
      fakes.launcher(options);
    }
    prepare = fakes.prepare;
    close = fakes.close;
  },
}));
vi.mock("@opensteer/browser-runtime-core", () => ({
  BrowserRuntime: class {
    constructor(options: unknown) {
      fakes.runtime(options);
    }
  },
  BrowserRuntimeServer: class {
    start = fakes.start;
    close = fakes.serverClose;
  },
  Ed25519AttachTicketVerifier: { create: async () => ({}) },
  HttpBrowserProfileStateClient: class {},
  defaultAttachTicketReplayLedgerPath: (root: string) => `${root}/replay`,
  sessionFilesRoot: (root: string) => `${root}/sessions`,
}));
import { startLocalBrowserRuntime } from "./local-browser-runtime.js";

describe("local browser composition", () => {
  it("prepares before advertising and passes the same durable root to engine and runtime", async () => {
    const order: string[] = [];
    fakes.prepare.mockImplementationOnce(async () => {
      order.push("prepare");
    });
    fakes.start.mockImplementationOnce(async () => {
      order.push("advertise");
      return { host: "127.0.0.1", port: 1 };
    });
    const handle = await startLocalBrowserRuntime({
      downloads: { accept: vi.fn() },
      pagePolicyPreloadPath: "/page.cjs",
      profileRoot: "/data/deployments/one/browser-profiles",
      runtimeId: "test",
    });
    expect(order).toEqual(["prepare", "advertise"]);
    expect(fakes.launcher).toHaveBeenCalledWith(
      expect.objectContaining({ localProfileRoot: "/data/deployments/one/browser-profiles" }),
    );
    expect(fakes.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        localProfiles: { root: "/data/deployments/one/browser-profiles" },
      }),
    );
    await handle.stop();
    expect(fakes.close).toHaveBeenCalled();
  });
  it("closes preparation resources if preparing fails", async () => {
    fakes.prepare.mockRejectedValueOnce(new Error("cannot prepare"));
    await expect(
      startLocalBrowserRuntime({
        downloads: { accept: vi.fn() },
        pagePolicyPreloadPath: "/page.cjs",
        profileRoot: "/data/browser-profiles",
        runtimeId: "test",
      }),
    ).rejects.toThrow("cannot prepare");
    expect(fakes.close).toHaveBeenCalled();
  });
});
