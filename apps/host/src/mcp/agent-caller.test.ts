import { createId, type Thread } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { AgentCallerResolver } from "./agent-caller.js";

function resolver(lineage: {
  readonly agentConnectionId: string | null;
  readonly taskOriginConnectionId: string | null;
}) {
  const userId = createId("user");
  const thread = {
    id: createId("thread"),
    environmentId: createId("environment"),
    accessMode: "auto",
  } as Thread;
  const claims = {
    runId: createId("run"),
    threadId: thread.id,
    environmentId: thread.environmentId,
    requestedBy: userId,
  };
  const store = {
    getThreadForOwner: vi.fn(async () => thread),
    admitExecution: vi.fn(async () => ({
      agentConnection: {
        agentConnectionId: "mcn_agent",
        grant: { scope: "everything" as const },
        grantRevision: 3,
        consentVersion: 2,
        accessMode: "full-access" as const,
      },
      mode: "approval-required" as const,
    })),
    bindingAgentConnectionId: vi.fn(async () => {
      throw new Error("The authenticating read already proved the lineage");
    }),
  };
  const callers = new AgentCallerResolver({
    store: store as never,
    runs: {
      authenticate: async () => {
        throw new Error("Use the read that proves the lineage");
      },
      authenticateExecution: async () => ({ claims: claims as never, lineage }),
    },
  });
  return { callers, store, thread };
}

it("authenticates the person's own Run from the read that authenticated it, with no other query", async () => {
  const { callers, store, thread } = resolver({
    agentConnectionId: null,
    taskOriginConnectionId: null,
  });
  expect(await callers.authenticate("run-token")).toMatchObject({
    kind: "run",
    accessMode: thread.accessMode,
  });
  expect(store.admitExecution).not.toHaveBeenCalled();
  expect(store.bindingAgentConnectionId).not.toHaveBeenCalled();
});

it("resolves a lineaged Run's full record, and refuses one whose lineage disagrees with its task", async () => {
  const lineaged = resolver({ agentConnectionId: "mcn_agent", taskOriginConnectionId: null });
  expect(await lineaged.callers.authenticate("run-token")).toMatchObject({
    accessMode: "approval-required",
    agentConnection: { agentConnectionId: "mcn_agent" },
  });
  expect(lineaged.store.admitExecution).toHaveBeenCalledOnce();
  const inconsistent = resolver({ agentConnectionId: null, taskOriginConnectionId: "mcn_agent" });
  await expect(inconsistent.callers.authenticate("run-token")).rejects.toThrow();
  expect(inconsistent.store.admitExecution).not.toHaveBeenCalled();
});

it("refuses a token whose execution ended before the caller's authority was folded", async () => {
  const userId = createId("user");
  const thread = {
    id: createId("thread"),
    environmentId: createId("environment"),
    accessMode: "full-access",
  } as Thread;
  const runId = createId("run");
  const admitExecution = vi.fn(async () => {
    throw new Error("Task authority is no longer available");
  });
  const callers = new AgentCallerResolver({
    store: { getThreadForOwner: async () => thread, admitExecution },
    runs: {
      authenticate: async () =>
        ({
          runId,
          threadId: thread.id,
          environmentId: thread.environmentId,
          requestedBy: userId,
        }) as never,
    },
  });
  await expect(callers.authenticate("already-ended")).rejects.toMatchObject({ code: "forbidden" });
  expect(admitExecution).toHaveBeenCalledWith({
    ownerUserId: userId,
    subject: { kind: "binding", bindingId: `run:${runId}` },
  });
});
