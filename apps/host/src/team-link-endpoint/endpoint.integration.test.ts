import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { teamChannelTopics } from "@opensteer/database";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { TeamLinkEndpoint } from "./endpoint.js";
import { TeamEndpointLinks } from "./links.js";
import { TeamLinkLifetimes } from "./lifetimes.js";

it("accepts a queued request over the machine endpoint before granting content authority", async () => {
  const fixture = await createTeamKnowledgeFixture();
  try {
    const access = new TeamAccessStore(fixture.database);
    await access.initialize();
    const chat = new TeamChatStore(access, teamChannelTopics, {
      teamId: fixture.deploymentId,
      teamName: "Acme",
    });
    const requests = new TeamRequestsStore(access, chat);
    const actor = { kind: "human" as const, userId: fixture.userId };
    const channel = await chat.create(actor, {
      id: createId("teamChannel"),
      name: "support",
      kind: "public",
      peopleOnly: false,
      access: [],
    });
    const linkId = createId("teamLink");
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at) values(${linkId},${fixture.userId},${createId("deployment")},'active',${randomUUID()},${randomUUID()},now())`.execute(
      fixture.database,
    );
    await chat.send(actor, {
      channelId: channel.id,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-agent help",
      mentions: [{ kind: "agent", userId: fixture.userId }],
      attachmentIds: [],
    });
    const request = (await requests.pending(linkId))[0]!.request;
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected data call");
    };
    const endpoint = new TeamLinkEndpoint({
      links: new TeamEndpointLinks(fixture.database, access, "Acme"),
      requests,
      access,
      resolver: access,
      lifetimes: new TeamLinkLifetimes(),
      data: { read: unavailable, search: unavailable, sql: unavailable },
    });
    const context = () =>
      endpoint.call(linkId, { type: "context", id: randomUUID(), requestId: request.id });
    await expect(context()).rejects.toMatchObject({ code: "forbidden" });
    const accept = () =>
      endpoint.call(linkId, { type: "accept", id: randomUUID(), requestId: request.id });
    const accepted = await accept();
    expect(accepted).toMatchObject({ kind: "accepted", request: { state: "working" } });
    expect(await accept()).toEqual(accepted);
    expect(await context()).toMatchObject({
      kind: "context",
      context: { request: { id: request.id } },
    });
    await chat.update(actor, channel.id, { peopleOnly: true });
    await expect(accept()).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await fixture.close();
  }
});
