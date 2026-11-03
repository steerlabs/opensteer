import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { expect, it, vi } from "vitest";
import type { ComputerAppHub, ComputerMcpSession } from "../computer-apps/computer-app-hub.js";
import { ComputerMcpTransport } from "./computer-mcp-transport.js";

it("checks exact-launch authority in admission, then releases admission while the Runner opens", async () => {
  const opening = Promise.withResolvers<ComputerMcpSession>();
  let admitted = false;
  const hub: Pick<ComputerAppHub, "withRunnerAdmission" | "openMcpSession"> = {
    withRunnerAdmission: async (_runner, work) => {
      admitted = true;
      try {
        return await work();
      } finally {
        admitted = false;
      }
    },
    openMcpSession: vi.fn(() => opening.promise),
  };
  const authorize = vi.fn(async () => {
    expect(admitted).toBe(true);
  });
  const transport = new ComputerMcpTransport(hub, {
    authorize,
    runnerId: createId("runner"),
    serverId: createIntegrationId("server"),
    launch: { type: "stdio", command: "program", args: [], cwd: "/tmp", env: {} },
    secrets: {},
  });
  const started = transport.start();
  await vi.waitFor(() => {
    expect(hub.openMcpSession).toHaveBeenCalledOnce();
    expect(admitted).toBe(false);
  });
  await transport.close();
  const close = vi.fn(async () => undefined);
  opening.resolve({ close, send: async () => undefined });
  await expect(started).rejects.toThrow("closed as it opened");
  expect(close).toHaveBeenCalledOnce();
});

it("sends no launch if the Host's exact-launch check fails at admission", async () => {
  const hub: Pick<ComputerAppHub, "withRunnerAdmission" | "openMcpSession"> = {
    withRunnerAdmission: async (_runner, work) => work(),
    openMcpSession: vi.fn(),
  };
  const transport = new ComputerMcpTransport(hub, {
    authorize: async () => {
      throw new Error("Launch changed");
    },
    runnerId: createId("runner"),
    serverId: createIntegrationId("server"),
    launch: { type: "stdio", command: "program", args: [], cwd: "/tmp", env: {} },
    secrets: {},
  });
  await expect(transport.start()).rejects.toThrow("Launch changed");
  expect(hub.openMcpSession).not.toHaveBeenCalled();
});
