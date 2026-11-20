import { createId } from "@opensteer/core";
import { MachineSummarySchema, type MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopMenuBarService,
  type MenuBarDeviceHome,
  type MenuBarHost,
  type MenuBarHostedHome,
} from "./menu-bar-service.js";
import { menuBarGlyph, menuBarPopoverBounds, menuBarPopoverSize } from "./menu-bar.js";

const runnerId = createId("runner");
const unreported = { checkedAt: null, detail: null, readiness: "unavailable" as const };

function machine(id: string, revision = 4): MachineSummary {
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

function fixture(input: {
  readonly hosted?: MenuBarHostedHome | null;
  readonly devices?: readonly MenuBarDeviceHome[];
  readonly selected?: string | null;
  readonly conflict?: boolean;
}) {
  const dispatched: unknown[] = [];
  const host: MenuBarHost = {
    "machines.list": vi.fn(async () => ({
      ok: true as const,
      data: { machines: [machine(createId("runner")), machine(runnerId)] },
    })) as unknown as MenuBarHost["machines.list"],
    "personal.shell.get": vi.fn(async () => ({
      ok: true as const,
      data: {
        tasks: [
          { status: "running", title: "Book flights" },
          { status: "idle", title: "Done thing" },
        ],
      },
    })) as unknown as MenuBarHost["personal.shell.get"],
    "commands.dispatch": vi.fn(async (command: unknown) => {
      dispatched.push(command);
      return {
        ok: true as const,
        data: input.conflict
          ? { type: "machine.access.update", outcome: "conflict" }
          : { type: "machine.access.update", outcome: "updated", revision: 5 },
      };
    }) as unknown as MenuBarHost["commands.dispatch"],
  };
  const local = { appSessions: 0, browserTabs: 0 };
  const service = new DesktopMenuBarService({
    hostedHome: async () => input.hosted ?? null,
    deviceHomes: async () => input.devices ?? [],
    selected: () =>
      input.selected === null
        ? null
        : { deploymentId: input.selected ?? "dep_home", devicesAvailable: true },
    host: () => host,
    local: () => local,
    stopped: () => false,
    openAtLogin: async () => true,
    log: vi.fn(),
  });
  return { dispatched, host, local, service };
}

describe("menu bar service", () => {
  it("shows the hosted Home's switches and running tasks from one owner read", async () => {
    const { host, service } = fixture({
      hosted: { deploymentId: "dep_home", state: "ready", runnerId },
    });
    const changed = vi.fn();
    service.subscribe(changed);
    await service.refresh();
    expect(changed).toHaveBeenCalled();
    const status = await service.status();
    expect(status.homes[0]).toMatchObject({
      role: "home",
      line: "This Mac is your Home — running",
      editable: true,
      switches: [
        { capability: "browser", on: true },
        { capability: "apps", on: false },
        { capability: "files", on: true },
      ],
    });
    expect(status.activity).toEqual(["Running: Book flights"]);
    expect(host["personal.shell.get"]).toHaveBeenCalledTimes(1);
    await expect(service.activeWork(false)).resolves.toBe(true);
  });

  it("reads only this Mac's row as a Device of the selected Home", async () => {
    const { host, service } = fixture({
      selected: "dep_office",
      devices: [
        {
          deploymentId: "dep_office",
          name: "Office",
          runner: "running",
          signedOut: false,
          runnerId,
        },
      ],
    });
    await service.refresh();
    const status = await service.status();
    expect(status.homes).toMatchObject([{ role: "device", line: "Connected to Office" }]);
    expect(status.homes[0]?.switches).toHaveLength(3);
    expect(status.activity).toEqual([]);
    expect(host["personal.shell.get"]).not.toHaveBeenCalled();
  });

  it("writes a switch as Devices does: this Mac's row, its revision, one changed field", async () => {
    const { dispatched, service } = fixture({
      hosted: { deploymentId: "dep_home", state: "ready", runnerId },
    });
    await service.refresh();
    await service.setSwitch({ deploymentId: "dep_home", capability: "apps", on: true });
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "machine.access.update",
        deviceId: runnerId,
        expectedRevision: 4,
        policy: expect.objectContaining({ apps: true, reach: "owner" }),
      }),
    ]);
  });

  it("says when another device changed the switch first", async () => {
    const { service } = fixture({
      hosted: { deploymentId: "dep_home", state: "ready", runnerId },
      conflict: true,
    });
    await service.refresh();
    await expect(
      service.setSwitch({ deploymentId: "dep_home", capability: "files", on: false }),
    ).rejects.toThrow(/changed on another device/);
  });

  it("refuses a switch before the Host answered", async () => {
    const { service } = fixture({ selected: null });
    await service.refresh();
    await expect(
      service.setSwitch({ deploymentId: "dep_home", capability: "apps", on: true }),
    ).rejects.toThrow(/still loading/);
  });

  it("tells a full quit what would stop", async () => {
    const { local, service } = fixture({
      hosted: { deploymentId: "dep_home", state: "ready", runnerId },
      devices: [
        {
          deploymentId: "dep_office",
          name: "Office",
          runner: "running",
          signedOut: false,
          runnerId,
        },
      ],
    });
    local.appSessions = 1;
    await expect(service.quitWork()).resolves.toEqual({
      hostsHome: true,
      deviceHomes: ["Office"],
      activity: ["Running: Book flights", "An agent is using apps on this Mac"],
    });
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
