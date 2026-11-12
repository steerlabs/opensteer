import type { AgentTool } from "@opensteer/agent-tools";
import type { z } from "zod";
import type { AgentCaller } from "../agent-caller.js";

type ToolByName = { [T in AgentTool as T["name"]]: T };
export type ToolInput<Name extends AgentTool["name"]> = z.output<ToolByName[Name]["input"]>;
export type ToolCall<Name extends AgentTool["name"]> = {
  readonly caller: AgentCaller;
  readonly input: ToolInput<Name>;
  readonly operationKey: string;
  readonly signal?: AbortSignal;
  readonly checkLive?: () => Promise<void>;
};
// Domains may return richer records; callTool validates and projects the wire output once.
export type AgentToolHandlers = {
  [T in AgentTool as T["name"]]: ((call: ToolCall<T["name"]>) => Promise<unknown>) & {
    readonly targets?: (call: ToolCall<T["name"]>) => Promise<readonly string[]>;
    readonly authorize?: (call: ToolCall<T["name"]>) => Promise<void>;
  };
};
