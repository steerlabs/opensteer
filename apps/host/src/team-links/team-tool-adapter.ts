import { markdownLink } from "@opensteer/shared/markdownLinks";
import { teamLinkMaxFrameBytes, linkError } from "../team-link-endpoint/contracts.js";
import {
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  type DeploymentId,
  type TeamPageTarget,
  type TeamSource,
  type TeamMessageId,
  teamPageUrl,
} from "@opensteer/core";
import type { TeamToolPort, TeamToolRun } from "../mcp/team-tool-port.js";
import { boundTeamReadPage } from "../team-link-endpoint/read-page.js";
import type { TeamRunTools } from "./tools.js";
import type { TeamRunFileTransfers } from "./files.js";

export class PersonalTeamToolAdapter implements TeamToolPort {
  readonly tools: Pick<
    TeamRunTools,
    "teams" | "authority" | "channels" | "receipt" | "read" | "search" | "post"
  >;
  readonly files: Pick<TeamRunFileTransfers, "fetch" | "uploadPath">;
  constructor(tools: PersonalTeamToolAdapter["tools"], files: PersonalTeamToolAdapter["files"]) {
    this.tools = tools;
    this.files = files;
  }

  async pageLink(teamId: DeploymentId) {
    const team = (await this.tools.teams()).find((team) => team.teamId === teamId);
    if (!team) throw linkError();
    return (target: TeamPageTarget, label: string) =>
      markdownLink(label, teamPageUrl({ origin: team.origin, target }));
  }

  #messageLink(
    pageLink: Awaited<ReturnType<PersonalTeamToolAdapter["pageLink"]>>,
    source: TeamSource,
    messageId: TeamMessageId,
    threadRootId = source.threadRootId,
  ) {
    return pageLink(
      threadRootId
        ? { kind: "thread", channelId: source.channelId, threadRootId, messageId }
        : { kind: "message", channelId: source.channelId, messageId },
      `Message in #${source.audience.channelName}`,
    );
  }

  async read(run: TeamToolRun, input: Parameters<TeamToolPort["read"]>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (Object.keys(input).length === 0)
      return {
        teams: (await this.tools.teams()).map(({ teamId, teamName, state }) => ({
          teamId,
          teamName,
          state,
        })),
      };
    const teamId = await this.tools.authority(input.teamId);
    if (input.fileId) {
      const result = await this.files.fetch(run, teamId, input.fileId, signal);
      signal?.throwIfAborted();
      return {
        path: result.path,
        source: result.source,
        link: markdownLink(result.file.filename, result.path),
      };
    }
    const pageLink = await this.pageLink(teamId);
    if (!input.channelId) {
      const result = await this.tools.channels(
        run,
        teamId,
        input.after ? TeamChannelIdSchema.parse(input.after) : undefined,
      );
      return {
        ...result,
        channels: result.channels.map((channel) => ({
          ...channel,
          link: pageLink({ kind: "channel", channelId: channel.id }, channel.name),
        })),
      };
    }
    const result = await this.tools.read(run, teamId, {
      channelId: input.channelId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: TeamMessageIdSchema.parse(input.after) } : {}),
    });
    signal?.throwIfAborted();
    const linked = {
      ...result,
      link: pageLink(
        input.threadRootId
          ? { kind: "thread", channelId: input.channelId, threadRootId: input.threadRootId }
          : { kind: "channel", channelId: input.channelId },
        result.page.channel.name,
      ),
      page: {
        ...result.page,
        channel: {
          ...result.page.channel,
          link: pageLink(
            { kind: "channel", channelId: result.page.channel.id },
            result.page.channel.name,
          ),
        },
        messages: result.page.messages.map((message) => ({
          ...message,
          link: this.#messageLink(pageLink, result.source, message.id, message.threadRootId),
        })),
      },
    };
    return boundTeamReadPage(linked, input.after ? "after" : input.before ? "before" : "newest");
  }

  async search(
    run: TeamToolRun,
    input: Parameters<TeamToolPort["search"]>[1],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const teamId = await this.tools.authority(input.teamId);
    const { teamId: _, ...query } = input;
    const result = await this.tools.search(run, teamId, query);
    signal?.throwIfAborted();
    const pageLink = await this.pageLink(teamId);
    const linked = {
      ...result,
      results: result.results.map((hit) => ({
        ...hit,
        message: {
          ...hit.message,
          link: this.#messageLink(pageLink, hit.source, hit.message.id, hit.message.threadRootId),
        },
      })),
    };
    while (Buffer.byteLength(JSON.stringify(linked)) > teamLinkMaxFrameBytes - 8192) {
      if (linked.results.length <= 1) throw linkError("resource_exhausted");
      linked.results.pop();
      linked.hasMore = true;
    }
    return linked;
  }

  async post(run: TeamToolRun, input: Parameters<TeamToolPort["post"]>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const teamId = await this.tools.authority(input.teamId);
    const existing = await this.tools.receipt(run, teamId);
    signal?.throwIfAborted();
    if (existing)
      return {
        ...existing,
        link: this.#messageLink(await this.pageLink(teamId), existing.source, existing.messageId),
      };
    const attachmentIds = [];
    for (const path of input.attachmentPaths) {
      const result = await this.files.uploadPath(run, teamId, input.channelId, path, signal);
      signal?.throwIfAborted();
      attachmentIds.push(result.file.id);
    }
    const { teamId: _, attachmentPaths: __, ...post } = input;
    const result = await this.tools.post(run, teamId, { ...post, attachmentIds });
    signal?.throwIfAborted();
    return {
      ...result,
      link: this.#messageLink(await this.pageLink(teamId), result.source, result.messageId),
    };
  }
}
