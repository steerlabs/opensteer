import { z } from "zod";

/**
 * What a tool does to Opensteer, which decides the checks every call passes
 * before its handler runs and again when its effect commits:
 *
 * - `read` reads records within the caller's reach.
 * - `self` acts only on the caller's own Thread, Run or person.
 * - `thread` changes an existing Thread within reach whose access mode does
 *   not exceed the caller's.
 * - `work` starts or redirects work, which must not exceed the caller's
 *   access mode or resources.
 * - `settings` changes the Deployment or a Workspace, and needs full access.
 */
export const AgentToolAccessSchema = z.enum(["read", "self", "thread", "work", "settings"]);
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
