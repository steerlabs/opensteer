import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  OpensteerError,
  ProjectEngineRequestSchema,
  type HarnessExecutionAuthority,
  type ProjectEngineRequestEvent,
  type PendingRequest,
} from "@opensteer/core";
import type {
  EngineHarnessEvent,
  EngineHarnessSession,
  HarnessSession,
  HarnessSessionContext,
  ProjectHarnessSession,
  ProjectHarnessSessionContext,
} from "./types.js";

export function projectEngineContext(context: ProjectHarnessSessionContext): HarnessSessionContext {
  if (
    context.runtimeBoundary.kind !== "isolated-service" ||
    context.providerState.kind !== "isolated"
  )
    throw new Error("Project engines require isolated provider state");
  const { binding, ...common } = context;
  if (
    binding.environmentId !== context.environmentId ||
    binding.threadId !== context.threadId ||
    binding.workspaceId !== context.workspaceId
  )
    throw new Error("Project session does not match its binding");
  return {
    ...common,
    machineAccessNotice: "",
    machineAccessPlatform: undefined,
    machineAccessRelaySocket: undefined,
  };
}

export function personHarnessSession(session: EngineHarnessSession): HarnessSession {
  return {
    get providerSessionReference() {
      return session.providerSessionReference;
    },
    // The person facade admits only person inputs; preserve the original stream's delivery timing.
    events: session.events as AsyncIterable<import("./types.js").HarnessEvent>,
    execute: (run) => {
      if (run.executionAuthority) throw new Error("Project input on person session");
      return session.execute(run);
    },
    interrupt: () => session.interrupt(),
    ...(session.stopNode
      ? {
          stopNode: (nodeId: Parameters<NonNullable<HarnessSession["stopNode"]>>[0]) =>
            session.stopNode!(nodeId),
        }
      : {}),
    ...(session.steer
      ? {
          steer: (input: Parameters<NonNullable<HarnessSession["steer"]>>[0]) =>
            session.steer!(input),
        }
      : {}),
    resolveRequest: (id, response) => session.resolveRequest(id, response),
    stop: () => session.stop(),
    ...(session.rebind
      ? { rebind: (context: HarnessSessionContext) => session.rebind!(context) }
      : {}),
    ...(session.releaseForReuse ? { releaseForReuse: () => session.releaseForReuse!() } : {}),
  };
}

export function projectHarnessSession(
  session: EngineHarnessSession,
  context: ProjectHarnessSessionContext,
): ProjectHarnessSession {
  return {
    get providerSessionReference() {
      return session.providerSessionReference;
    },
    events: (async function* () {
      for await (const event of session.events) {
        if (event.type === "request.opened" || event.type === "voice.heard")
          throw new Error("Personal event on Project session");
        // Node stopping is person-only until its control carries the Project binding.
        if (event.type === "node.started" && event.data.stopSupported !== undefined) {
          yield { ...event, data: { ...event.data, stopSupported: false } };
        } else if (event.type === "node.updated") {
          const { stopping: _stopping, ...data } = event.data;
          yield {
            ...event,
            data: {
              ...data,
              ...(data.stopSupported !== undefined ? { stopSupported: false } : {}),
            },
          };
        } else yield event;
      }
    })(),
    execute: (run) => {
      if (
        canonicalJson(run.executionAuthority.binding) !== canonicalJson(context.binding) ||
        run.runId !== context.binding.runId
      )
        throw new Error("Project Run does not match its session binding");
      return session.execute(run);
    },
    interrupt: () => session.interrupt(),
    ...(session.steer
      ? {
          steer: (input: Parameters<NonNullable<HarnessSession["steer"]>>[0]) =>
            session.steer!(input),
        }
      : {}),
    resolveRequest: (id, response) => session.resolveRequest(id, response),
    refuseRequest: (id, callId, reason) => session.refuseRequest(id, callId, reason),
    stop: () => session.stop(),
  };
}

export function engineRequestEvent(
  authority: HarnessExecutionAuthority,
  request: Omit<PendingRequest, "requestedBy">,
): Extract<EngineHarnessEvent, { type: "request.opened" }> | ProjectEngineRequestEvent {
  if (authority.kind === "person")
    return {
      type: "request.opened",
      data: { request: { ...request, requestedBy: authority.requestedBy } },
    };
  return {
    type: "request.proposed.project",
    binding: authority.binding,
    data: {
      request: ProjectEngineRequestSchema.parse({
        id: request.id,
        callId: request.callId,
        createdAt: request.createdAt,
        mode: request.mode,
        ...(request.originatingNodeId ? { originatingNodeId: request.originatingNodeId } : {}),
        kind: request.kind,
        requestClass: request.kind === "harness.input" ? "question" : "harness-approval",
        payload: request.payload,
        presentation: request.presentation,
      }),
    },
  };
}

export function assertEngineRunBinding(
  run: import("./types.js").EngineHarnessRunInput,
  context: HarnessSessionContext,
): HarnessExecutionAuthority {
  if (!run.executionAuthority) return { kind: "person", requestedBy: run.requestedBy };
  const binding = run.executionAuthority.binding;
  if (
    binding.runId !== run.runId ||
    binding.environmentId !== context.environmentId ||
    binding.threadId !== context.threadId ||
    binding.workspaceId !== context.workspaceId ||
    context.voiceCall
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Project Run does not match its engine session",
    });
  return run.executionAuthority;
}
