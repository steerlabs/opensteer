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
  readonly placementCandidates: readonly {
    readonly environmentId: string;
    readonly harnessInstanceId: string;
  }[];
}

const environmentId = createId("environment");
const otherEnvironmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");
const defaultHarnessInstanceId = createId("harnessInstance");

function channelServiceFixture(
  options: {
    readonly harnesses?: readonly {
      readonly driverKind: string;
      readonly enabled: boolean;
      readonly environmentId?: string;
      readonly id: string;
      readonly isDefault?: boolean;
      readonly name: string;
    }[];
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
  const listHarnessInstances = vi.fn(async () =>
    (
      options.harnesses ?? [
        {
          driverKind: "native",
          enabled: true,
          id: harnessInstanceId,
          isDefault: true,
          name: "Opensteer",
        },
      ]
    ).map((harness) => ({
      ...harness,
      environmentId: harness.environmentId ?? environmentId,
    })),
  );
  const service = new ChannelService({
    canonicalOrigin: options.canonicalOrigin ?? "https://opensteer.test",
    channels: channels as never,
    credentials: {} as never,
    onExecutionQueued,
    onWorkspaceEvent: () => undefined,
    runners: {
      canRunHarness: () => true,
      isAvailable: () => true,
    } as never,
    relay: {} as never,
    store: {
      announceRevokedGrants: () => undefined,
      listEnvironments: async () => [
        { id: environmentId, kind: "managed", name: "Managed Runner" },
      ],
      listHarnessCatalogs: async () => [
        {
          catalog: { harnessInstanceId, status: "ready" },
          environmentId,
          harnessInstanceId,
        },
      ],
      listHarnessInstances,
    } as never,
  });
  return { channels, listHarnessInstances, onExecutionQueued, service };
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

  it("places a channel message on the work location's default AI engine", async () => {
    const fixture = channelServiceFixture({
      harnesses: [
        { driverKind: "native", enabled: true, id: harnessInstanceId, name: "First" },
        {
          driverKind: "native",
          enabled: true,
          id: defaultHarnessInstanceId,
          isDefault: true,
          name: "Default",
        },
      ],
    });
    const expectedAdoptions = 1;

    fixture.service.wake();
    await vi.waitFor(() => {
      expect(fixture.channels.adoptIngress).toHaveBeenCalledTimes(expectedAdoptions);
    });
    await fixture.service.close();

    expect(fixture.channels.adoptIngress.mock.calls[0]?.[0]).toMatchObject({
      placementCandidates: [{ environmentId, harnessInstanceId: defaultHarnessInstanceId }],
    });
  });

  it("does not choose the first runnable account when none is the default", async () => {
    const fixture = channelServiceFixture({
      harnesses: [
        { driverKind: "native", enabled: true, id: harnessInstanceId, name: "First" },
        { driverKind: "native", enabled: true, id: defaultHarnessInstanceId, name: "Second" },
      ],
    });
    const expectedAdoptions = 1;

    fixture.service.wake();
    await vi.waitFor(() => {
      expect(fixture.channels.adoptIngress).toHaveBeenCalledTimes(expectedAdoptions);
    });
    await fixture.service.close();

    expect(fixture.channels.adoptIngress.mock.calls[0]?.[0]).toMatchObject({
      placementCandidates: [],
    });
  });

  it("never borrows another work location's default account", async () => {
    const fixture = channelServiceFixture({
      harnesses: [
        {
          driverKind: "native",
          enabled: true,
          environmentId: otherEnvironmentId,
          id: defaultHarnessInstanceId,
          isDefault: true,
          name: "Other computer",
        },
      ],
    });

    fixture.service.wake();
    await vi.waitFor(() => {
      expect(fixture.channels.adoptIngress).toHaveBeenCalledTimes(1);
    });
    await fixture.service.close();

    expect(fixture.channels.adoptIngress.mock.calls[0]?.[0]).toMatchObject({
      placementCandidates: [],
    });
  });
});
