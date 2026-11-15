import { TeamSearchInputSchema } from "@opensteer/protocol";
import {
  TeamMessageIdSchema,
  TeamChannelIdSchema,
  OpensteerError,
  type RunId,
  type TeamAgentRequestId,
  type ThreadId,
} from "@opensteer/core";
import type { AgentToolHandlers, ToolCall } from "./types.js";
import type { TeamKnowledgePort, TeamToolPort } from "../team-tool-port.js";

type TeamToolName =
  | "opensteer_team_file_download"
  | "opensteer_team_read"
  | "opensteer_team_search"
  | "opensteer_team_post";
export function teamToolHandlers(options: {
  readonly port: TeamToolPort | undefined;
  readonly personalContext: (runId: RunId) => Promise<boolean>;
}): Pick<AgentToolHandlers, TeamToolName> {
  const invoke = async <Name extends TeamToolName>(
    name: Name,
    call: ToolCall<Name>,
  ): Promise<unknown> => {
    const caller = call.caller;
    if (caller.kind !== "run")
      throw new OpensteerError({ code: "forbidden", message: "This tool requires a live Run" });
    if (!(await options.personalContext(caller.claims.runId)))
      throw new OpensteerError({
        code: "forbidden",
        message: "Team access isn't available in a conversation other people share.",
      });
    if (!options.port)
      throw new OpensteerError({ code: "conflict", message: "The team link is unavailable" });
    await call.checkLive?.();
    const run = { operationId: call.operationKey, runId: caller.claims.runId };
    switch (name) {
      case "opensteer_team_file_download":
        return options.port.read(
          run,
          call.input as ToolCall<"opensteer_team_file_download">["input"],
          call.signal,
        );
      case "opensteer_team_read": {
        const { threadId, cursor, afterMessageId, ...input } =
          call.input as ToolCall<"opensteer_team_read">["input"];
        const result = await options.port.read(
          run,
          {
            ...input,
            ...(threadId ? { threadRootId: threadId } : {}),
            ...(afterMessageId ? { after: afterMessageId } : {}),
            ...(cursor
              ? input.channelId
                ? { before: importMessageId(cursor) }
                : { after: importChannelId(cursor) }
              : {}),
          },
          call.signal,
        );
        if ("nextAfter" in result) {
          const { nextAfter, ...page } = result;
          return { ...page, nextCursor: nextAfter };
        }
        if ("page" in result)
          return {
            ...result,
            page: {
              ...result.page,
              nextCursor:
                result.page.hasMore && !afterMessageId
                  ? (result.page.messages[0]?.id ?? null)
                  : null,
            },
          };
        return result;
      }
      case "opensteer_team_search": {
        const { cursor, ...input } = call.input as ToolCall<"opensteer_team_search">["input"];
        return options.port.search(
          run,
          {
            ...input,
            ...(cursor ? { before: TeamSearchInputSchema.shape.before.parse(cursor) } : {}),
          },
          call.signal,
        );
      }
      case "opensteer_team_post": {
        const { threadId, ...input } = call.input as ToolCall<"opensteer_team_post">["input"];
        return options.port.post(
          run,
          { ...input, ...(threadId ? { threadRootId: threadId } : {}) },
          call.signal,
        );
      }
    }
  };
  return {
    opensteer_team_file_download: (call) => invoke("opensteer_team_file_download", call),
    opensteer_team_read: (call) => invoke("opensteer_team_read", call),
    opensteer_team_search: (call) => invoke("opensteer_team_search", call),
    opensteer_team_post: (call) => invoke("opensteer_team_post", call),
  };
}

type KnowledgeToolName =
  | "opensteer_knowledge_search"
  | "opensteer_knowledge_remove"
  | "opensteer_knowledge_topic_list"
  | "opensteer_knowledge_read"
  | "opensteer_knowledge_save";
/** Team knowledge as the Run's owner, in any Run that may still use their personal context. */
export function knowledgeToolHandlers(options: {
  readonly port: TeamKnowledgePort | undefined;
  readonly requestForRun: (runId: RunId, threadId: ThreadId) => Promise<TeamAgentRequestId | null>;
  readonly personalContext: (runId: RunId) => Promise<boolean>;
}): Pick<AgentToolHandlers, KnowledgeToolName> {
  const invoke = async <Name extends KnowledgeToolName>(
    name: Name,
    call: ToolCall<Name>,
  ): Promise<unknown> => {
    const caller = call.caller;
    if (caller.kind !== "run")
      throw new OpensteerError({ code: "forbidden", message: "This tool requires a live Run" });
    // Rechecked per call: a shared sender admitted mid-task ends personal context.
    if (!(await options.personalContext(caller.claims.runId)))
      throw new OpensteerError({
        code: "forbidden",
        message: "Team knowledge isn't available in a conversation other people share.",
      });
    if (!options.port)
      throw new OpensteerError({ code: "conflict", message: "The team link is unavailable" });
    await call.checkLive?.();
    const knowledgeCaller = {
      runId: caller.claims.runId,
      teamOrigin: caller.thread.teamOrigin ? { teamId: caller.thread.teamOrigin.teamId } : null,
      requestId: caller.thread.teamOrigin
        ? await options.requestForRun(caller.claims.runId, caller.thread.id)
        : null,
    };
    switch (name) {
      case "opensteer_knowledge_topic_list":
        return options.port.topics(
          knowledgeCaller,
          call.input as ToolCall<"opensteer_knowledge_topic_list">["input"],
          call.signal,
        );
      case "opensteer_knowledge_search": {
        const { cursor, ...input } = call.input as ToolCall<"opensteer_knowledge_search">["input"];
        return knowledgePage(
          await options.port.read(
            knowledgeCaller,
            { ...input, ...(cursor ? { before: cursor } : {}) },
            call.signal,
          ),
        );
      }
      case "opensteer_knowledge_remove":
        return options.port.write(
          knowledgeCaller,
          { ...(call.input as ToolCall<"opensteer_knowledge_remove">["input"]), delete: true },
          call.signal,
        );
      case "opensteer_knowledge_read": {
        const { cursor, ...input } = call.input as ToolCall<"opensteer_knowledge_read">["input"];
        return knowledgePage(
          await options.port.read(
            knowledgeCaller,
            { ...input, ...(cursor ? { before: cursor } : {}) },
            call.signal,
          ),
        );
      }
      case "opensteer_knowledge_save":
        return options.port.write(
          knowledgeCaller,
          call.input as ToolCall<"opensteer_knowledge_save">["input"],
          call.signal,
        );
    }
  };
  return {
    opensteer_knowledge_search: (call) => invoke("opensteer_knowledge_search", call),
    opensteer_knowledge_remove: (call) => invoke("opensteer_knowledge_remove", call),
    opensteer_knowledge_topic_list: (call) => invoke("opensteer_knowledge_topic_list", call),
    opensteer_knowledge_read: (call) => invoke("opensteer_knowledge_read", call),
    opensteer_knowledge_save: (call) => invoke("opensteer_knowledge_save", call),
  };
}

const importMessageId = (cursor: string) => TeamMessageIdSchema.parse(cursor);
const importChannelId = (cursor: string) => TeamChannelIdSchema.parse(cursor);

function knowledgePage({ nextBefore, ...page }: Awaited<ReturnType<TeamKnowledgePort["read"]>>) {
  return { ...page, nextCursor: nextBefore };
}
