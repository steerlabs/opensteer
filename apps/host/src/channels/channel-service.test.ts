import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ChannelService } from "./channel-service.js";

const environmentId = createId("environment");
const otherEnvironmentId = createId("environment");
const offlineEnvironmentId = createId("environment");

function channelServiceFixture(
  options: {
    readonly pending?: number;
    readonly canonicalOrigin?: string;
  } = {},
) {
  const onExecutionQueued = vi.fn();
  let remaining = options.pending ?? 1;
  const channels = {
    nextIngressDeadline: vi.fn(async (_asOf: Date): Promise<Date | null> => null),
    pruneHistory: vi.fn(async () => undefined),
    claimIngress: vi.fn(async (_workerId: string, _asOf?: Date) =>
      remaining-- > 0
        ? {
            accountId: "cha_00000000-0000-4000-8000-000000000001",
            claimToken: "claim-token",
            event: {
              actor: { displayName: "Ada", externalUserId: "U1" },
              content: [{ text: "ship it", type: "text" }],
              occurredAt: new Date().toISOString(),
              provider: "slack",
              trigger: "mention",
            },
            id: "chi_00000000-0000-4000-8000-000000000001",
            receivedAt: new Date(),
          }
        : null,
    ),
  };
  const service = new ChannelService({
    channels: channels as never,
    credentials: {} as never,
    bridgeTools: () => ({ callTool: async () => ({}) }),
    relay: {} as never,
    store: {
      announceRevokedGrants: () => undefined,
      listEnvironments: async () => [
        { id: otherEnvironmentId, kind: "local", name: "Person's Mac" },
        { id: offlineEnvironmentId, kind: "managed", name: "Asleep" },
        { id: environmentId, kind: "managed", name: "Managed Runner" },
      ],
    } as never,
  });
  return { channels, onExecutionQueued, service };
}

describe("ChannelService", () => {
  it("judges an unclaimable exhausted event at the pass's own time and backs off", async () => {
    vi.useFakeTimers();
    try {
      const fixture = channelServiceFixture({ pending: 0 });
      // The store answers an exhausted event (another transaction holds it) as
      // due at the time it is asked about; asked later, it reads as later.
      fixture.channels.nextIngressDeadline.mockImplementation(async (asOf) => asOf);
      fixture.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.channels.claimIngress).toHaveBeenCalledOnce();
      const claimedAt = fixture.channels.claimIngress.mock.calls[0]![1];
      expect(fixture.channels.nextIngressDeadline.mock.calls[0]![0]).toBe(claimedAt);
      // Claimed nothing while something was due: one retry 5 s later, no spin.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fixture.channels.claimIngress).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.channels.claimIngress).toHaveBeenCalledTimes(2);
      await fixture.service.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
