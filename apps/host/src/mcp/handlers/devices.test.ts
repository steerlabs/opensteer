import { createId } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import type { AgentCaller } from "../agent-caller.js";
import { DeviceToolHandlers } from "./devices.js";

/** A Run's caller as the MCP authenticator resolves it: with its lineage's connection, if any. */
function runCall(agentConnection: boolean) {
  const runId = createId("run");
  const threadId = createId("thread");
  const caller = {
    kind: "run",
    key: `run:${runId}`,
    userId: createId("user"),
    accessMode: "full-access",
    claims: { runId, threadId },
    ...(agentConnection
      ? {
          agentConnection: {
            agentConnectionId: "mcn_lineage",
            grant: { scope: "everything" },
            grantRevision: 1,
            consentVersion: 2,
            accessMode: "full-access",
          },
        }
      : {}),
  } as unknown as AgentCaller;
  return { caller, input: { code: "await app('Notes')" }, operationKey: "op" } as never;
}

it("carries a lineage Run's connection to computer use, and nothing for the person's own Run", async () => {
  const runComputerCode = vi.fn(async (_caller: unknown) => ({ content: [] }));
  const handlers = new DeviceToolHandlers({
    devices: { computerToolEnabled: async () => true, runComputerCode } as never,
    access: {} as never,
  });
  await handlers.computer_use(runCall(true));
  await handlers.computer_use(runCall(false));
  expect(runComputerCode.mock.calls.map(([caller]) => caller)).toEqual([
    expect.objectContaining({ connectionWork: true }),
    expect.not.objectContaining({ connectionWork: expect.anything() }),
  ]);
});

it("refuses missing or unexpected app on computer_use before looking up the target", async () => {
  const sessionComputerTarget = vi.fn(async () => {
    throw new Error("should not look up target");
  });
  const handlers = new DeviceToolHandlers({
    devices: { sessionComputerTarget } as never,
    access: {} as never,
    sessions: {} as never,
  });
  const deviceId = createId("device");
  const baseCaller = {
    kind: "connection" as const,
    key: "connection:test",
    userId: createId("user"),
    connectionId: "agc_test",
    grantRevision: 1,
    accessMode: "full-access" as const,
  };
  const macOnly = {
    ...baseCaller,
    grant: {
      scope: "selected" as const,
      tasks: false,
      resources: [
        {
          kind: "computer-app" as const,
          deviceId,
          approvalId: "con_test",
          app: { kind: "mac-app" as const, bundleId: "com.apple.Notes", teamId: null },
        },
      ],
    },
  } as unknown as AgentCaller;
  const phoneOnly = {
    ...baseCaller,
    grant: {
      scope: "selected" as const,
      tasks: false,
      resources: [
        {
          kind: "computer-app" as const,
          deviceId,
          approvalId: "con_phone",
          app: { kind: "phone-screen" as const, definitionId: "iphone-screen" },
        },
      ],
    },
  } as unknown as AgentCaller;

  await expect(
    handlers.computer_use({
      caller: macOnly,
      input: { code: "help()", computerId: deviceId },
      operationKey: "k1",
    } as never),
  ).rejects.toMatchObject({ code: "bad_request" });

  await expect(
    handlers.computer_use({
      caller: phoneOnly,
      input: { code: "help()", computerId: deviceId, app: "Notes" },
      operationKey: "k2",
    } as never),
  ).rejects.toMatchObject({ code: "bad_request" });

  expect(sessionComputerTarget).not.toHaveBeenCalled();
});
