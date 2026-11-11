import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { createHash } from "node:crypto";
import { OpensteerError, type Thread } from "@opensteer/core";
import type {
  RunToolAdmissionInput,
  AgentThreadListScope,
  ThreadMutationAdmission,
  ThreadCallerAuthority,
} from "@opensteer/database";
import {
  callerThread,
  type AgentCaller,
  type HumanAgentCaller,
  type RunCaller,
} from "./agent-caller.js";
import { mcpToolCallId } from "../integrations/mcp-call-id.js";
import { assertCallerReach, write as assertThreadAccess } from "./tool-access.js";

export function fingerprint(input: unknown): string {
  const value =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "operationKey"))
      : input;
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function operationId(caller: AgentCaller, operationKey: string, tool: string): string {
  return mcpToolCallId(caller.key, operationKey, "operation", tool);
}
export function requireRun(caller: AgentCaller): RunCaller {
  if (caller.kind !== "run")
    throw new OpensteerError({ code: "forbidden", message: "This tool requires a live Run" });
  return caller;
}
export function callerContext(caller: HumanAgentCaller) {
  const thread = callerThread(caller);
  return {
    requestedBy: caller.userId,
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    environmentId: thread.environmentId,
  };
}
export function callerListScope(caller: AgentCaller): AgentThreadListScope {
  const scope = caller.reach;
  return scope.kind === "lineage" ? { kind: "lineage", threadId: callerThread(caller).id } : scope;
}
export function assertTarget(caller: AgentCaller, target: Thread) {
  assertCallerReach(caller, target);
}
const actions = {
  thread_delegate: "thread.delegate",
  thread_message: "thread.message",
  person_message: "person.message",
  person_show: "person.show",
  thread_update: "thread.write",
  task_cancel: "assignment.cancel",
} as const;
type AdmittedTool = keyof typeof actions;
export function runAdmission(
  caller: HumanAgentCaller,
  tool: AdmittedTool,
  input: unknown,
  requestId: string,
  targetThreadIds: readonly Thread["id"][] = [],
): RunToolAdmissionInput {
  const claims = requireRun(caller).claims;
  return {
    bindingGeneration: claims.bindingGeneration,
    environmentId: claims.environmentId,
    membershipGeneration: claims.membershipGeneration,
    requestedBy: claims.requestedBy,
    runId: claims.runId,
    runnerBootId: claims.runnerBootId,
    runnerId: claims.runnerId,
    workspaceId: claims.workspaceId,
    action: actions[tool],
    sourceThreadId: claims.threadId,
    requestFingerprint: fingerprint(input),
    requestId,
    accessMode: caller.accessMode,
    targetThreadIds,
  };
}
export function mutationAdmission(
  caller: HumanAgentCaller,
  tool: "thread_delegate" | "thread_message",
  input: { readonly observationId?: string | undefined },
  requestId: string,
  targetThreadIds: readonly Thread["id"][] = [],
): ThreadMutationAdmission {
  if (caller.kind === "run")
    return {
      kind: "agent",
      request: runAdmission(caller, tool, input, requestId, targetThreadIds),
    };
  if (caller.kind === "connection")
    throw new OpensteerError({ code: "forbidden", message: "A program or Run is required" });
  const p = caller.program;
  if (p.kind === "trigger")
    return {
      kind: "trigger",
      request: {
        ...p,
        action: actions[tool],
        requestFingerprint: fingerprint(input),
        requestId,
        accessMode: caller.accessMode,
        targetThreadIds,
      },
    };
  return {
    kind: "watch",
    request: {
      ...p,
      action: actions[tool],
      observationId: input.observationId ?? requestId,
      requestFingerprint: fingerprint(input),
      requestId,
      accessMode: caller.accessMode,
      targetThreadIds,
    },
  };
}
export function idempotencyKey(caller: AgentCaller, requestId: string, action: string): string {
  return `${caller.key}:${requestId}:${action}`;
}
export function delegationOrigin(caller: HumanAgentCaller, observationId: string) {
  const parentThreadId = callerThread(caller).id;
  if (caller.kind === "run")
    return { kind: "run" as const, parentRunId: caller.claims.runId, parentThreadId };
  if (caller.kind === "connection")
    throw new OpensteerError({
      code: "forbidden",
      message: "Delegation requires an anchor Thread",
    });
  const p = caller.program;
  return p.kind === "trigger"
    ? { kind: "trigger" as const, occurrenceId: p.occurrenceId, parentThreadId }
    : {
        kind: "watch" as const,
        activationId: p.activationId,
        observationId,
        parentThreadId,
        revisionId: p.revisionId,
        triggerId: p.triggerId,
      };
}
export function messageSource(caller: HumanAgentCaller, observationId: string) {
  if (caller.kind === "connection")
    return { kind: "connection" as const, connectionId: caller.connectionId };
  const origin = delegationOrigin(caller, observationId);
  if (origin.kind === "run") return { kind: "agent" as const, runId: origin.parentRunId };
  if (origin.kind === "trigger")
    return { kind: "trigger" as const, occurrenceId: origin.occurrenceId };
  return {
    kind: "watch" as const,
    activationId: origin.activationId,
    observationId,
    revisionId: origin.revisionId,
    triggerId: origin.triggerId,
  };
}
export function assertMutableTarget(caller: AgentCaller, target: Thread) {
  assertThreadAccess(caller, [target]);
}

export function toolOperationKey(caller: AgentCaller, input: object, fallback: string): string {
  if ("operationKey" in input && typeof input.operationKey === "string") return input.operationKey;
  return caller.kind === "program" &&
    caller.program.kind === "watch" &&
    "observationId" in input &&
    typeof input.observationId === "string"
    ? input.observationId
    : fallback;
}

export function threadCallerAuthority(caller: HumanAgentCaller): ThreadCallerAuthority {
  const base = { userId: caller.userId, accessMode: caller.accessMode, reach: caller.reach };
  if (caller.kind === "connection")
    return { ...base, kind: "connection", connectionId: caller.connectionId };
  if (caller.kind === "run") return { ...base, kind: "run", scope: caller.claims };
  return caller.program.kind === "trigger"
    ? { ...base, kind: "trigger", scope: caller.program }
    : { ...base, kind: "watch", scope: caller.program };
}
