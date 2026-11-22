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
