import { linkedPersonalHost } from "../apps/host/src/team-links/personal-host.test-support.js";
import {
  createTeamLinkEndpoint,
  TeamLinkLifetimes,
} from "../apps/host/src/team-link-endpoint/index.js";
import { createTeamMachineAdapters } from "../apps/host/src/team/machine-adapters.js";
import type { startTeamSystem } from "./team-system.test-support.js";
import type { UserId } from "../packages/core/src/index.js";
import { createId } from "../packages/core/src/index.js";
import {
  pairFixture,
  command,
  invite,
  redeem,
  list,
  active,
} from "./team-partners.test-support.js";

export async function sharedFixture() {
  const f = await pairFixture();
  try {
    await redeem(f.bSession, await invite(f.aSession));
    const link = (await list(f.aSession))[0]!;
    await command(f.aSession, { type: "team.partner.approve", linkId: link.id });
    await active(f.aSession, f.bSession);
    const aid = createId("teamChannel"),
      bid = createId("teamChannel");
    await command(f.aSession, {
      type: "team.channel.create",
      id: aid,
      kind: "private",
      name: "shared-project",
      peopleOnly: false,
      access: [],
    });
    const offered = await command(f.aSession, {
      type: "team.share.offer",
      channelId: aid,
      linkId: link.id,
      historyVisibleConfirmed: true,
    });
    if (offered.type !== "team.share.offer") throw new Error("Share offer missing");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: offered.shareId,
      id: bid,
      kind: "private",
      name: "partner-project",
      peopleOnly: false,
      access: [],
    });
    return {
      ...f,
      get discoveries() {
        return f.discoveries;
      },
      aid,
      bid,
      shareId: offered.shareId,
      aLink: link.id,
      bLink: (await list(f.bSession))[0]!.id,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

export async function sharedPersonalHost(
  host: Awaited<ReturnType<typeof startTeamSystem>>,
  userId: UserId,
) {
  const linkId = createId("teamLink");
  await host.database
    .insertInto("teamLinks")
    .values({
      id: linkId,
      ownerUserId: userId,
      personalDeploymentId: createId("deployment"),
      state: "active",
      codeHash: crypto.randomUUID(),
      codeExpiresAt: new Date(),
      credentialHash: crypto.randomUUID(),
    })
    .execute();
  const lifetimes = new TeamLinkLifetimes();
  const machine = createTeamLinkEndpoint({
    database: host.database,
    teamName: "Fixture",
    requests: host.host.team.requests,
    access: host.host.team.access,
    resolver: host.host.team.access,
    lifetimes,
    ...createTeamMachineAdapters(host.host.team, {
      topics: async () => {
        throw new Error("Unexpected knowledge call");
      },
      readNotes: async () => {
        throw new Error("Unexpected knowledge call");
      },
      write: async () => {
        throw new Error("Unexpected knowledge call");
      },
    }),
  });
  const personal = await linkedPersonalHost(
    {
      database: host.database,
      deploymentId: host.host.deployment.id,
      hostInstanceId: host.host.deployment.activeHostInstanceId,
      team: host.host.team,
      machine,
    },
    userId,
    linkId,
  );
  return {
    ...personal,
    linkId,
    close: async () => {
      lifetimes.stop();
      await personal.close();
    },
  };
}
