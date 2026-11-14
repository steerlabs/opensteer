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
