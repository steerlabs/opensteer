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
  transport.create.mockImplementation((options: TeamSessionOptions) => ({
    ...options,
    rpc: host.rpc,
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
  function Read() {
    const { teams } = useTeams();
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
  } finally {
    await act(async () => root.unmount());
    host.dispose();
  }
});
