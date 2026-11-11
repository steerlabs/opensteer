import { createId, type UserId } from "@opensteer/core";
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
  readonly disabled?: boolean;
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
      userById: async () => ({ disabledAt: input.disabled ? new Date() : null }),
    } as never,
  });
  return { delivered, notifier };
}

describe("machine access session notifications", () => {
  it.each(["deployment", "user"] as const)(
    "notifies only the personal owner for a %s computer",
    async (ownerKind) => {
      const owner = createId("user"),
        other = createId("user"),
        runnerId = createId("runner");
      const fixture = notifierFor({ connected: [owner, other], effectiveOwner: owner, ownerKind });
      const session = summary();
      await fixture.notifier.ended({ endReason: "run-ended", runnerId, session });
      expect(fixture.delivered).toEqual([
        {
          userIds: [owner],
          message: {
            endReason: "run-ended",
            runnerId,
            session,
            type: "host.machine.access.session.ended",
          },
        },
      ]);
    },
  );
  it("does not disclose a machine session after the owner is disabled", async () => {
    const owner = createId("user");
    const fixture = notifierFor({
      connected: [owner],
      effectiveOwner: owner,
      ownerKind: "user",
      disabled: true,
    });
    await fixture.notifier.started({ runnerId: createId("runner"), session: summary() });
    expect(fixture.delivered).toEqual([]);
  });
  it("sends nothing when a revoked machine has no ownership left to check", async () => {
    const sendToUsers = vi.fn();
    const notifier = machineAccessNotifier({
      onError: vi.fn(),
      realtime: { connectedUserIds: () => [createId("user")], sendToUsers },
      store: { effectiveMachineOwner: async () => null, userById: async () => null } as never,
    });

    await notifier.started({ runnerId: createId("runner"), session: summary() });

    expect(sendToUsers).not.toHaveBeenCalled();
  });
});
