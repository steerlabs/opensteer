import { OpensteerError, type EnvironmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  rpcSuccess,
  type HostApiHandlers,
  type RunnerVoiceCommand,
  type HostApiServerContext,
} from "@opensteer/protocol";

const unavailable = () =>
  new OpensteerError({
    code: "forbidden",
    reason: "voice-account-unavailable",
    message: "Voice requires your signed-in ChatGPT account on this computer.",
  });

export function createVoiceHandlers(dependencies: {
  readonly store: Pick<
    OpensteerStore,
    "environmentIsAvailableToUser" | "listAgentHarnessInstancesForUser" | "getHarnessCatalog"
  >;
  readonly runners: Pick<RunnerRegistry, "voice">;
}): Pick<HostApiHandlers, "voice.start" | "voice.renew" | "voice.say" | "voice.stop"> {
  const relay = async (
    environmentId: EnvironmentId,
    command: RunnerVoiceCommand,
    context: HostApiServerContext,
  ) => {
    const userId = context.session?.user.id;
    if (!userId)
      throw new OpensteerError({ code: "unauthorized", message: "Sign in to use voice." });
    if (!(await dependencies.store.environmentIsAvailableToUser(environmentId, userId)))
      throw unavailable();
    const [profile] = await dependencies.store.listAgentHarnessInstancesForUser(userId, {
      id: command.harnessInstanceId,
      limit: 1,
    });
    if (
      !profile ||
      profile.id !== command.harnessInstanceId ||
      profile.environmentId !== environmentId ||
      !profile.enabled ||
      profile.removedAt ||
      profile.driverKind !== "codex"
    )
      throw unavailable();
    const catalog = await dependencies.store.getHarnessCatalog(
      environmentId,
      command.harnessInstanceId,
    );
    if (
      !catalog?.connections.some(
        (connection) => connection.authKind === "subscription" && connection.status === "connected",
      )
    )
      throw unavailable();
    const result = await dependencies.runners.voice(environmentId, userId, command, context.signal);
    if (!result.ok)
      throw new OpensteerError({
        code: "conflict",
        reason: result.reason,
        message: result.message,
      });
    return result;
  };
  return {
    "voice.start": async (input, context) => {
      const result = await relay(
        input.environmentId,
        {
          action: "start",
          sessionId: input.sessionId,
          harnessInstanceId: input.harnessInstanceId,
          offer: input.offer,
        },
        context,
      );
      if (!result.answer)
        throw new OpensteerError({
          code: "conflict",
          reason: "voice-refused",
          message: "Codex returned no voice answer.",
        });
      return rpcSuccess({ answer: result.answer });
    },
    "voice.renew": async (input, context) => {
      await relay(
        input.environmentId,
        { action: "renew", sessionId: input.sessionId, harnessInstanceId: input.harnessInstanceId },
        context,
      );
      return rpcSuccess({});
    },
    "voice.say": async (input, context) => {
      await relay(
        input.environmentId,
        {
          action: "say",
          sessionId: input.sessionId,
          harnessInstanceId: input.harnessInstanceId,
          text: input.text,
        },
        context,
      );
      return rpcSuccess({});
    },
    "voice.stop": async (input, context) => {
      await relay(
        input.environmentId,
        { action: "stop", sessionId: input.sessionId, harnessInstanceId: input.harnessInstanceId },
        context,
      );
      return rpcSuccess({});
    },
  };
}
