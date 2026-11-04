import { OpensteerError, type AgentEvent } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  rpcSuccess,
  VoiceRefusalReasonSchema,
  type HostApiHandlers,
  type HostApiServerContext,
  type RunnerVoiceCommand,
} from "@opensteer/protocol";

const ended = () =>
  new OpensteerError({
    code: "conflict",
    reason: "voice-ended",
    message: "This voice call has ended.",
  });
const unavailable = () =>
  new OpensteerError({
    code: "forbidden",
    reason: "voice-account-unavailable",
    message: "Voice requires your signed-in ChatGPT account on this computer.",
  });
export function createVoiceHandlers(dependencies: {
  readonly store: Pick<
    OpensteerStore,
    | "environmentIsAvailableToUser"
    | "listAgentHarnessInstancesForUser"
    | "getHarnessCatalog"
    | "startVoiceCall"
    | "resolveVoiceCall"
    | "stopVoiceCall"
  >;
  readonly runners: Pick<RunnerRegistry, "voice">;
  readonly publishWorkspaceEvent?: (event: AgentEvent) => void;
}): Pick<
  HostApiHandlers,
  "voice.start" | "voice.renew" | "voice.say" | "voice.context" | "voice.stop"
> {
  const owner = (context: HostApiServerContext) => {
    const id = context.session?.user.id;
    if (!id) throw new OpensteerError({ code: "unauthorized", message: "Sign in to use voice." });
    return id;
  };
  const stop = async (sessionId: string, context: HostApiServerContext) => {
    const result = await dependencies.store.stopVoiceCall(owner(context), sessionId);
    for (const event of result?.events ?? []) dependencies.publishWorkspaceEvent?.(event);
  };
  const callFor = async (sessionId: string, context: HostApiServerContext) => {
    const call = await dependencies.store.resolveVoiceCall(owner(context), sessionId);
    if (
      !call ||
      call.threadStatus === "archived" ||
      !["queued", "starting", "running", "waiting"].includes(call.status)
    )
      throw ended();
    return call;
  };
  const relay = async (
    sessionId: string,
    context: HostApiServerContext,
    command:
      | Omit<Extract<RunnerVoiceCommand, { action: "renew" }>, "runId" | "sessionId">
      | { action: "say"; id: string; text: string }
      | { action: "context"; view: Extract<RunnerVoiceCommand, { action: "context" }>["view"] },
  ) => {
    const call = await callFor(sessionId, context);
    const result = await dependencies.runners.voice(
      call.environmentId,
      owner(context),
      { ...command, sessionId, runId: call.runId },
      context.signal,
    );
    if (!result.ok)
      throw new OpensteerError({
        code: "conflict",
        reason: result.reason,
        message: result.message,
      });
    return rpcSuccess({});
  };
  return {
    "voice.start": async (input, context) => {
      const ownerId = owner(context);
      if (!(await dependencies.store.environmentIsAvailableToUser(input.environmentId, ownerId)))
        throw unavailable();
      const [profile] = await dependencies.store.listAgentHarnessInstancesForUser(ownerId, {
        id: input.harnessInstanceId,
        limit: 1,
      });
      if (
        !profile ||
        profile.id !== input.harnessInstanceId ||
        profile.environmentId !== input.environmentId ||
        !profile.enabled ||
        profile.removedAt ||
        profile.driverKind !== "codex"
      )
        throw unavailable();
      const catalog = await dependencies.store.getHarnessCatalog(
        input.environmentId,
        input.harnessInstanceId,
      );
      if (
        !catalog?.connections.some((c) => c.authKind === "subscription" && c.status === "connected")
      )
        throw unavailable();
      const call = await dependencies.store.startVoiceCall({
        ownerId,
        sessionId: input.sessionId,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
      });
      for (const event of call.events) dependencies.publishWorkspaceEvent?.(event);
      try {
        if (
          call.threadStatus === "archived" ||
          !["queued", "starting", "running", "waiting"].includes(call.status)
        )
          throw ended();
        const result = await dependencies.runners.voice(
          call.environmentId,
          ownerId,
          { action: "start", sessionId: input.sessionId, runId: call.runId, offer: input.offer },
          context.signal,
        );
        if (!result.ok)
          throw new OpensteerError({
            code: "conflict",
            reason: result.reason,
            message: "The computer could not start this voice call.",
          });
        if (!result.answer)
          throw new OpensteerError({
            code: "conflict",
            reason: "voice-refused",
            message: "Codex returned no voice answer.",
          });
        return rpcSuccess({
          answer: result.answer,
          threadId: call.threadId,
          runId: call.runId,
          workspaceId: call.workspaceId,
        });
      } catch (error) {
        const reason = VoiceRefusalReasonSchema.safeParse(
          error instanceof OpensteerError ? error.reason : undefined,
        );
        await stop(input.sessionId, context);
        throw new OpensteerError({
          code: "conflict",
          reason: reason.success ? reason.data : "voice-refused",
          message: "The voice call could not start.",
        });
      }
    },
    "voice.renew": (input, context) => relay(input.sessionId, context, { action: "renew" }),
    "voice.say": (input, context) =>
      relay(input.sessionId, context, { action: "say", id: input.id, text: input.text }),
    "voice.context": (input, context) =>
      relay(input.sessionId, context, { action: "context", view: input.view }),
    "voice.stop": async (input, context) => {
      await stop(input.sessionId, context);
      return rpcSuccess({});
    },
  };
}
