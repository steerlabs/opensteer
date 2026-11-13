import { expect, it, vi } from "vitest";
import { createId, TeamSourceSchema } from "@opensteer/core";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import type { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { PersonalTeamRequestSchema } from "@opensteer/protocol";
import type { TeamLinkCallInput, TeamLinkResult } from "../team-link-endpoint/contracts.js";
import { TeamRunTools } from "./tools.js";

it("resolves only durable links, requires explicit selection for ambiguity, and never defaults to task origin", async () => {
  const a = createId("deployment"),
    b = createId("deployment");
  let links = [
    { teamDeploymentId: a, state: "unreachable", authorityEnvelope: { teamName: "Acme" } },
  ];
  const store = {
    list: async () => links,
    view: (link: (typeof links)[number]) => ({
      teamId: link.teamDeploymentId,
      teamName: link.authorityEnvelope.teamName,
      state: link.state,
    }),
  } as unknown as PersonalTeamLinksStore;
  const tools = new TeamRunTools(store, {} as PersonalTeamRequestsStore, () => {
    throw new Error("Resolution must stay local");
  });
  expect(await tools.authority()).toBe(a);
  links.push({ teamDeploymentId: b, state: "active", authorityEnvelope: { teamName: "Initech" } });
  await expect(tools.authority()).rejects.toMatchObject({
    code: "bad_request",
    next: expect.stringContaining(`Acme (${a}), Initech (${b})`),
  });
  expect(await tools.authority(b)).toBe(b);
  links = links.map((link) => ({ ...link, state: "revoked" }));
  await expect(tools.authority(a)).rejects.toMatchObject({ code: "not_found" });
  await expect(tools.authority()).rejects.toMatchObject({ code: "not_found" });
});

it("uses durable operation IDs and attaches reply claims only for the exact Run destination", async () => {
  const run = { runId: createId("run"), operationId: "durable-tool-operation" };
  const source = TeamSourceSchema.parse({
    teamId: createId("deployment"),
    channelId: createId("teamChannel"),
    threadRootId: "1",
    messageId: "2",
    audience: {
      teamName: "Acme",
      channelName: "support",
      channelKind: "public",
      memberCount: 12,
      peopleOnly: false,
    },
  });
  const request = PersonalTeamRequestSchema.parse({
    teamId: source.teamId,
    requestId: createId("teamAgentRequest"),
    triggerMessageId: "2",
    taskId: createId("thread"),
    inputId: createId("message"),
    runId: run.runId,
    source,
    publicationState: "pending",
    terminalState: null,
    replyMessageId: null,
  });
  const ledger = {
    forRun: async () => request,
    freeze: vi.fn(),
    publication: vi.fn(),
  } as unknown as PersonalTeamRequestsStore;
  const calls: TeamLinkCallInput[] = [];
  const call = async (input: TeamLinkCallInput): Promise<TeamLinkResult> => {
    calls.push(input);
    if (input.type === "read") return { kind: "read", result: { source } } as TeamLinkResult;
    return { kind: "receipt", messageId: source.messageId };
  };
  const tools = new TeamRunTools({} as PersonalTeamLinksStore, ledger, () => ({ call }));
  const post = {
    channelId: source.channelId,
    threadRootId: source.threadRootId!,
    bodyMarkdown: "Answer",
    attachmentIds: [],
  };
  await tools.post(run, source.teamId, post);
  await tools.post(run, source.teamId, post);
  await tools.post({ ...run, operationId: "another-operation" }, source.teamId, {
    ...post,
    threadRootId: "3" as typeof post.threadRootId,
  });
  const posts = calls.filter((c) => c.type === "post");
  expect(posts[0]?.clientMessageId).toBe(posts[1]?.clientMessageId);
  expect(posts[0]).toMatchObject({ requestId: request.requestId });
  expect(posts[2]).not.toHaveProperty("requestId");
  expect(posts[2]?.clientMessageId).not.toBe(posts[0]?.clientMessageId);
});
