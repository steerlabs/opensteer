import { createId } from "@opensteer/core";
import { MachineSummarySchema, type MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { activityIdle, DesktopActivity, type HomeHost } from "./desktop-activity.js";
import {
  DesktopMenuBarService,
  switchConflictSentence,
  type MenuBarDeviceHome,
  type MenuBarHostedHome,
} from "./menu-bar-service.js";
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import {
  lockMenuBarNavigation,
  menuBarGlyph,
  menuBarPopoverBounds,
  menuBarPopoverSize,
  menuBarPopoverUrl,
  menuBarSenderAllowed,
} from "./menu-bar.js";

const runnerId = createId("runner");
const unreported = { checkedAt: null, detail: null, readiness: "unavailable" as const };

function machine(id: string, revision: number): MachineSummary {
  return MachineSummarySchema.parse({
    id,
    kind: "computer",
    name: "Studio",
    ownership: "mine",
    allowedModules: ["browser", "integrations", "shell"],
    modules: { browser: unreported, integrations: unreported, shell: unreported },
    capabilities: Object.fromEntries(
      ["browser", "apps", "files"].map((name) => [
        name,
        {
          supported: true,
          enabled: name !== "apps",
          configurable: true,
          state: name !== "apps" ? "ready" : "disabled",
          reason: name !== "apps" ? null : { kind: "access-off" },
        },
      ]),
    ),
    access: {
      activeSessions: [],
      ownerReachAvailable: true,
      revision,
      policy: { apps: false, reach: "owner", commands: true, forwarding: true, shares: [] },
    },
    detail: null,
    device: { form: "laptop", platform: "macos" },
    enrollmentId: null,
    expiresAt: null,
    lastSeenAt: null,
    revocable: true,
    status: "online",
  });
}

const hostedHome: MenuBarHostedHome = { deploymentId: "dep_home", state: "ready", runnerId };
const office = (runner: MenuBarDeviceHome["runner"] = "running"): MenuBarDeviceHome => ({
  deploymentId: "dep_office",
  name: "Office",
  runner,
  signedOut: false,
  runnerId,
});

function fakeHost(input: { revision?: number; conflict?: boolean; fail?: boolean } = {}) {
  const state = { revision: input.revision ?? 4, fail: input.fail ?? false };
  const dispatched: unknown[] = [];
  const reads: { resolve: () => void }[] = [];
  let holdReads = false;
  const host: HomeHost = {
    "machines.list": vi.fn(async () => {
      // A read answers with what the Host held when it began.
      const revision = state.revision;
      if (holdReads) await new Promise<void>((resolve) => reads.push({ resolve }));
      if (state.fail) throw new Error("Host unreachable");
      return {
        ok: true as const,
        data: { machines: [machine(createId("runner"), 1), machine(runnerId, revision)] },
      };
    }) as unknown as HomeHost["machines.list"],
    "personal.shell.get": vi.fn(async () => {
      if (state.fail) throw new Error("Host unreachable");
      return {
        ok: true as const,
        data: {
          tasks: [
            { status: "running", title: "Book flights" },
            { status: "idle", title: "Done thing" },
          ],
        },
      };
    }) as unknown as HomeHost["personal.shell.get"],
    "commands.dispatch": vi.fn(async (command: unknown) => {
      dispatched.push(command);
      if (input.conflict)
        return { ok: true as const, data: { type: "machine.access.update", outcome: "conflict" } };
      state.revision += 1;
      return {
        ok: true as const,
        data: { type: "machine.access.update", outcome: "updated", revision: state.revision },
      };
    }) as unknown as HomeHost["commands.dispatch"],
  };
  return {
    host,
    dispatched,
    state,
    hold: () => {
      holdReads = true;
    },
    release: () => {
      holdReads = false;
      for (const read of reads.splice(0)) read.resolve();
    },
  };
}

function service(
  host: HomeHost,
  input: {
    hosted?: MenuBarHostedHome | null;
    devices?: MenuBarDeviceHome[];
    selected?: string;
  } = {},
) {
  return new DesktopMenuBarService({
    hostedHome: async () => (input.hosted === undefined ? hostedHome : input.hosted),
    deviceHomes: async () => input.devices ?? [],
    selected: () => ({ deploymentId: input.selected ?? "dep_home", devicesAvailable: true }),
    host: () => host,
    local: () => ({ appSessions: 0, browserTabs: 0 }),
    stop: () => ({ stopped: false, problem: null }),
    openAtLogin: async () => ({ on: true, available: true }),
    log: vi.fn(),
  });
}

describe("menu bar service", () => {
  it("shows the hosted Home's switches with the revision they were read at", async () => {
    const { host } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    const status = await menu.status();
    expect(status.homes[0]).toMatchObject({
      role: "home",
      editable: true,
      revision: 4,
      switches: [
        { capability: "browser", on: true },
        { capability: "apps", on: false },
        { capability: "files", on: true },
      ],
    });
    expect(status.activity).toEqual(["Running: Book flights"]);
  });

  it("writes a switch against the revision the person saw", async () => {
    const { host, dispatched } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    await menu.setSwitch({ deploymentId: "dep_home", capability: "apps", on: true, revision: 4 });
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "machine.access.update",
        deviceId: runnerId,
        expectedRevision: 4,
        policy: expect.objectContaining({ apps: true, reach: "owner" }),
      }),
    ]);
    expect((await menu.status()).homes[0]?.revision).toBe(5);
  });

  it("refuses a click on switches older than what main has since read", async () => {
    const { host, dispatched, state } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    state.revision = 5;
    await menu.refresh();
    await expect(
      menu.setSwitch({ deploymentId: "dep_home", capability: "apps", on: true, revision: 4 }),
    ).rejects.toThrow(switchConflictSentence);
    expect(dispatched).toEqual([]);
  });

  it("shows the result of a write from a read that began after it, not one already under way", async () => {
    const fake = fakeHost();
    const menu = service(fake.host);
    await menu.refresh();
    fake.hold();
    const stale = menu.refresh();
    await vi.waitFor(() => expect(fake.host["machines.list"]).toHaveBeenCalledTimes(2));
    const writing = menu.setSwitch({
      deploymentId: "dep_home",
      capability: "apps",
      on: true,
      revision: 4,
    });
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    fake.release();
    await stale;
    await writing;
    expect((await menu.status()).homes[0]?.revision).toBe(5);
  });

  it("says when another device changed the switch first", async () => {
    const { host } = fakeHost({ conflict: true });
    const menu = service(host);
    await menu.refresh();
    await expect(
      menu.setSwitch({ deploymentId: "dep_home", capability: "files", on: false, revision: 4 }),
    ).rejects.toThrow(switchConflictSentence);
  });

  it("refuses a switch before the Host answered, or for a Home it did not read", async () => {
    const { host, dispatched } = fakeHost({ fail: true });
    const menu = service(host);
    await menu.refresh();
    await expect(
      menu.setSwitch({ deploymentId: "dep_home", capability: "apps", on: true, revision: 4 }),
    ).rejects.toThrow(/can’t be changed/);
    await expect(
      menu.setSwitch({ deploymentId: "dep_other", capability: "apps", on: true, revision: 4 }),
    ).rejects.toThrow(/can’t be changed/);
    expect(dispatched).toEqual([]);
  });
});

describe("activity for quitting and updating", () => {
  const activity = (
    host: HomeHost,
    input: {
      hosted?: { deploymentId: string; runnerId: string } | null;
      devices?: MenuBarDeviceHome[];
      selected?: string | null;
      local?: { appSessions: number; browserTabs: number };
    },
  ) =>
    new DesktopActivity({
      hostedHome: async () => (input.hosted === undefined ? hostedHome : input.hosted),
      deviceHomes: async () => input.devices ?? [],
      selected: () => (input.selected === undefined ? "dep_home" : input.selected),
      host: () => host,
      local: () => input.local ?? { appSessions: 0, browserTabs: 0 },
    });

  it("reads the hosted Home's running tasks and what this Mac's apps and tabs are doing", async () => {
    const { host } = fakeHost();
    const snapshot = await activity(host, { local: { appSessions: 1, browserTabs: 0 } }).snapshot();
    expect(snapshot).toEqual({
      known: true,
      hostsHome: true,
      deviceHomes: [],
      lines: ["Running: Book flights", "An agent is using apps on this Mac"],
    });
    expect(activityIdle(snapshot)).toBe(false);
  });

  it("is idle only when everything was read and nothing is running", async () => {
    const { host } = fakeHost();
    const idle = await activity(host, {
      hosted: null,
      devices: [office()],
      selected: "dep_office",
    }).snapshot();
    expect(idle).toMatchObject({ known: true, lines: [] });
    expect(activityIdle(idle)).toBe(true);
  });

  it("is unknown, never idle, for the hosted Home while another Home is shown", async () => {
    const { host } = fakeHost();
    const snapshot = await activity(host, {
      devices: [office()],
      selected: "dep_office",
    }).snapshot();
    expect(snapshot.known).toBe(false);
    expect(activityIdle(snapshot)).toBe(false);
  });

  it("is unknown for a Device Runner working for a Home the window does not show", async () => {
    const { host } = fakeHost();
    const snapshot = await activity(host, {
      hosted: null,
      devices: [office(), { ...office(), deploymentId: "dep_lab", name: "Lab" }],
      selected: "dep_office",
    }).snapshot();
    expect(snapshot).toMatchObject({ known: false, deviceHomes: ["Office", "Lab"] });
  });

  it("is unknown when the Home cannot be read", async () => {
    const { host } = fakeHost({ fail: true });
    const snapshot = await activity(host, {}).snapshot();
    expect(snapshot.known).toBe(false);
  });
});

describe("menu bar popover", () => {
  const mainFrame = { url: menuBarPopoverUrl };
  const webContents = { mainFrame };
  const popover = {
    isDestroyed: () => false,
    webContents,
  } as unknown as Pick<BrowserWindow, "isDestroyed" | "webContents">;
  const event = (sender: unknown, senderFrame: { url: string } | null) =>
    ({ sender, senderFrame }) as unknown as Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;

  it("answers only its own top frame showing its own document", () => {
    expect(menuBarSenderAllowed(event(webContents, mainFrame), popover)).toBe(true);
    expect(menuBarSenderAllowed(event(webContents, { url: menuBarPopoverUrl }), popover)).toBe(
      false,
    );
    expect(menuBarSenderAllowed(event({}, mainFrame), popover)).toBe(false);
    expect(menuBarSenderAllowed(event(webContents, mainFrame), null)).toBe(false);
    mainFrame.url = "app://opensteer/index.html";
    expect(menuBarSenderAllowed(event(webContents, mainFrame), popover)).toBe(false);
    mainFrame.url = menuBarPopoverUrl;
  });

  it("never leaves its document", () => {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    lockMenuBarNavigation(contents as unknown as Pick<WebContents, "on" | "setWindowOpenHandler">);
    const navigate = (name: string, fields: object) => {
      const preventDefault = vi.fn();
      contents.emit(name, { preventDefault, ...fields });
      return preventDefault;
    };
    expect(navigate("will-navigate", { url: "app://opensteer/index.html" })).toHaveBeenCalled();
    expect(navigate("will-navigate", { url: menuBarPopoverUrl })).not.toHaveBeenCalled();
    expect(navigate("will-redirect", { url: menuBarPopoverUrl })).toHaveBeenCalled();
    expect(
      navigate("will-frame-navigate", { url: "https://example.com/", isMainFrame: false }),
    ).toHaveBeenCalled();
    expect(navigate("will-attach-webview", {})).toHaveBeenCalled();
    expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
  });
});

describe("menu bar item", () => {
  it("draws a disc, and a ring once stopped", () => {
    const alpha = (bitmap: Buffer, x: number, y: number) => bitmap[(y * 32 + x) * 4 + 3];
    const running = menuBarGlyph(32, false);
    const stopped = menuBarGlyph(32, true);
    expect(alpha(running, 16, 16)).toBe(255);
    expect(alpha(stopped, 16, 16)).toBe(0);
    expect(alpha(stopped, 16, 5)).toBe(255);
    expect(alpha(running, 0, 0)).toBe(0);
  });

  it("anchors the popover under the item and keeps it on the display", () => {
    const workArea = { x: 0, y: 25, width: 1440, height: 875 };
    expect(menuBarPopoverBounds({ x: 1000, y: 0, width: 24, height: 24 }, workArea)).toEqual({
      x: 1012 - menuBarPopoverSize.width / 2,
      y: 28,
      ...menuBarPopoverSize,
    });
    expect(menuBarPopoverBounds({ x: 1430, y: 0, width: 24, height: 24 }, workArea).x).toBe(
      1440 - menuBarPopoverSize.width - 8,
    );
  });
});
