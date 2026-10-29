import { createId, type RunnerId, type UserId } from "@opensteer/core";
import type { HostToClientMessage, ShellSessionSummary } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { machineAccessNotifier } from "./machine-access-events.js";

function summary(): ShellSessionSummary {
  return {
    bytesIn: 12,
    bytesOut: 34,
    callerMachineName: "cloud-1",
    id: `shs_${globalThis.crypto.randomUUID()}` as ShellSessionSummary["id"],
    requestedBy: createId("user"),
    runId: createId("run"),
    startedAt: "2026-09-13T12:00:00.000Z",
    threadId: createId("thread"),
    threadTitle: "Fix the deploy",
  };
}

function notifierFor(input: {
  readonly connected: readonly UserId[];
  readonly ownerKind: "deployment" | "user";
  readonly effectiveOwner: UserId | null;
  readonly administrators?: readonly UserId[];
}) {
  const delivered: { readonly message: HostToClientMessage; readonly userIds: UserId[] }[] = [];
  const notifier = machineAccessNotifier({
    onError: vi.fn(),
    realtime: {
      connectedUserIds: () => input.connected,
      sendToUsers: (userIds, message) => delivered.push({ message, userIds: [...userIds] }),
    },
    store: {
      effectiveMachineOwner: async () => ({
        effectiveOwner: input.effectiveOwner,
        ownerKind: input.ownerKind,
      }),
      userById: async (userId: UserId) => ({
        disabledAt: null,
        instanceRole: input.administrators?.includes(userId) ? "administrator" : "user",
      }),
    } as never,
  });
  return { delivered, notifier };
}

describe("machine access session notifications", () => {
  it("reaches administrators only for a computer the Deployment itself owns", async () => {
    const administrator = createId("user");
    const member = createId("user");
    const runnerId: RunnerId = createId("runner");
    const owned = notifierFor({
      administrators: [administrator],
      connected: [administrator, member],
      effectiveOwner: null,
      ownerKind: "deployment",
    });
    const someonesMachine = notifierFor({
      administrators: [administrator],
      connected: [administrator, member],
      effectiveOwner: member,
      ownerKind: "user",
    });
    const session = summary();

    owned.notifier.ended({ endReason: "run-ended", runnerId, session });
    someonesMachine.notifier.ended({ endReason: "run-ended", runnerId, session });
    await vi.waitFor(() => {
      expect(owned.delivered).toHaveLength(1);
      expect(someonesMachine.delivered).toHaveLength(1);
    });

    expect(owned.delivered[0]?.userIds).toEqual([administrator]);
    expect(owned.delivered[0]?.message).toEqual({
      endReason: "run-ended",
      runnerId,
      session,
      type: "host.machine.access.session.ended",
    });
    // An administrator manages nobody else's computer, whatever their role.
    expect(someonesMachine.delivered[0]?.userIds).toEqual([member]);
  });

  it("sends nothing when a revoked machine has no ownership left to check", async () => {
    const sendToUsers = vi.fn();
    const notifier = machineAccessNotifier({
      onError: vi.fn(),
      realtime: { connectedUserIds: () => [createId("user")], sendToUsers },
      store: { effectiveMachineOwner: async () => null, userById: async () => null } as never,
    });

    notifier.started({ runnerId: createId("runner"), session: summary() });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sendToUsers).not.toHaveBeenCalled();
  });
});
