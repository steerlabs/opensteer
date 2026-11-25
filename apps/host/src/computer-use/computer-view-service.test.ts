import { DeviceIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { RunnerIdSchema, UserIdSchema, WindowIdSchema } from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core/models";
import { ComputerViewRemovedSchema } from "@opensteer/protocol";
import type {
  ComputerViewNativeResult,
  ComputerViewTarget,
  ComputerAppIdentity,
} from "@opensteer/protocol";
import { ComputerViewService } from "./computer-view-service.js";

const machine = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-000000000001");
const owner = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
const app: ComputerAppIdentity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: null,
};
const windowId = (id: number) =>
  WindowIdSchema.parse(`win_00000000-0000-4000-8000-${String(id).padStart(12, "0")}`);
const tabId = (id = 11) => `tab_${id}`;
function harness(phone = false) {
  const notices: unknown[] = [];
  let focused = 11;
  let approved = true;
  let access: "read" | "read-write" = "read";
  const sends: { operation: string; target: ComputerViewTarget }[] = [];
  let admission: (() => void) | undefined;
  let answer: Promise<void> | undefined;
  let openAnswer: Promise<void> | undefined;
  let wrongWindow = false;
  let inAdmission = false;
  let windowRequests = 0;
  let viewing: "supported" | "unsupported" | "unreported" = "supported";
  const logs: { event: string; details: Readonly<Record<string, unknown>> }[] = [];
  const service = new ComputerViewService({
    selfDeviceId: async (id: unknown) => DeviceIdSchema.parse(id),
    log: (event, details) => logs.push({ event, details }),
    connections: async () =>
      approved
        ? [
            {
              id: "notes",
              definitionId: phone ? "android-phone" : "macos-app",
              status: "connected",
              computer: { runnerId: machine, app: phone ? null : app, blockedAt: null, access },
            } as unknown as IntegrationConnectionSummary,
          ]
        : [],
    owners: async () => new Map([[machine, { effectiveOwner: owner }]]),
    changed: (_owner, notice) => notices.push(notice),
    hub: {
      attached: () => true,
      ownerViewSupported: () => viewing === "supported",
      ownerViewReported: () => viewing !== "unreported",
      ownerWindows: async () => {
        windowRequests++;
        await answer;
        return [11, 22].map((id) => ({ windowId: windowId(id), title: `Note ${id}` }));
      },
      withRunnerAdmission: async (_machine, run) => {
        admission?.();
        inAdmission = true;
        try {
          return await run();
        } finally {
          inAdmission = false;
        }
      },
      sendComputerView: async ({ request }) => {
        sends.push(request);
        if (request.operation === "open") await openAnswer;
        const id =
          request.target.kind === "app" ? Number(request.target.windowId.slice(-12)) : focused;
        return {
          kind: "ok" as const,
          value: {
            viewId: request.viewId,
            generation: request.generation,
            state: request.operation === "close" ? "closed" : "ready",
            captureTargetId: `capture-${id}`,
            window: { windowId: windowId(wrongWindow ? 22 : id), title: `Note ${id}` },
          } satisfies ComputerViewNativeResult,
        };
      },
    },
  });
  return {
    notices,
    service,
    setAccess: (next: "read" | "read-write") => {
      access = next;
    },
    sends,
    onAdmission: (callback: () => void) => {
      admission = callback;
    },
    wrongWindow: () => {
      wrongWindow = true;
    },
    holdOpen: (promise: Promise<void>) => {
      openAnswer = promise;
    },
    holdWindows: (promise: Promise<void>) => {
      answer = promise;
    },
    inAdmission: () => inAdmission,
    windowRequests: () => windowRequests,
    logs,
    focus: (id: number) => {
      focused = id;
    },
    revoke: () => {
      approved = false;
    },
    setViewing: (next: typeof viewing) => {
      viewing = next;
    },
    open: (window = focused, generation = 1) =>
      service.openForTab(
        owner,
        {
          computerId: machine,
          tabId: tabId(phone ? 0 : window),
          tabGeneration: generation,
          target: phone
            ? { kind: "phone", display: "main" }
            : { kind: "app", app, windowId: windowId(window) },
        },
        crypto.randomUUID(),
      ),
  };
}

describe("owner windows", () => {
  it("reports a device restart on the exact removed owner view and leaves ordinary disconnects unchanged", async () => {
    const h = harness();
    try {
      const view = await h.open();
      h.service.forgetRunner(machine, "device-restarting");
      expect(ComputerViewRemovedSchema.parse(h.notices.at(-1))).toEqual({
        type: "host.computer-view.removed",
        machineId: machine,
        viewId: view.viewId,
        generation: view.generation,
        reason: "disconnected",
        displayReason: "device-restarting",
      });
      const reopened = await h.open();
      expect(reopened.generation).toBeGreaterThan(view.generation);
      h.service.forgetRunner(machine);
      expect(ComputerViewRemovedSchema.parse(h.notices.at(-1))).not.toHaveProperty("displayReason");
    } finally {
      h.service.shutdown();
    }
  });

  it("deduplicates exact windows and preserves independent viewing generations", async () => {
    const h = harness();
    try {
      const a = await h.open();
      h.focus(22);
      const b = await h.open();
      expect(a.window).toEqual({ windowId: windowId(11), title: "Note 11" });
      expect(b.window?.windowId).toBe(windowId(22));
      expect(b.viewId).not.toBe(a.viewId);
      expect((await h.open(11)).viewId).toBe(a.viewId);
      await h.service.command(owner, {
        type: "computer.view.close",
        viewId: a.viewId,
        generation: a.generation,
        idempotencyKey: "close-a",
      });
      expect(
        (await h.service.list(owner, machine))
          .filter((v) => v.state === "ready")
          .map((v) => v.viewId),
      ).toEqual([b.viewId]);
      const reopened = await h.open(11);
      expect(reopened.window?.windowId).toBe(windowId(11));
      expect(reopened.generation).toBeGreaterThan(a.generation);
    } finally {
      h.service.shutdown();
    }
  });
  it("rechecks revocation in the admission turn before submitting a window-picker frame", async () => {
    const h = harness();
    h.onAdmission(h.revoke);
    try {
      await expect(h.service.windows(owner, machine, app)).rejects.toThrow(/approval/);
      expect(h.windowRequests()).toBe(0);
    } finally {
      h.service.shutdown();
    }
  });
  it("releases admission while awaiting the picker answer and rejects later revocation", async () => {
    const h = harness();
    let finish = () => {};
    h.holdWindows(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const result = h.service.windows(owner, machine, app);
    try {
      await vi.waitFor(() => expect(h.windowRequests()).toBe(1));
      expect(h.inAdmission()).toBe(false);
      h.revoke();
      finish();
      await expect(result).rejects.toThrow(/approval/);
    } finally {
      finish();
      await result.catch(() => undefined);
      h.service.shutdown();
    }
  });
  it("logs a refused window list by reason and bundle id, and a listed one not at all", async () => {
    const h = harness();
    try {
      expect(await h.service.windows(owner, machine, app)).toHaveLength(2);
      expect(h.logs).toEqual([]);
      h.revoke();
      await expect(h.service.windows(owner, machine, app)).rejects.toThrow(/approval/);
      expect(h.logs).toEqual([
        {
          event: "computer.app.windows",
          details: {
            machineId: machine,
            bundleId: app.bundleId,
            reason: "computer-view-not-approved",
          },
        },
      ]);
    } finally {
      h.service.shutdown();
    }
  });
  it("lists only an owner's exact approved app and rechecks revocation", async () => {
    const h = harness();
    try {
      expect(await h.service.windows(owner, machine, app)).toHaveLength(2);
      await expect(
        h.service.windows(
          UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000002"),
          machine,
          app,
        ),
      ).rejects.toThrow(/owner/);
      await expect(
        h.service.windows(owner, machine, { ...app, teamId: "replacement" }),
      ).rejects.toThrow(/approval/);
      h.revoke();
      await expect(h.service.windows(owner, machine, app)).rejects.toThrow(/approval/);
    } finally {
      h.service.shutdown();
    }
  });
});

describe("independent Mac control authorization", () => {
  it("answers a Mac that has not yet reported since it connected as connecting, never as unable to show views", async () => {
    const h = harness();
    try {
      // Between a Mac's reconnect and its first status, the Home does not know its versions:
      // the page retries an unavailable view, and stops for good on an unsupported one.
      h.setViewing("unreported");
      await expect(h.open(11)).rejects.toMatchObject({ reason: "computer-view-unavailable" });
      h.setViewing("unsupported");
      await expect(h.open(11)).rejects.toMatchObject({ reason: "computer-view-unsupported" });
      h.setViewing("supported");
      await expect(h.open(11)).resolves.toMatchObject({ state: "ready" });
    } finally {
      h.service.shutdown();
    }
  });

  it("requires the effective owner and a current read-write app approval", async () => {
    const h = harness();
    try {
      const view = await h.open(11);
      const source = {
        kind: "owner-view" as const,
        viewId: view.viewId,
        generation: view.generation,
      };
      await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
      h.setAccess("read-write");
      await expect(h.service.authorizeInput(source, owner)).resolves.toEqual({
        deviceId: machine,
        route: undefined,
      });
      h.setAccess("read");
      await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
      h.revoke();
      await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
    } finally {
      h.service.shutdown();
    }
  });
});

it("says a view left with its phone's tab, and only then", async () => {
  const h = harness(true);
  try {
    const removal = { type: "host.computer-view.removed", reason: "closed" };
    const first = await h.open();
    await h.service.command(owner, {
      type: "computer.view.close",
      viewId: first.viewId,
      generation: first.generation,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(h.notices.at(-1)).toMatchObject(removal);
    expect(h.notices.at(-1)).not.toHaveProperty("tabClosed");
    await h.open();
    await h.service.closeTabViews(owner, tabId(0), 1);
    expect(h.notices.at(-1)).toMatchObject(removal);
    expect(h.notices.at(-1)).not.toHaveProperty("tabClosed");
  } finally {
    h.service.shutdown();
  }
});

it("refuses an open waiting when its phone's tab closed, and only that one", async () => {
  const h = harness(true);
  try {
    const waiting = h.open();
    await h.service.closeTabViews(owner, tabId(0), 1);
    await expect(waiting).rejects.toMatchObject({ reason: "computer-view-ended" });
    expect(h.service.holdsPhoneView(machine)).toBe(false);

    await h.open(0, 2);
    expect(h.service.holdsPhoneView(machine)).toBe(true);
  } finally {
    h.service.shutdown();
  }
});

it("keeps phone viewing live while read-write approval alone controls input", async () => {
  const h = harness(true);
  try {
    const view = await h.open();
    const source = {
      kind: "owner-view" as const,
      viewId: view.viewId,
      generation: view.generation,
    };
    await expect(h.service.authorizeDisplay(source, owner)).resolves.toEqual({
      deviceId: machine,
      route: undefined,
    });
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow(/read-write/);
    h.setAccess("read-write");
    await expect(h.service.authorizeInput(source, owner)).resolves.toEqual({
      deviceId: machine,
      route: undefined,
    });
    h.setAccess("read");
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow(/read-write/);
    await expect(h.service.authorizeDisplay(source, owner)).resolves.toEqual({
      deviceId: machine,
      route: undefined,
    });
    h.revoke();
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
  } finally {
    h.service.shutdown();
  }
});

it("rejects a native reply for a different exact window", async () => {
  const h = harness();
  h.wrongWindow();
  try {
    await expect(h.open(11)).rejects.toMatchObject({ reason: "computer-view-unavailable" });
  } finally {
    h.service.shutdown();
  }
});

it("discards a window view response after its tab generation closed", async () => {
  const h = harness();
  const answer = Promise.withResolvers<void>();
  h.holdOpen(answer.promise);
  const opening = h.open(11);
  try {
    await vi.waitFor(() => expect(h.sends, "Native open was not dispatched").toHaveLength(1), {
      timeout: 1000,
    });
    await h.service.closeTabViews(owner, tabId(11), 1);
    answer.resolve();
    await expect(opening).rejects.toMatchObject({ reason: "computer-view-ended" });
    expect(await h.service.list(owner, machine)).toEqual([]);
    expect(h.notices).not.toContainEqual(
      expect.objectContaining({
        type: "host.computer-view.changed",
        view: expect.objectContaining({ state: "ready" }),
      }),
    );
    const reopened = await h.open(11, 2);
    expect(reopened.window?.windowId).toBe(windowId(11));
    await h.service.closeTabViews(owner, tabId(11), 1);
    expect(await h.service.list(owner, machine)).toEqual([reopened]);
    const sibling = await h.open(22);
    await h.service.closeTabViews(owner, tabId(11), 2);
    expect(await h.service.list(owner, machine)).toEqual([sibling]);
  } finally {
    answer.resolve();
    await opening.catch(() => undefined);
    h.service.shutdown();
  }
});

it("keeps owner views on separate Devices and refuses a replaced driver generation", async () => {
  const { createId } = await import("@opensteer/core");
  const { RunnerAuxiliaryFrameFenceSchema } = await import("@opensteer/protocol");
  const first = DeviceIdSchema.parse(createId("device"));
  const second = DeviceIdSchema.parse(createId("device"));
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    runnerId: machine,
    module: "integrations",
    bootId: `rbt_${globalThis.crypto.randomUUID()}`,
    auxiliaryStreamId: `rax_${globalThis.crypto.randomUUID()}`,
    connectionGeneration: 1,
    connectionId: `rcn_${globalThis.crypto.randomUUID()}`,
    connectionLeaseId: `rls_${globalThis.crypto.randomUUID()}`,
  });
  let generation = 1;
  const service = new ComputerViewService({
    owners: async (ids) => new Map(ids.map((id) => [id, { effectiveOwner: owner }])),
    connections: async () =>
      [first, second].map((deviceId) => ({
        id: `connection:${deviceId}`,
        definitionId: "iphone-screen",
        status: "connected",
        displayName: "iPhone",
        computer: { deviceId, app: null, blockedAt: null, access: "read" },
      })) as unknown as import("@opensteer/integration-core").DeviceIntegrationConnectionSummary[],
    changed: () => undefined,
    hub: {
      attached: () => true,
      ownerViewReported: () => true,
      ownerViewSupported: () => true,
      withRunnerAdmission: async (_id, action) => action(),
      withDeviceAdmission: async (_id, action) => action(),
      captureRoute: async (id) => ({
        deviceId: DeviceIdSchema.parse(id),
        runnerId: machine,
        generation: id === first ? generation : 1,
        role: "screen",
        auxiliaryFence: fence,
      }),
      routeCurrent: (route) => route.generation === (route.deviceId === first ? generation : 1),
      ownerWindows: async () => [],
      sendComputerView: async ({ request }) => ({
        kind: "ok",
        value: {
          viewId: request.viewId,
          generation: request.generation,
          state: request.operation === "close" ? "closed" : "ready",
          captureTargetId: null,
        },
      }),
    },
  });
  const open = (computerId: typeof first) =>
    service.openForTab(
      owner,
      {
        computerId,
        target: { kind: "phone", display: "main" },
        tabId: `tab:${computerId}`,
        tabGeneration: 1,
      },
      globalThis.crypto.randomUUID(),
    );
  try {
    const a = await open(first);
    const b = await open(second);
    expect(a.driverGeneration).toBe(1);
    expect(b.driverGeneration).toBe(1);
    const source = { kind: "owner-view" as const, viewId: a.viewId, generation: a.generation };
    await expect(service.authorizeDisplay(source, owner)).resolves.toMatchObject({
      deviceId: first,
      route: { runnerId: machine, generation: 1 },
    });
    await expect(service.authorizeInput(source, owner)).rejects.toThrow(/read-write/);
    generation = 2;
    await expect(service.authorizeDisplay(source, owner)).rejects.toThrow(/ended/);
    expect((await service.list(owner, second))[0]?.viewId).toBe(b.viewId);
    const fresh = await open(first);
    expect(fresh.generation).toBeGreaterThan(a.generation);
    expect(fresh.driverGeneration).toBe(2);
    service.forgetDriver({ deviceId: first, role: "screen", runnerId: machine, generation: 1 });
    await expect(
      service.authorizeDisplay(
        { kind: "owner-view", viewId: fresh.viewId, generation: fresh.generation },
        owner,
      ),
    ).resolves.toMatchObject({ deviceId: first, route: { generation: 2 } });

    service.forgetDevice(first);
    expect((await service.list(owner, second))[0]?.viewId).toBe(b.viewId);
    service.forgetRunner(machine);
    expect(await service.list(owner, second)).toEqual([]);
  } finally {
    service.shutdown();
  }
});
