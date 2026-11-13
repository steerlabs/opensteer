import {
  createId,
  OpensteerError,
  type DeploymentId,
  type TeamAgentRequestId,
} from "@opensteer/core";
import type {
  knowledge_read,
  knowledge_topics,
  knowledge_write,
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
      return { team: { id: link.teamId, name: link.teamName }, ...request };
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
    input: z.output<typeof knowledge_topics.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_topics.output>> {
    const { team, ...request } = await this.#team(caller, input.team);
    signal?.throwIfAborted();
    const result = await this.#rpc(team.id).call({ type: "knowledge.topics", ...request });
    if (result.kind !== "knowledge.topics") throw linkError("bad_request");
    return { team, topics: result.result.topics };
  }

  async read(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof knowledge_read.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_read.output>> {
    const { team: requested, ...read } = input;
    const { team, ...request } = await this.#team(caller, requested);
    signal?.throwIfAborted();
    const result = await this.#rpc(team.id).call({
      type: "knowledge.read",
      ...request,
      input: read,
    });
    if (result.kind !== "knowledge.read") throw linkError("bad_request");
    return { ...result.result, team };
  }

  async write(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof knowledge_write.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_write.output>> {
    const { team, ...request } = await this.#team(caller, input.team);
    signal?.throwIfAborted();
    const write: TeamKnowledgeWrite =
      input.noteId === undefined
        ? {
            // Minted once per call, so a frame the link resends is the same write.
            noteId: createId("knowledgeNote"),
            topicId: input.topicId!,
            expectedVersion: null,
            title: input.title!,
            body: input.body!,
          }
        : {
            noteId: input.noteId,
            expectedVersion: input.version!,
            ...(input.delete
              ? { delete: true as const }
              : {
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.body === undefined ? {} : { body: input.body }),
                }),
          };
    const result = await this.#rpc(team.id).call({
      type: "knowledge.write",
      ...request,
      input: write,
    });
    if (result.kind !== "knowledge.write") throw linkError("bad_request");
    return result.result;
  }
}

const teams = (links: readonly PersonalTeamLink[]) =>
  links.map((link) => `${link.teamName} (${link.teamId})`).join(", ");
