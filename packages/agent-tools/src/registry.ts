import { z } from "zod";

/** Writes enforce the caller's access ceiling.
 * Settings require full access as well as write authority. */
export const AgentToolAccessSchema = z.enum(["read", "write", "settings"]);
export type AgentToolAccess = z.infer<typeof AgentToolAccessSchema>;

/**
 * Who can hold a tool. A Run is an engine turn with a Thread, Runner and live
 * places; a program is a Trigger or Watch program running for its anchor
 * Thread; a connection is an external agent the person approved. A tool that
 * needs what only a Run has is not offered to the others.
 */
export const AgentCallerKindSchema = z.enum(["run", "program", "connection"]);
export type AgentCallerKind = z.infer<typeof AgentCallerKindSchema>;

/**
 * One tool, defined once. Its input is validated in full on every call; its
 * output is what the caller receives, so anything the output schema does not
 * name never leaves the Host.
 */
export interface AgentToolSpec<
  Name extends string = string,
  Input extends z.ZodObject = z.ZodObject,
  Output extends z.ZodType = z.ZodType,
> {
  readonly access: AgentToolAccess;
  /** A call that only reads, so it needs read access whatever the tool's own. */
  readsOnly?(input: z.output<Input>): boolean;
  /** Present for the lifetime of a task bound to a team thread. */
  readonly team?: true;
  /** Overrides the schema derived from `input` when a union reads poorly to models. */
  readonly advertisedInputSchema?: Readonly<Record<string, unknown>>;
  readonly callers: readonly AgentCallerKind[];
  readonly description: string;
  readonly destructive?: true;
  readonly input: Input;
  readonly name: Name;
  /** Reaches outside Opensteer, such as a third-party service or a page. */
  readonly openWorld?: true;
  readonly output: Output;
  readonly title: string;
  readonly targetFields?: readonly string[];
}

export type AnyAgentToolSpec = AgentToolSpec<string, z.ZodObject, z.ZodType>;

export function defineAgentTool<
  const Name extends string,
  Input extends z.ZodObject,
  Output extends z.ZodType,
>(spec: AgentToolSpec<Name, Input, Output>): AgentToolSpec<Name, Input, Output> {
  if (spec.callers.length === 0) throw new Error(`${spec.name} has no callers`);
  return Object.freeze(spec);
}

export interface AgentToolAnnotations {
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
  readonly readOnlyHint: boolean;
  readonly title: string;
}

export function agentToolAnnotations(spec: AnyAgentToolSpec): AgentToolAnnotations {
  return {
    destructiveHint: spec.destructive === true,
    idempotentHint: spec.access === "read",
    openWorldHint: spec.openWorld === true,
    readOnlyHint: spec.access === "read",
    title: spec.title,
  };
}
