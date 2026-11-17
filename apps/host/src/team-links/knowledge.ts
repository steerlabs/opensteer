import { stripRefs } from "@opensteer/shared/stripRefs";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import { markdownPreview } from "@opensteer/shared/markdownPreview";
import { teamKnowledgeLimits, TeamKnowledgeWriteSchema } from "@opensteer/protocol";
import {
  createId,
  teamPageUrl,
  OpensteerError,
  type DeploymentId,
  type TeamAgentRequestId,
} from "@opensteer/core";
import type {
  opensteer_knowledge_topic_list,
  opensteer_knowledge_save,
} from "@opensteer/agent-tools/tools";
import type { PersonalTeamLink, TeamKnowledgeWrite } from "@opensteer/protocol";
import type { z } from "zod";
import { linkError, type TeamLinkRpc } from "../team-link-endpoint/contracts.js";
import type { TeamKnowledgeCaller, TeamKnowledgePort } from "../mcp/team-tool-port.js";

/**
 * The owner's agent reaching team knowledge over the owner's own link, from any Run that may
 * use personal context. A team thread's Run names its request so the team can say whether
 * the asking room can read each topic and record where a write came from.
 */
export class PersonalTeamKnowledge implements TeamKnowledgePort {
  readonly #links: () => Promise<readonly PersonalTeamLink[]>;
  readonly #rpc: (teamId: DeploymentId) => TeamLinkRpc;
  constructor(
    links: () => Promise<readonly PersonalTeamLink[]>,
    rpc: (teamId: DeploymentId) => TeamLinkRpc,
  ) {
    this.#links = links;
    this.#rpc = rpc;
  }

  async #team(caller: TeamKnowledgeCaller, requested: DeploymentId | undefined) {
    const active = (await this.#links()).filter((link) => link.state === "active");
    const wanted = requested ?? caller.teamOrigin?.teamId;
    const choose = (link: PersonalTeamLink) => {
      const request: { readonly requestId?: TeamAgentRequestId } =
        caller.requestId && caller.teamOrigin?.teamId === link.teamId
          ? { requestId: caller.requestId }
          : {};
      return { team: { id: link.teamId, name: link.teamName }, origin: link.origin, ...request };
    };
    if (wanted) {
      const link = active.find((candidate) => candidate.teamId === wanted);
      if (link) return choose(link);
      throw new OpensteerError({
        code: "not_found",
        message: "Your owner's computer isn't connected to that team right now.",
        next: active.length ? `Use one of: ${teams(active)}.` : "Tell the person.",
      });
    }
    const [only, ...others] = active;
    if (only && !others.length) return choose(only);
    if (!only)
      throw new OpensteerError({
        code: "not_found",
        message: "Your owner isn't connected to any team, so there is no team knowledge.",
      });
    throw new OpensteerError({
      code: "bad_request",
      message: "Your owner is in more than one team.",
      next: `Call again with team set to one of: ${teams(active)}.`,
    });
  }

  async topics(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof opensteer_knowledge_topic_list.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_knowledge_topic_list.output>> {
    const { team, origin, ...request } = await this.#team(caller, input.team);
    signal?.throwIfAborted();
    const result = await this.#rpc(team.id).call({ type: "knowledge.topics", ...request });
    if (result.kind !== "knowledge.topics") throw linkError("bad_request");
    return {
      team,
      topics: result.result.topics.map((topic) => ({
        ...topic,
        link: markdownLink(
          topic.name,
          teamPageUrl({ origin, target: { kind: "knowledge-topic", topicId: topic.id } }),
        ),
      })),
    };
  }

  async read(
    caller: TeamKnowledgeCaller,
    input: Parameters<TeamKnowledgePort["read"]>[1],
    signal?: AbortSignal,
  ): ReturnType<TeamKnowledgePort["read"]> {
    const { team: requested, ...read } = input;
    const { team, origin, ...request } = await this.#team(caller, requested);
    signal?.throwIfAborted();
    const result = await this.#rpc(team.id).call({
      type: "knowledge.read",
      ...request,
      input: read,
    });
    if (result.kind !== "knowledge.read") throw linkError("bad_request");
    const page = {
      ...result.result,
      team,
      topics: result.result.topics.map((topic) => ({
        ...topic,
        link: markdownLink(
          topic.name,
          teamPageUrl({ origin, target: { kind: "knowledge-topic", topicId: topic.id } }),
        ),
      })),
      notes: result.result.notes.map((note) => ({
        ...note,
        link: markdownLink(
          note.title,
          teamPageUrl({
            origin,
            target: { kind: "knowledge-note", topicId: note.topicId, noteId: note.id },
          }),
        ),
      })),
    };
    for (
      let index = page.notes.length - 1;
      Buffer.byteLength(JSON.stringify(page)) > teamKnowledgeLimits.agentReadBytes && index >= 0;
      index--
    ) {
      page.notes[index] = {
        ...page.notes[index]!,
        body: markdownPreview(page.notes[index]!.body, teamKnowledgeLimits.previewChars),
      };
      page.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(page)) > teamKnowledgeLimits.agentReadBytes)
      throw linkError("resource_exhausted");
    return page;
  }

  async write(
    caller: TeamKnowledgeCaller,
    input: Parameters<TeamKnowledgePort["write"]>[1],
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_knowledge_save.output>> {
    const { team, origin, ...request } = await this.#team(caller, input.team);
    signal?.throwIfAborted();
    const write: TeamKnowledgeWrite =
      input.noteId === undefined
        ? {
            // Minted once per call, so a frame the link resends is the same write.
            noteId: createId("knowledgeNote"),
            topicId: input.topicId!,
            expectedVersion: null,
            title: stripRefs(input.title!),
            body: stripRefs(input.body!),
          }
        : {
            noteId: input.noteId,
            expectedVersion: input.version!,
            ...(input.delete
              ? { delete: true as const }
              : {
                  ...(input.title === undefined ? {} : { title: stripRefs(input.title) }),
                  ...(input.body === undefined ? {} : { body: stripRefs(input.body) }),
                }),
          };
    const result = await this.#rpc(team.id).call({
      type: "knowledge.write",
      ...request,
      input: TeamKnowledgeWriteSchema.parse(write),
    });
    if (result.kind !== "knowledge.write") throw linkError("bad_request");
    const note = result.result.written ? result.result : result.result.current;
    const link = markdownLink(
      "title" in note ? note.title : "Note",
      teamPageUrl({
        origin,
        target: {
          kind: "knowledge-note",
          topicId: note.topicId,
          noteId: "noteId" in note ? note.noteId : note.id,
        },
      }),
    );
    return result.result.written
      ? { ...result.result, link }
      : { ...result.result, current: { ...result.result.current, link } };
  }
}

const teams = (links: readonly PersonalTeamLink[]) =>
  links.map((link) => `${link.teamName} (${link.teamId})`).join(", ");
