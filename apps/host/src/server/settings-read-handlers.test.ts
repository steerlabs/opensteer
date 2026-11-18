import { createId } from "@opensteer/core";
import { rpcSuccess, type MachineSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { createSettingsReadHandlers } from "./settings-read-handlers.js";
import { testHostApiContext } from "./test-host-api-context.js";

function fixture() {
  const owner = createId("user");
  const machines = vi.fn(async () => rpcSuccess({ machines: [] as MachineSummary[] }));
  return {
    owner,
    machines,
    handlers: createSettingsReadHandlers({ machines, otherDevices: async () => [] }),
  };
}

describe("Settings read projections", () => {
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

  it("requires a session before reading devices", async () => {
    const f = fixture();
    const context = { ...testHostApiContext(f.owner), session: null };
    await expect(f.handlers["devices.overview.get"]({}, context)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(f.machines).not.toHaveBeenCalled();
  });
});
