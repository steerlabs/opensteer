/**
 * Failure cases before implementation: approval accidentally becomes window-scoped;
 * omitted-window opens deduplicate before native resolution; explicit windows collapse;
 * a native answer binds another window; close/reopen loses binding; nonowners or
 * changed approvals enumerate windows; old clients cannot parse the projection.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunnerIdSchema, UserIdSchema } from "@opensteer/core";
import type { IntegrationConnectionSummary } from "@opensteer/integration-core";
import type {
  ComputerViewNativeResult,
  ComputerViewTarget,
  ComputerAppIdentity,
} from "@opensteer/protocol";
import { createHostApiHandlers } from "../server/host-api-handlers.js";
import { ComputerViewService } from "./computer-view-service.js";

const machine = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-000000000001");
const owner = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001");
const app: ComputerAppIdentity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: null,
};
function harness(phone = false) {
  let focused = 11;
  let approved = true;
  let access: "read" | "read-write" = "read";
  const sends: { operation: string; target: ComputerViewTarget }[] = [];
  let admission: (() => void) | undefined;
  let answer: Promise<void> | undefined;
  let inAdmission = false;
  let windowRequests = 0;
  const logs: { event: string; details: Readonly<Record<string, unknown>> }[] = [];
  const service = new ComputerViewService({
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
    changed: () => undefined,
    hub: {
      attached: () => true,
      ownerViewSupported: () => true,
      ownerWindows: async () => {
        windowRequests++;
        await answer;
        return [11, 22].map((id) => ({
          id,
          title: `Note ${id}`,
          focused: id === focused,
          main: id === 11,
          minimized: false,
          onScreen: true,
        }));
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
        const id = request.target.kind === "app" ? (request.target.window ?? focused) : focused;
        return {
          kind: "ok" as const,
          value: {
            viewId: request.viewId,
            generation: request.generation,
            state: request.operation === "close" ? "closed" : "ready",
            captureTargetId: `capture-${id}`,
            window: { id, title: `Note ${id}` },
          } satisfies ComputerViewNativeResult,
        };
      },
    },
  });
  const handlerArgs = [
    {},
    {},
    undefined,
    {},
    undefined,
    {},
    undefined,
    {},
    undefined,
    {},
    undefined,
    {},
    undefined,
    {},
    undefined,
    service,
  ] as unknown as Parameters<typeof createHostApiHandlers>;
  const handlers = createHostApiHandlers(...handlerArgs);
  const windows = async (user: typeof owner, runner: typeof machine, identity: typeof app) => {
    const context = { session: { user: { id: user } } } as unknown as Parameters<
      (typeof handlers)["computer.app.windows"]
    >[1];
    return handlers["computer.app.windows"]({ machineId: runner, app: identity }, context);
  };
  return {
    service,
    setAccess: (next: "read" | "read-write") => {
      access = next;
    },
    sends,
    onAdmission: (callback: () => void) => {
      admission = callback;
    },
    holdWindows: (promise: Promise<void>) => {
      answer = promise;
    },
    inAdmission: () => inAdmission,
    windowRequests: () => windowRequests,
    logs,
    windows,
    focus: (id: number) => {
      focused = id;
    },
    revoke: () => {
      approved = false;
    },
    open: (window?: number) =>
      service.command(owner, {
        type: "computer.view.open",
        machineId: machine,
        target: phone
          ? { kind: "phone", display: "main" }
          : { kind: "app", app, ...(window === undefined ? {} : { window }) },
        idempotencyKey: crypto.randomUUID(),
      }),
  };
}

describe("owner windows", () => {
  it("resolves omitted windows natively, deduplicates by binding, preserves independent generations", async () => {
    const h = harness();
    try {
      const a = await h.open();
      h.focus(22);
      const b = await h.open();
      expect(a.window).toEqual({ id: 11, title: "Note 11" });
      expect(b.window?.id).toBe(22);
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
      expect(reopened.window?.id).toBe(11);
      expect(reopened.generation).toBeGreaterThan(a.generation);
      // Previous clients strip added fields from their non-strict projection.
      const previous = z.object({
        viewId: z.string(),
        generation: z.number(),
        target: z.object({
          kind: z.literal("app"),
          app: z.object({
            bundleId: z.string(),
            displayName: z.string(),
            teamId: z.string().nullable(),
          }),
        }),
      });
      expect(previous.parse(b).target.app.bundleId).toBe(app.bundleId);
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
      expect(await h.windows(owner, machine, app)).toMatchObject({
        ok: true,
        data: { windows: expect.any(Array) },
      });
      expect(await h.service.windows(owner, machine, app)).toHaveLength(2);
      await expect(
        h.windows(UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000002"), machine, app),
      ).rejects.toThrow(/owner/);
      await expect(h.windows(owner, machine, { ...app, teamId: "replacement" })).rejects.toThrow(
        /approval/,
      );
      h.revoke();
      await expect(h.service.windows(owner, machine, app)).rejects.toThrow(/approval/);
    } finally {
      h.service.shutdown();
    }
  });
});

describe("independent Mac control authorization", () => {
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
      await expect(h.service.authorizeInput(source, owner)).resolves.toBe(machine);
      h.setAccess("read");
      await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
      h.revoke();
      await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
    } finally {
      h.service.shutdown();
    }
  });
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
    await expect(h.service.authorizeDisplay(source, owner)).resolves.toBe(machine);
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow(/read-write/);
    h.setAccess("read-write");
    await expect(h.service.authorizeInput(source, owner)).resolves.toBe(machine);
    h.setAccess("read");
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow(/read-write/);
    await expect(h.service.authorizeDisplay(source, owner)).resolves.toBe(machine);
    h.revoke();
    await expect(h.service.authorizeInput(source, owner)).rejects.toThrow();
  } finally {
    h.service.shutdown();
  }
});
