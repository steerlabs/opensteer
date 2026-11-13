import { TeamMessageIdSchema } from "@opensteer/core";
import type { TeamToolPort, TeamToolRun } from "../mcp/team-tool-port.js";
import { boundTeamReadPage } from "../team-link-endpoint/read-page.js";
import { linkError } from "../team-link-endpoint/contracts.js";
import type { TeamRunTools } from "./tools.js";
import type { TeamRunFileTransfers } from "./files.js";

export class PersonalTeamToolAdapter implements TeamToolPort {
  readonly tools: Pick<TeamRunTools, "authority" | "receipt" | "read" | "search" | "reply">;
  readonly files: Pick<TeamRunFileTransfers, "fetch" | "uploadPath">;
  constructor(
    tools: Pick<TeamRunTools, "authority" | "receipt" | "read" | "search" | "reply">,
    files: Pick<TeamRunFileTransfers, "fetch" | "uploadPath">,
  ) {
    this.tools = tools;
    this.files = files;
  }

  async #authority(run: TeamToolRun, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.tools.authority(run.runId);
  }

  async read(run: TeamToolRun, input: Parameters<TeamToolPort["read"]>[1], signal?: AbortSignal) {
    const request = await this.#authority(run, signal);
    if (input.teamId && input.teamId !== request.teamId) throw linkError();
    if (input.fileId) {
      const result = await this.files.fetch(run.runId, input.fileId, signal);
      signal?.throwIfAborted();
      return { path: result.path, source: result.source };
    }
    const result = await this.tools.read(run.runId, {
      channelId: input.channelId ?? request.source.channelId,
      ...(input.threadRootId
        ? { threadRootId: input.threadRootId }
        : !input.channelId && request.source.threadRootId
          ? { threadRootId: request.source.threadRootId }
          : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: TeamMessageIdSchema.parse(input.after) } : {}),
    });
    signal?.throwIfAborted();
    return boundTeamReadPage(result);
  }

  async search(
    run: TeamToolRun,
    input: Parameters<TeamToolPort["search"]>[1],
    signal?: AbortSignal,
  ) {
    const request = await this.#authority(run, signal);
    if (input.teamId && input.teamId !== request.teamId) throw linkError();
    const { teamId: _, ...query } = input;
    const result = await this.tools.search(run.runId, query);
    signal?.throwIfAborted();
    return result;
  }

  async post(run: TeamToolRun, input: Parameters<TeamToolPort["post"]>[1], signal?: AbortSignal) {
    const request = await this.#authority(run, signal);
    if (
      (input.teamId && input.teamId !== request.teamId) ||
      input.channelId !== request.source.channelId ||
      input.threadRootId !== request.source.threadRootId
    )
      throw linkError();
    const existing = await this.tools.receipt(run.runId);
    signal?.throwIfAborted();
    if (existing) return existing;
    const attachments = [];
    for (const path of input.attachmentPaths) {
      signal?.throwIfAborted();
      const result = await this.files.uploadPath(run.runId, path, signal);
      attachments.push(result.file.id);
    }
    signal?.throwIfAborted();
    const result = await this.tools.reply(run.runId, input.bodyMarkdown, attachments);
    signal?.throwIfAborted();
    return result;
  }
}
