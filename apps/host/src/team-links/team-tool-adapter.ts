import { TeamChannelIdSchema, TeamMessageIdSchema } from "@opensteer/core";
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
      return { path: result.path, source: result.source };
    }
    if (!input.channelId)
      return this.tools.channels(
        run,
        teamId,
        input.after ? TeamChannelIdSchema.parse(input.after) : undefined,
      );
    const result = await this.tools.read(run, teamId, {
      channelId: input.channelId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: TeamMessageIdSchema.parse(input.after) } : {}),
    });
    signal?.throwIfAborted();
    return boundTeamReadPage(result, input.after ? "after" : input.before ? "before" : "newest");
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
    return result;
  }

  async post(run: TeamToolRun, input: Parameters<TeamToolPort["post"]>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const teamId = await this.tools.authority(input.teamId);
    const existing = await this.tools.receipt(run, teamId);
    signal?.throwIfAborted();
    if (existing) return existing;
    const attachmentIds = [];
    for (const path of input.attachmentPaths) {
      const result = await this.files.uploadPath(run, teamId, input.channelId, path, signal);
      signal?.throwIfAborted();
      attachmentIds.push(result.file.id);
    }
    const { teamId: _, attachmentPaths: __, ...post } = input;
    const result = await this.tools.post(run, teamId, { ...post, attachmentIds });
    signal?.throwIfAborted();
    return result;
  }
}
