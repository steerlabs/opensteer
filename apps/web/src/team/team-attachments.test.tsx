// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  MockTeamHost,
  createMemoryTeamPersistence,
  type TeamSessionOptions,
} from "@opensteer/client/team";
import type { HostClient } from "@opensteer/client/host";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import type { TeamAttachment } from "./team-attachments.js";
import { TeamsProvider, useTeams } from "./team-attachments.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./team-transports.js", () => ({
  desktopTeamSession: (options: TeamSessionOptions) => transport.create(options),
}));

it("scopes desktop team state to the authenticated viewer rather than the personal link owner", async () => {
  const host = new MockTeamHost();
  const persistence = createMemoryTeamPersistence();
  const ownerUserId = createId("user");
  let unavailable: false | "outage" | "update" = false;
  transport.create.mockImplementation((options: TeamSessionOptions) => ({
    ...options,
    rpc: new Proxy(host.rpc, {
      get: (target, name, receiver) =>
        name === "team.bootstrap.get" && unavailable
          ? async () => ({
              ok: false,
              error: {
                code: unavailable === "update" ? "conflict" : "internal",
                reason: unavailable === "update" ? "host-too-old" : "transport-unreachable",
                message: "Team unavailable",
                retryable: true,
              },
            })
          : Reflect.get(target, name, receiver),
    }),
    connect: host.connect,
    persistence,
  }));
  const hostClient = {
    rpc: {
      "teams.links.list": async () => ({
        ok: true,
        data: {
          links: [
            {
              teamId: host.teamId,
              hostInstanceId: createId("hostInstance"),
              origin: host.origin,
              teamName: "Team",
              ownerUserId,
              state: "active",
              remoteLinkId: null,
              updateRequiredBy: null,
              lastContactAt: null,
            },
          ],
        },
      }),
    },
  } as unknown as HostClient;
  const bridge = {} as OpensteerDesktopBridge;
  let viewer: string | null = null;
  let attachment: TeamAttachment | undefined;
  function Read() {
    const { teams } = useTeams();
    attachment = teams[0];
    viewer = teams[0]?.client?.getSnapshot().bootstrap?.member.userId ?? null;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TeamsProvider surface={{ kind: "desktop", bridge, hostClient }}>
          <Read />
        </TeamsProvider>,
      ),
    );
    await vi.waitFor(
      () => expect(viewer, "the authenticated team viewer never attached").toBe(host.userId),
      { timeout: 1000 },
    );
    expect(viewer).not.toBe(ownerUserId);
    const held = attachment?.client;
    unavailable = "outage";
    await act(async () =>
      root.render(
        <TeamsProvider
          surface={{ kind: "desktop", bridge, hostClient: { ...hostClient } as HostClient }}
        >
          <Read />
        </TeamsProvider>,
      ),
    );
    await vi.waitFor(
      () => expect(attachment?.failure, "bootstrap failure never classified").toBe("unavailable"),
      { timeout: 1000 },
    );
    expect(attachment?.client).toBe(held);
    unavailable = "update";
    await act(async () =>
      root.render(
        <TeamsProvider
          surface={{ kind: "desktop", bridge, hostClient: { ...hostClient } as HostClient }}
        >
          <Read />
        </TeamsProvider>,
      ),
    );
    await vi.waitFor(
      () =>
        expect(attachment?.failure, "server update was hidden as an outage").toBe("update-server"),
      { timeout: 1000 },
    );
    expect(attachment?.client).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.dispose();
  }
});

it("publishes an authorized team while another team's silent entry is pending", async () => {
  const ready = new MockTeamHost();
  const pendingId = createId("deployment");
  const gate = Promise.withResolvers<void>();
  transport.create.mockImplementation((options: TeamSessionOptions) => ({
    ...options,
    rpc: new Proxy(ready.rpc, {
      get(target, key, receiver) {
        if (options.scope.teamDeploymentId === pendingId && key === "team.bootstrap.get")
          return async () => {
            await gate.promise;
            return {
              ok: false,
              error: { code: "unauthorized", message: "Sign in", retryable: false },
            };
          };
        return Reflect.get(target, key, receiver);
      },
    }),
    connect: ready.connect,
    persistence: createMemoryTeamPersistence(),
  }));
  const hostClient = {
    rpc: {
      "teams.links.list": async () => ({
        ok: true,
        data: {
          links: [ready.teamId, pendingId].map((teamId) => ({
            teamId,
            hostInstanceId: createId("hostInstance"),
            origin: ready.origin,
            teamName: "Team",
            ownerUserId: ready.userId,
            state: "active",
            remoteLinkId: null,
            updateRequiredBy: null,
            lastContactAt: null,
          })),
        },
      }),
    },
  } as unknown as HostClient;
  let teams: readonly TeamAttachment[] = [];
  function Read() {
    teams = useTeams().teams;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <TeamsProvider
          surface={{ kind: "desktop", bridge: {} as OpensteerDesktopBridge, hostClient }}
        >
          <Read />
        </TeamsProvider>,
      ),
    );
    await vi.waitFor(
      () =>
        expect(
          teams.find((team) => team.teamId === ready.teamId)?.client,
          "ready team waited for unrelated authorization",
        ).toBeTruthy(),
      { timeout: 1000 },
    );
    expect(teams.find((team) => team.teamId === pendingId)?.failure).toBe("pending");
  } finally {
    await act(async () => {
      gate.resolve();
      await gate.promise;
      root.unmount();
    });
    ready.dispose();
  }
});

it("discards a team notification invalidated while permission was pending", async () => {
  const { notifyTeam } = await import("./team-attachments.js");
  const permission = Promise.withResolvers<NotificationPermission>();
  const shown = vi.fn();
  class TestNotification {
    static permission = "default";
    static requestPermission = () => permission.promise;
    constructor(...args: unknown[]) {
      shown(...args);
    }
  }
  vi.stubGlobal("Notification", TestNotification);
  let current = true;
  try {
    notifyTeam(
      "Acme",
      {
        mentionCount: 1,
        channel: { id: "channel", kind: "public", name: "private-channel" },
      } as never,
      () => {},
      () => current,
    );
    current = false;
    permission.resolve("granted");
    await permission.promise;
    expect(shown).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("stops desktop sign-in if the Account switches while team verification is pending", async () => {
  const host = new MockTeamHost();
  transport.create.mockImplementation((options: TeamSessionOptions) => ({
    ...options,
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  }));
  const verification = Promise.withResolvers<unknown>();
  const calls = vi.fn(async (input: { call: string }) =>
    input.call === "verify" ? verification.promise : { ok: true, data: null },
  );
  const bridge = {
    teamSessions: calls,
    accountTeams: vi.fn(),
  } as unknown as OpensteerDesktopBridge;
  const hostClient = {
    rpc: { "teams.links.list": async () => ({ ok: true, data: { links: [] } }) },
  } as unknown as HostClient;
  let value: ReturnType<typeof useTeams>;
  function Read() {
    value = useTeams();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (subject: string) =>
    root.render(
      <TeamsProvider
        account={{ subject, email: null }}
        accountTeams={[{ teamDeploymentId: host.teamId, origin: host.origin, name: "Team" }]}
        surface={{ kind: "desktop", bridge, hostClient }}
      >
        <Read />
      </TeamsProvider>,
    );
  try {
    await act(async () => render("A"));
    const pending = value!.enter!(host.teamId).catch((error: unknown) => error);
    await vi.waitFor(
      () => expect(calls).toHaveBeenCalledWith({ call: "verify", origin: host.origin }),
      { timeout: 1000 },
    );
    await act(async () => render("B"));
    const authority = {
      deploymentId: host.teamId,
      canonicalOrigin: host.origin,
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: "sha256:" + "a".repeat(43),
    };
    verification.resolve({ ok: true, data: { authority, capabilities: [] } });
    await pending;
    expect(calls.mock.calls.map(([input]) => input.call)).not.toContain("sign-in");
  } finally {
    verification.resolve({ ok: false, error: { message: "Cancelled" } });
    await act(async () => root.unmount());
    host.dispose();
  }
});
