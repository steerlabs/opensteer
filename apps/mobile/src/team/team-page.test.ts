import { MockTeamHost, TeamSessionClient } from "@opensteer/client/team";
import { createId, TeamChannelIdSchema } from "@opensteer/core";
import { expect, it } from "vitest";
import { drawerSection } from "./team-views.js";

it("reaches every channel past the first page and every DM on the team page", async () => {
  const host = new MockTeamHost();
  const general = [...host.channels.values()][0]!;
  for (let index = 0; index < 51; index++) {
    const id = TeamChannelIdSchema.parse(createId("teamChannel"));
    host.channels.set(id, { ...general, id, name: `room-${String(index).padStart(2, "0")}` });
  }
  for (let index = 0; index < 9; index++)
    await host.rpc["commands.dispatch"]({
      type: "team.dm.open",
      participants: [createId("user")],
    });
  const session = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: {
      load: async () => null,
      save: async () => undefined,
      remove: async () => undefined,
    },
  });
  await session.load(false);
  const page = () =>
    drawerSection({
      teamId: host.teamId,
      name: "Acme",
      state: "live",
      folded: false,
      sidebar: session.getSnapshot().sidebar!,
    });
  const first = page();
  expect(first.channels.length + first.dms.length).toBe(50);
  // The page's end asks for the rest, as the team page does when it nears the bottom.
  while (session.getSnapshot().sidebar!.nextCursor !== null) await session.loadMoreSidebar();
  const all = page();
  expect(all.channels).toHaveLength(52);
  expect(all.dms).toHaveLength(9);
  session.dispose();
});
