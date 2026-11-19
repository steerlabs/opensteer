import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ChannelService } from "./channel-service.js";

/** Only the fields these tests read back off the mock. */
interface AdoptCall {
  readonly notices: {
    readonly linkByDirectMessage: string;
    readonly linkCode: (code: string) => string;
    readonly noRoute: string;
    readonly notAMember: string;
  };
  readonly availableEngines: readonly {
    readonly environmentId: string;
    readonly driverKinds: readonly string[];
  }[];
}

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
    adoptIngress: vi.fn(async (_input: AdoptCall) => ({
      dispatchEnvironmentId: environmentId,
      events: [],
      kind: "adopted" as const,
      revokedGrants: [],
    })),
    nextIngressDeadline: vi.fn(async () => null),
    pruneHistory: vi.fn(async () => undefined),
    claimIngress: vi.fn(async () =>
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
  const drivers = (...driverKinds: string[]) => ({
    modules: { agents: { harnessDrivers: driverKinds.map((driverKind) => ({ driverKind })) } },
  });
  const service = new ChannelService({
    canonicalOrigin: options.canonicalOrigin ?? "https://opensteer.test",
    channels: channels as never,
    credentials: {} as never,
    onExecutionQueued,
    runners: {
      canRunHarness: (_environmentId: string, driverKind: string) => driverKind !== "broken",
      identityForEnvironment: (id: string) =>
        id === environmentId ? drivers("codex", "broken") : drivers("claude"),
      isAvailable: (id: string) => id !== offlineEnvironmentId,
    } as never,
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
  it.each(["http://127.0.0.1:60470", "http://localhost:43100", "http://[::1]:43100"])(
    "directs personal verification to the app instead of a misleading remote loopback link (%s)",
    async (canonicalOrigin) => {
      const fixture = channelServiceFixture({ canonicalOrigin });
      fixture.service.wake();
      await vi.waitFor(() => expect(fixture.channels.adoptIngress).toHaveBeenCalledOnce());
      await fixture.service.close();
      const text = fixture.channels.adoptIngress.mock.calls[0]?.[0].notices.linkCode("ABCDEFGH");
      expect(text).toContain("Opensteer on the computer running this bot");
      expect(text).not.toContain(canonicalOrigin);
      expect(text).toContain("Send your message again");
    },
  );

  // Whose account runs a message is decided once the channel identity resolves
  // to a person, inside adoptIngress; the service offers no account at all.
  it("offers adoption only what is connected and runnable, Deployment locations first", async () => {
    const fixture = channelServiceFixture();
    fixture.service.wake();
    await vi.waitFor(() => expect(fixture.channels.adoptIngress).toHaveBeenCalledOnce());
    await fixture.service.close();

    expect(fixture.channels.adoptIngress.mock.calls[0]?.[0].availableEngines).toEqual([
      { environmentId, driverKinds: ["codex"] },
      { environmentId: otherEnvironmentId, driverKinds: ["claude"] },
    ]);
  });

  it.each([
    ["claimed one and more are due: runs again at once", 1, 0, 0],
    ["nothing due: armed at the next time", 0, 60_000, 60_000],
    ["due but none claimable: backs off, no spin", 0, -1, 5_000],
  ] as const)("ingress pass, %s", async (_, pending, nextIn, armedIn) => {
    vi.useFakeTimers();
    try {
      const fixture = channelServiceFixture({ pending });
      let first = true;
      fixture.channels.nextIngressDeadline.mockImplementation(async () => {
        // After one claimed delivery the rest stay due once, then nothing.
        if (pending && !first) return null;
        first = false;
        return new Date(Date.now() + nextIn) as never;
      });
      fixture.service.start();
      await vi.advanceTimersByTimeAsync(0);
      const passes = fixture.channels.claimIngress.mock.calls.length;
      if (armedIn > 0) {
        await vi.advanceTimersByTimeAsync(armedIn - 1);
        expect(fixture.channels.claimIngress.mock.calls.length).toBe(passes);
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.channels.claimIngress.mock.calls.length).toBeGreaterThan(passes);
      } else {
        expect(fixture.channels.adoptIngress).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      }
      await fixture.service.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
