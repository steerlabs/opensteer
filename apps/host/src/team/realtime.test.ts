import { createId } from "@opensteer/core";
import type { TeamAccessStore } from "@opensteer/database/team-access";
import type { TeamChatStore } from "@opensteer/database/team-chat";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import { TeamRealtimeHub } from "./realtime.js";

describe("TeamRealtimeHub sidebar liveness probes", () => {
  it("answers repeated sidebar-only probes with team.sidebar while suppressing redundant sidebars on channel/thread subscribes", async () => {
    const userId = createId("user");
    const channelId = createId("teamChannel");
    const actor = { kind: "human" as const, userId };
    const sidebarPayload = {
      teamId: createId("deployment"),
      teamName: "Acme",
      accessRevision: "1",
      namesRevision: "1",
      channels: [],
      members: [],
    };
    const cutPayload = {
      subscriptionId: "channel",
      generation: 2,
      scope: { kind: "channel" as const, channelId },
      channel: {
        id: channelId,
        name: "general",
        kind: "public" as const,
        peopleOnly: false,
        can: { post: true, manage: true },
      },
      throughSeq: "1",
      messages: [],
      linkPresence: [],
    };
    const access = {
      revision: "1",
      database: {},
      onCloseAll: () => () => {},
      onRevoke: () => () => {},
      current: vi.fn(async () => "1"),
      handoff: vi.fn(
        async (_rev: unknown, authorize: () => Promise<boolean>, deliver: () => void) => {
          if (await authorize()) deliver();
        },
      ),
      member: vi.fn(async () => ({ userId, state: "active" })),
      peerChannel: vi.fn(async () => ({ read: true })),
    } as unknown as TeamAccessStore;
    const accessDb = {
      transaction: () => ({
        execute: async (fn: (t: unknown) => Promise<unknown>) => fn({}),
      }),
    };
    (access as unknown as { database: unknown }).database = accessDb;
    const chat = {
      onChange: () => () => {},
      directory: vi.fn(async () => sidebarPayload),
      resume: vi.fn(async () => cutPayload),
    } as unknown as TeamChatStore;

    const hub = new TeamRealtimeHub(access, chat);
    try {
      const frames: { type: string }[] = [];
      const peer = hub.connect(actor, {
        send: (frame) => {
          frames.push(frame);
          return true;
        },
        close: () => {},
      });
      const sidebarProbe = {
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "sidebar",
        generation: 1,
        sidebar: true,
        scope: null,
        sinceSeq: null,
      };
      await peer.receive(sidebarProbe);
      expect(frames.filter((f) => f.type === "team.sidebar")).toHaveLength(1);

      // Channel subscribe and channel/thread unsubscribes must not resend sidebar.
      await peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "channel",
        generation: 2,
        sidebar: true,
        scope: { kind: "channel", channelId },
        sinceSeq: null,
      });
      await peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "channel",
        generation: 3,
        sidebar: true,
        scope: null,
        sinceSeq: null,
      });
      await peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "thread",
        generation: 4,
        sidebar: true,
        scope: null,
        sinceSeq: null,
      });
      expect(frames.filter((f) => f.type === "team.sidebar")).toHaveLength(1);

      // Repeated sidebar liveness probes must always be answered with team.sidebar.
      await peer.receive(sidebarProbe);
      await peer.receive(sidebarProbe);
      expect(frames.filter((f) => f.type === "team.sidebar")).toHaveLength(3);
      peer.close();
    } finally {
      hub.close();
    }
  });

  it("rebuilds sidebar at handoff instead of delivering a stale private channel after revocation", async () => {
    const userId = createId("user");
    const privateChannelId = createId("teamChannel");
    const actor = { kind: "human" as const, userId };
    let accessRevision = "1";
    const directoryStarted = Promise.withResolvers<void>();
    const finishFirstDirectory = Promise.withResolvers<void>();
    let directoryCalls = 0;

    const access = {
      get revision() {
        return accessRevision;
      },
      database: {
        transaction: () => ({
          execute: async (fn: (t: unknown) => Promise<unknown>) => fn({}),
        }),
      },
      onCloseAll: () => () => {},
      onRevoke: () => () => {},
      current: vi.fn(async () => accessRevision),
      handoff: vi.fn(
        async (authorizedAt: string, authorize: () => Promise<boolean>, deliver: () => void) => {
          while (authorizedAt !== accessRevision) {
            authorizedAt = accessRevision;
            if (!(await authorize())) throw new Error("forbidden");
          }
          deliver();
        },
      ),
      member: vi.fn(async () => ({ userId, state: "active" })),
      peerChannel: vi.fn(async () => ({ read: true })),
    } as unknown as TeamAccessStore;

    const chat = {
      onChange: () => () => {},
      directory: vi.fn(async () => {
        directoryCalls += 1;
        if (directoryCalls === 1) {
          directoryStarted.resolve();
          await finishFirstDirectory.promise;
          return {
            teamId: createId("deployment"),
            teamName: "Acme",
            accessRevision: "1",
            namesRevision: "1",
            channels: [{ id: privateChannelId, name: "secret", kind: "private" }],
            members: [],
          };
        }
        return {
          teamId: createId("deployment"),
          teamName: "Acme",
          accessRevision: "2",
          namesRevision: "1",
          channels: [],
          members: [],
        };
      }),
      resume: vi.fn(),
    } as unknown as TeamChatStore;

    const hub = new TeamRealtimeHub(access, chat);
    try {
      const frames: Array<{
        type: string;
        sidebar?: { accessRevision: string; channels: unknown[] };
      }> = [];
      const peer = hub.connect(actor, {
        send: (frame) => {
          frames.push(frame as (typeof frames)[number]);
          return true;
        },
        close: () => {},
      });

      const pending = peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "sidebar",
        generation: 1,
        sidebar: true,
        scope: null,
        sinceSeq: null,
      });
      await directoryStarted.promise;

      // Revoke private channel access before the first directory() capture reaches handoff.
      accessRevision = "2";
      finishFirstDirectory.resolve();
      await pending;

      expect(directoryCalls).toBe(2);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        type: "team.sidebar",
        sidebar: { accessRevision: "2", channels: [] },
      });
      peer.close();
    } finally {
      hub.close();
    }
  });
});
