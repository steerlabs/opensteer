import { createId, type WaitingRequest } from "@opensteer/core";
import { rpcSuccess, type MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { createSettingsReadHandlers } from "./settings-read-handlers.js";
import { testHostApiContext } from "./test-host-api-context.js";

function fixture() {
  const owner = createId("user");
  const catalog = vi.fn(async () => [
    {
      definitionId: "gmail",
      title: "Gmail",
      description: "Mail",
      added: true,
      contents: [{ name: "Search mail", kind: "tool" as const }],
      access: ["Read mail"],
    },
  ]);
  const requests = vi.fn(async (_owner: typeof owner) => ({
    requests: [] as WaitingRequest[],
    window: { byteCount: 0, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
  }));
  const machines = vi.fn(async () => rpcSuccess({ machines: [] as MachineSummary[] }));
  return {
    owner,
    catalog,
    requests,
    machines,
    handlers: createSettingsReadHandlers({
      catalog,
      requests,
      machines,
      otherDevices: async () => [],
    }),
  };
}

describe("Settings read projections", () => {
  it("uses viewer-addressed Requests and retains real request identities and the window bound", async () => {
    const f = fixture();
    const requestId = createId("request");
    const install = {
      id: requestId,
      kind: "integration.install",
      presentation: { title: "Add Gmail" },
    };
    f.requests.mockResolvedValue({
      requests: [
        { request: install },
        { request: { ...install, id: createId("request"), kind: "harness.input" } },
      ] as unknown as WaitingRequest[],
      window: { byteCount: 1, hasMore: true, itemCount: 2, nextBefore: null, totalItems: 101 },
    });
    expect(await f.handlers["plugins.directory.get"]({}, testHostApiContext(f.owner))).toEqual(
      rpcSuccess({
        catalog: await f.catalog(),
        requests: [{ requestId, title: "Add Gmail" }],
        hasMoreRequests: true,
      }),
    );
    expect(f.requests).toHaveBeenCalledExactlyOnceWith(f.owner);
  });

  it("strips machine inventories from Devices without associating login sessions", async () => {
    const f = fixture();
    const machine = {
      id: createId("runner"),
      name: "Computer",
      device: null,
      ownership: "deployment",
      status: "offline",
      allowedModules: ["shell"],
      revocable: false,
      apps: [{ name: "Private app" }],
      access: {
        activeSessions: [],
        ownerReachAvailable: false,
        policy: { reach: "nobody", commands: false, forwarding: false, shares: [] },
        revision: 1,
      },
      computerUse: { private: true },
    };
    f.machines.mockResolvedValue(rpcSuccess({ machines: [machine as unknown as MachineSummary] }));
    const response = await f.handlers["devices.overview.get"]({}, testHostApiContext(f.owner));
    expect(response).toEqual(
      rpcSuccess({
        otherDevices: [],
        devices: [
          {
            id: machine.id,
            name: "Computer",
            device: null,
            ownership: "deployment",
            status: "offline",
            allowedModules: ["shell"],
            revocable: false,
            access: { policy: machine.access.policy, revision: 1 },
          },
        ],
      }),
    );
    expect(JSON.stringify(response)).not.toContain("private");
  });

  it("requires a session before reading either source", async () => {
    const f = fixture();
    const context = { ...testHostApiContext(f.owner), session: null };
    await expect(f.handlers["plugins.directory.get"]({}, context)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(f.handlers["devices.overview.get"]({}, context)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.requests).not.toHaveBeenCalled();
    expect(f.machines).not.toHaveBeenCalled();
  });
});
