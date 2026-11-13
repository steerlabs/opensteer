import {
  OpensteerError,
  type RunId,
  type TeamAgentRequestId,
  type ThreadId,
} from "@opensteer/core";
import type { AgentToolHandlers, ToolCall } from "./types.js";
import type { TeamKnowledgePort, TeamToolPort } from "../team-tool-port.js";

type TeamToolName = "team_read" | "team_search" | "team_post";
export function teamToolHandlers(options: {
  readonly port: TeamToolPort | undefined;
  readonly requestForRun: (runId: RunId, threadId: ThreadId) => Promise<TeamAgentRequestId | null>;
}): Pick<AgentToolHandlers, TeamToolName> {
  const invoke = async <Name extends TeamToolName>(
    name: Name,
    call: ToolCall<Name>,
  ): Promise<unknown> => {
    const caller = call.caller;
    if (caller.kind !== "run")
      throw new OpensteerError({ code: "forbidden", message: "This tool requires a live Run" });
    const origin = caller.thread.teamOrigin;
    const requestId = await options.requestForRun(caller.claims.runId, caller.thread.id);
    if (!origin || !requestId)
      throw new OpensteerError({ code: "forbidden", message: "no team request in this turn" });
    if (!options.port)
      throw new OpensteerError({ code: "conflict", message: "The team link is unavailable" });
    await call.checkLive?.();
    const run = { operationId: call.operationKey, runId: caller.claims.runId };
    switch (name) {
      case "team_read":
        return options.port.read(run, call.input as ToolCall<"team_read">["input"], call.signal);
      case "team_search":
        return options.port.search(
          run,
          call.input as ToolCall<"team_search">["input"],
          call.signal,
        );
      case "team_post":
        return options.port.post(run, call.input as ToolCall<"team_post">["input"], call.signal);
    }
  };
  return {
    team_read: (call) => invoke("team_read", call),
    team_search: (call) => invoke("team_search", call),
    team_post: (call) => invoke("team_post", call),
  };
}

type KnowledgeToolName = "knowledge_topics" | "knowledge_read" | "knowledge_write";
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
      case "knowledge_topics":
        return options.port.topics(
          knowledgeCaller,
          call.input as ToolCall<"knowledge_topics">["input"],
          call.signal,
        );
      case "knowledge_read":
        return options.port.read(
          knowledgeCaller,
          call.input as ToolCall<"knowledge_read">["input"],
          call.signal,
        );
      case "knowledge_write":
        return options.port.write(
          knowledgeCaller,
          call.input as ToolCall<"knowledge_write">["input"],
          call.signal,
        );
    }
  };
  return {
    knowledge_topics: (call) => invoke("knowledge_topics", call),
    knowledge_read: (call) => invoke("knowledge_read", call),
    knowledge_write: (call) => invoke("knowledge_write", call),
  };
}
