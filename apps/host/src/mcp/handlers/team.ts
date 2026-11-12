import {
  OpensteerError,
  type RunId,
  type TeamAgentRequestId,
  type ThreadId,
} from "@opensteer/core";
import type { AgentToolHandlers, ToolCall } from "./types.js";
import type { TeamToolPort } from "../team-tool-port.js";

type TeamToolName = "team_read" | "team_search" | "team_reply" | "sql";
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
    const run = { teamId: origin.teamId, requestId, runId: caller.claims.runId };
    switch (name) {
      case "team_read":
        return options.port.read(run, call.input as ToolCall<"team_read">["input"], call.signal);
      case "team_search":
        return options.port.search(
          run,
          call.input as ToolCall<"team_search">["input"],
          call.signal,
        );
      case "team_reply":
        return options.port.reply(run, call.input as ToolCall<"team_reply">["input"], call.signal);
      case "sql":
        return options.port.sql(run, call.input as ToolCall<"sql">["input"], call.signal);
    }
  };
  return {
    team_read: (call) => invoke("team_read", call),
    team_search: (call) => invoke("team_search", call),
    team_reply: (call) => invoke("team_reply", call),
    sql: (call) => invoke("sql", call),
  };
}
