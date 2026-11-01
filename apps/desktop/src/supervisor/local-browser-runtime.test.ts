import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  prepare: vi.fn(async () => undefined),
  nativeProfilesAvailable: true,
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
    get nativeProfilesAvailable() {
      return fakes.nativeProfilesAvailable;
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
    const directory = await mkdtemp(path.join(tmpdir(), "local-browser-composition-"));
    const profileRoot = path.join(directory, "alias");
    await symlink(directory, profileRoot);
    const canonical = await realpath(directory);
    const handle = await startLocalBrowserRuntime({
      downloads: { accept: vi.fn() },
      pagePolicyPreloadPath: "/page.cjs",
      profileRoot,
      runtimeId: "test",
    });
    expect(order).toEqual(["prepare", "advertise"]);
    expect(fakes.launcher).toHaveBeenCalledWith(
      expect.objectContaining({ localProfileRoot: canonical }),
    );
    expect(fakes.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        localProfiles: { root: canonical },
      }),
    );
    await handle.stop();
    expect(fakes.close).toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });
  it("advertises Guest and legacy only when native-profile encryption is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-browser-composition-"));
    fakes.nativeProfilesAvailable = false;
    try {
      const handle = await startLocalBrowserRuntime({
        downloads: { accept: vi.fn() },
        pagePolicyPreloadPath: "/page.cjs",
        profileRoot: directory,
        runtimeId: "guest-only",
      });
      try {
        expect(fakes.runtime.mock.calls.at(-1)![0]).not.toHaveProperty("localProfiles");
        expect(fakes.start).toHaveBeenCalled();
      } finally {
        await handle.stop();
      }
    } finally {
      fakes.nativeProfilesAvailable = true;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("closes preparation resources if preparing fails", async () => {
    fakes.prepare.mockRejectedValueOnce(new Error("cannot prepare"));
    const directory = await mkdtemp(path.join(tmpdir(), "local-browser-composition-"));
    await expect(
      startLocalBrowserRuntime({
        downloads: { accept: vi.fn() },
        pagePolicyPreloadPath: "/page.cjs",
        profileRoot: directory,
        runtimeId: "test",
      }),
    ).rejects.toThrow("cannot prepare");
    await rm(directory, { recursive: true, force: true });
    expect(fakes.close).toHaveBeenCalled();
  });
});
