import { createId } from "@opensteer/core";
import { MachineSummarySchema, type MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { activityIdle, DesktopActivity, fencedIdle, type HomeHost } from "./desktop-activity.js";
import { AgentAdmission } from "./agent-admission.js";
import type { MenuBarInput } from "@opensteer/client/computers";
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

function machine(id: string, revision: number, selfRunnerId?: string): MachineSummary {
  return MachineSummarySchema.parse({
    id,
    ...(selfRunnerId ? { selfRunnerId } : {}),
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

const hostedHome: MenuBarHostedHome = {
  deploymentId: "dep_home",
  name: "MacBook Pro",
  state: "ready",
  runnerId,
};
const office = (runner: MenuBarDeviceHome["runner"] = "running"): MenuBarDeviceHome => ({
  deploymentId: "dep_office",
  name: "Office",
  runner,
  signedOut: false,
  runnerId,
});

function fakeHost(
  input: {
    revision?: number;
    conflict?: boolean;
    fail?: boolean;
    needsYou?: Readonly<Record<string, number | "unreachable">>;
    holdAttention?: boolean | string;
  } = {},
) {
  const state = {
    revision: input.revision ?? 4,
    fail: input.fail ?? false,
    /** The row this Mac's Runner has in the Home; another Device can take its place. */
    thisMacId: runnerId as string,
    listsThisMac: true,
  };
  const dispatched: unknown[] = [];
  const reads: { resolve: () => void }[] = [];
  let holdReads = false;
  const attention = (deploymentId: string) =>
    vi.fn(async () => {
      if (input.holdAttention === true || input.holdAttention === deploymentId)
        await new Promise<void>(() => undefined);
      const count = input.needsYou?.[deploymentId] ?? 0;
      if (count === "unreachable") throw new Error("Host unreachable");
      return { ok: true as const, data: { needsYou: count, unread: false } };
    }) as unknown as HomeHost["attention.get"];
  const hosts = new Map<string, HomeHost["attention.get"]>();
  const attentionFor = (deploymentId: string) => {
    const existing = hosts.get(deploymentId);
    if (existing) return existing;
    const created = attention(deploymentId);
    hosts.set(deploymentId, created);
    return created;
  };
  const host: Omit<HomeHost, "attention.get"> = {
    "machines.list": vi.fn(async () => {
      // A read answers with what the Host held when it began.
      const revision = state.revision;
      if (holdReads) await new Promise<void>((resolve) => reads.push({ resolve }));
      if (state.fail) throw new Error("Host unreachable");
      const thisMac =
        state.thisMacId === runnerId
          ? machine(runnerId, revision)
          : machine(state.thisMacId, revision, runnerId);
      return {
        ok: true as const,
        data: {
          machines: [machine(createId("runner"), 1), ...(state.listsThisMac ? [thisMac] : [])],
        },
      };
    }) as unknown as HomeHost["machines.list"],
    "personal.shell.get": vi.fn(async () => {
      if (state.fail) throw new Error("Host unreachable");
      return {
        ok: true as const,
        data: {
          tasks: [
            { id: "thr_flights", status: "running", title: "Book flights" },
            { id: "thr_done", status: "idle", title: "Done thing" },
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
    host: host as HomeHost,
    hostFor: (deploymentId: string): HomeHost => ({
      ...host,
      "attention.get": attentionFor(deploymentId),
    }),
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

type Local = MenuBarInput["local"];

function service(
  host: HomeHost | ((deploymentId: string) => HomeHost),
  input: {
    hosted?: MenuBarHostedHome | null;
    devices?: MenuBarDeviceHome[];
    selected?: string;
    local?: Local;
    stopRow?: (id: string) => Promise<boolean> | boolean;
    phase?: MenuBarInput["stop"]["phase"];
  } = {},
) {
  const local: Local = input.local ?? { apps: [], tabs: [] };
  return new DesktopMenuBarService({
    hostedHome: async () => (input.hosted === undefined ? hostedHome : input.hosted),
    deviceHomes: async () => input.devices ?? [],
    selected: () => ({ deploymentId: input.selected ?? "dep_home", devicesAvailable: true }),
    host: typeof host === "function" ? host : () => host,
    local: () => local,
    stop: () => ({ phase: input.phase ?? "running", stoppedAt: null, problem: null }),
    stopRow: input.stopRow ?? (() => false),
    openAtLogin: async () => ({ on: true, available: true }),
    log: vi.fn(),
  });
}

describe("menu bar state from this Mac alone", () => {
  it("draws the header, Right now and Stop with no Home read, and never waits for one", async () => {
    const fake = fakeHost({ holdAttention: true });
    fake.hold();
    const menu = service(fake.hostFor, {
      devices: [office("failed")],
      local: {
        apps: [{ sessionId: "cus_1", threadTitle: "Book flights", app: "Notes" }],
        tabs: [{ sessionId: "bsn_1", profile: true }],
      },
    });
    const reading = menu.refresh();
    const status = await menu.status();
    expect(status.homes.map((home) => home.status)).toEqual([
      "This Mac is your Home · Running",
      "Can’t reach Office",
    ]);
    expect(status.rightNow.map((row) => [row.actor.label, row.using])).toEqual([
      ["Book flights", "Notes"],
      ["An agent", "A browser profile"],
    ]);
    expect(status.stop.offline).toBe("Works even while Office is unreachable.");
    expect(status.needsYou).toBeNull();
    fake.release();
    void reading;
  });

  it("adds Needs you across the Homes that answer, and says nothing for one that does not", async () => {
    const both = fakeHost({ needsYou: { dep_home: 2, dep_office: 1 } });
    const menu = service(both.hostFor, { devices: [office()] });
    await menu.refresh();
    expect((await menu.status()).needsYou).toEqual({
      line: "3 need you",
      deploymentId: "dep_home",
      partial: false,
    });
    const unreachable = fakeHost({ needsYou: { dep_home: 0, dep_office: "unreachable" } });
    const quiet = service(unreachable.hostFor, { devices: [office()] });
    await quiet.refresh();
    const status = await quiet.status();
    expect(status.needsYou).toEqual({
      line: "Couldn’t check Office for what needs you",
      deploymentId: "dep_office",
      partial: true,
    });
  });

  it("shows each Home's count as it answers, as partial while another has not", async () => {
    const fake = fakeHost({ needsYou: { dep_home: 2 }, holdAttention: "dep_office" });
    const menu = service(fake.hostFor, { devices: [office()] });
    const changed = vi.fn();
    menu.subscribe(changed);
    void menu.refresh();
    await vi.waitFor(async () =>
      expect((await menu.status()).needsYou).toEqual({
        line: "At least 2 need you",
        deploymentId: "dep_home",
        partial: true,
      }),
    );
    expect(changed).toHaveBeenCalled();
  });

  it("forgets a Home's count once this Mac no longer works for it", async () => {
    const devices = [office()];
    const menu = service(fakeHost().hostFor, { hosted: null, devices });
    menu.noteNeedsYou("dep_office", 2);
    expect((await menu.status()).needsYou?.line).toBe("2 need you");
    devices.pop();
    expect((await menu.status()).needsYou).toBeNull();
    devices.push(office());
    expect((await menu.status()).needsYou).toBeNull();
  });

  it("draws the status item from what main holds, without reading a Home", async () => {
    let phase: MenuBarInput["stop"]["phase"] = "running";
    const fake = fakeHost({ holdAttention: true });
    const menu = new DesktopMenuBarService({
      hostedHome: () => new Promise(() => undefined),
      deviceHomes: () => new Promise(() => undefined),
      selected: () => null,
      host: fake.hostFor,
      local: () => ({ apps: [], tabs: [] }),
      stop: () => ({ phase, stoppedAt: null, problem: null }),
      stopRow: () => false,
      openAtLogin: () => new Promise(() => undefined),
      log: vi.fn(),
    });
    expect(menu.icon()).toEqual({ attention: false, unreachable: false, stopped: false });
    phase = "stopping";
    menu.noteNeedsYou("dep_home", 1);
    expect(menu.icon()).toEqual({ attention: true, unreachable: false, stopped: true });
  });

  it("takes the window's live count for the Home it shows, and redraws", async () => {
    const menu = service(fakeHost().hostFor);
    const changed = vi.fn();
    menu.subscribe(changed);
    menu.noteNeedsYou("dep_home", 1);
    menu.noteNeedsYou("dep_home", 1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await menu.status()).needsYou?.line).toBe("1 needs you");
    expect((await menu.status()).icon.attention).toBe(true);
  });

  it("stops one row the way its kind is stopped, and refuses one that already ended", async () => {
    const stopRow = vi.fn((id: string) => id === "apps:cus_1");
    const menu = service(fakeHost().hostFor, { stopRow });
    const changed = vi.fn();
    menu.subscribe(changed);
    await menu.stopRow("apps:cus_1");
    expect(stopRow).toHaveBeenCalledWith("apps:cus_1");
    expect(changed).toHaveBeenCalled();
    await expect(menu.stopRow("apps:cus_gone")).rejects.toThrow(/already ended/);
  });

  it("keeps a task of this Mac's Home as stopping while its Stop goes out, and failed when it did not", async () => {
    const fake = fakeHost();
    const sent = Promise.withResolvers<boolean>();
    let attempt = 0;
    const menu = service(fake.hostFor, {
      stopRow: () => (++attempt === 1 ? sent.promise : Promise.reject(new Error("unreachable"))),
    });
    await menu.refresh();
    const row = async () =>
      (await menu.status()).rightNow.find((candidate) => candidate.id === "home:thr_flights");
    expect(await row()).toMatchObject({ kind: "task", stoppable: true, state: "active" });
    const stopping = menu.stopRow("home:thr_flights");
    expect(await row()).toMatchObject({ state: "stopping" });
    sent.resolve(true);
    await stopping;
    await expect(menu.stopRow("home:thr_flights")).rejects.toThrow("unreachable");
    expect(await row()).toMatchObject({ state: "failed" });
  });

  it("keeps a Device's Run as stopping until its Runner no longer reports it", async () => {
    const runs = [
      { deploymentId: "dep_office", runId: "run_1", engine: "Codex", purpose: "task" as const },
    ];
    const menu = service(fakeHost().hostFor, {
      devices: [office()],
      local: { apps: [], tabs: [], runs } as Local,
      stopRow: () => true,
    });
    await menu.stopRow("runner:dep_office:run_1");
    expect((await menu.status()).rightNow[0]).toMatchObject({
      id: "runner:dep_office:run_1",
      state: "stopping",
    });
    runs.pop();
    expect((await menu.status()).rightNow).toEqual([]);
  });
});

describe("menu bar service", () => {
  it("shows the hosted Home's switches with the revision they were read at", async () => {
    const { host } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    const status = await menu.status();
    expect(status.thisMac).toMatchObject({
      deploymentId: "dep_home",
      editable: true,
      revision: 4,
      switches: [
        { capability: "browser", on: true },
        { capability: "apps", on: false },
        { capability: "files", on: true },
      ],
    });
    expect(status.rightNow.map((row) => row.actor.label)).toEqual(["Book flights"]);
  });

  it("writes a switch against the revision the person saw", async () => {
    const { host, dispatched } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    await menu.setSwitch({
      deploymentId: "dep_home",
      machineId: runnerId,
      capability: "apps",
      on: true,
      revision: 4,
    });
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "machine.access.update",
        deviceId: runnerId,
        expectedRevision: 4,
        policy: expect.objectContaining({ apps: true, reach: "owner" }),
      }),
    ]);
    expect((await menu.status()).thisMac?.revision).toBe(5);
  });

  it("refuses a click on switches older than what main has since read", async () => {
    const { host, dispatched, state } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    state.revision = 5;
    await menu.refresh();
    await expect(
      menu.setSwitch({
        deploymentId: "dep_home",
        machineId: runnerId,
        capability: "apps",
        on: true,
        revision: 4,
      }),
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
      machineId: runnerId,
      capability: "apps",
      on: true,
      revision: 4,
    });
    await vi.waitFor(() => expect(fake.dispatched).toHaveLength(1));
    fake.release();
    await stale;
    await writing;
    expect((await menu.status()).thisMac?.revision).toBe(5);
  });

  it("refuses a click on one Device's switch once another Device took its place at the same revision", async () => {
    const { host, dispatched, state } = fakeHost();
    const menu = service(host);
    await menu.refresh();
    const shown = (await menu.status()).thisMac;
    expect(shown?.machineId).toBe(runnerId);
    state.thisMacId = "rnr_replacement";
    await menu.refresh();
    expect((await menu.status()).thisMac).toMatchObject({
      machineId: "rnr_replacement",
      revision: 4,
    });
    await expect(
      menu.setSwitch({
        deploymentId: "dep_home",
        machineId: shown!.machineId,
        capability: "apps",
        on: true,
        revision: shown!.revision!,
      }),
    ).rejects.toThrow(switchConflictSentence);
    expect(dispatched).toEqual([]);
  });

  it("says when another device changed the switch first", async () => {
    const { host } = fakeHost({ conflict: true });
    const menu = service(host);
    await menu.refresh();
    await expect(
      menu.setSwitch({
        deploymentId: "dep_home",
        machineId: runnerId,
        capability: "files",
        on: false,
        revision: 4,
      }),
    ).rejects.toThrow(switchConflictSentence);
  });

  it("refuses a switch before the Host answered, or for a Home it did not read", async () => {
    const { host, dispatched } = fakeHost({ fail: true });
    const menu = service(host);
    await menu.refresh();
    await expect(
      menu.setSwitch({
        deploymentId: "dep_home",
        machineId: runnerId,
        capability: "apps",
        on: true,
        revision: 4,
      }),
    ).rejects.toThrow(/can’t be changed/);
    await expect(
      menu.setSwitch({
        deploymentId: "dep_other",
        machineId: runnerId,
        capability: "apps",
        on: true,
        revision: 4,
      }),
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
      local?: { appSessions: number; browserTabs: number; runs?: number };
    },
  ) =>
    new DesktopActivity({
      hostedHome: async () => (input.hosted === undefined ? hostedHome : input.hosted),
      deviceHomes: async () => input.devices ?? [],
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
    const idle = await activity(host, { hosted: null, devices: [office()] }).snapshot();
    expect(idle).toMatchObject({ known: true, lines: [] });
    expect(activityIdle(idle)).toBe(true);
  });

  it("reads every Home this Mac works for, whichever one the window shows", async () => {
    const { host } = fakeHost();
    const read = vi.fn((_deploymentId: string) => host);
    const snapshot = await new DesktopActivity({
      hostedHome: async () => hostedHome,
      deviceHomes: async () => [office(), { ...office(), deploymentId: "dep_lab", name: "Lab" }],
      host: read,
      local: () => ({ appSessions: 0, browserTabs: 0, runs: 1 }),
    }).snapshot();
    expect(read.mock.calls.map(([deploymentId]) => deploymentId)).toEqual([
      "dep_home",
      "dep_office",
      "dep_lab",
    ]);
    expect(snapshot).toMatchObject({
      known: true,
      deviceHomes: ["Office", "Lab"],
      lines: ["Running: Book flights", "A Device on this Mac is running a task"],
    });
  });

  it("is unknown when a Home does not list this Mac's Runner", async () => {
    const fake = fakeHost();
    fake.state.listsThisMac = false;
    const snapshot = await activity(fake.host, { hosted: null, devices: [office()] }).snapshot();
    expect(snapshot.known).toBe(false);
    expect(activityIdle(snapshot)).toBe(false);
  });

  it("is unknown when the Home cannot be read", async () => {
    const { host } = fakeHost({ fail: true });
    const snapshot = await activity(host, {}).snapshot();
    expect(snapshot.known).toBe(false);
  });

  it("fences the update's last look so nothing new starts before the restart", async () => {
    const admission = new AgentAdmission();
    admission.reopen();
    let openDuringLook: boolean | null = null;
    const busy = await fencedIdle(
      admission,
      () => false,
      async () => {
        openDuringLook = admission.open;
        return false;
      },
    );
    expect(openDuringLook).toBe(false);
    expect(busy.idle).toBe(false);
    expect(admission.open).toBe(true);

    const idle = await fencedIdle(
      admission,
      () => false,
      async () => true,
    );
    expect(idle.idle).toBe(true);
    expect(admission.open).toBe(false);
    idle.release();
    expect(admission.open).toBe(true);

    // A Stop the person pressed meanwhile is never undone by the update backing off.
    const stopped = await fencedIdle(
      admission,
      () => true,
      async () => false,
    );
    expect(stopped.idle).toBe(false);
    expect(admission.open).toBe(false);
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
  const plain = { attention: false, unreachable: false, stopped: false };
  const alpha = (bitmap: Buffer, x: number, y: number) => bitmap[(y * 32 + x) * 4 + 3];

  it("draws a disc, and a ring once stopped", () => {
    const running = menuBarGlyph(32, plain);
    const stopped = menuBarGlyph(32, { ...plain, stopped: true });
    expect(alpha(running, 16, 16)).toBe(255);
    expect(alpha(stopped, 16, 16)).toBe(0);
    expect(alpha(stopped, 16, 5)).toBe(255);
    expect(alpha(running, 0, 0)).toBe(0);
  });

  it("adds a slash, set apart from the disc, when no Home can be reached", () => {
    const slashed = menuBarGlyph(32, { ...plain, unreachable: true });
    expect(alpha(slashed, 16, 15)).toBe(255);
    expect(alpha(menuBarGlyph(32, plain), 18, 16)).toBe(255);
    expect(alpha(slashed, 18, 16)).toBe(0);
  });

  it("adds a small dot, set apart from the disc, when something needs the person", () => {
    const dotted = menuBarGlyph(32, { ...plain, attention: true });
    expect(alpha(menuBarGlyph(32, plain), 25, 25)).toBe(0);
    expect(alpha(dotted, 25, 25)).toBe(255);
    expect(alpha(menuBarGlyph(32, plain), 21, 21)).toBe(255);
    expect(alpha(dotted, 21, 21)).toBe(0);
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
