import { setTimeout as delay } from "node:timers/promises";
import {
  OpensteerError,
  voiceModelSelection,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  rpcSuccess,
  VoiceRefusalReasonSchema,
  type HostApiHandlers,
  type HostApiServerContext,
  type RunnerVoiceCommand,
} from "@opensteer/protocol";
import type { ThreadService } from "../threads/thread-service.js";

/** How long a new call waits for what is running on the Voice Thread to end, and how often it looks. */
const voiceThreadWaitMs = 10_000;
const voiceThreadRetryMs = 150;
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
    | "getThreadForOwner"
    | "openVoiceThread"
    | "startVoiceCall"
    | "resolveVoiceCall"
    | "stopVoiceCall"
  >;
  readonly runners: Pick<RunnerRegistry, "voice">;
  readonly threads: Pick<ThreadService, "configure">;
  readonly publishDeploymentEvent?: (event: AgentEvent) => void;
}): Pick<
  HostApiHandlers,
  "voice.open" | "voice.start" | "voice.renew" | "voice.say" | "voice.context" | "voice.stop"
> {
  const owner = (context: HostApiServerContext) => {
    const id = context.session?.user.id;
    if (!id)
      throw new OpensteerError({
        code: "unauthorized",
        message: "Sign in to use voice.",
      });
    return id;
  };
  const stop = async (sessionId: string, context: HostApiServerContext) => {
    const result = await dependencies.store.stopVoiceCall(owner(context), sessionId);
    for (const event of result?.events ?? []) dependencies.publishDeploymentEvent?.(event);
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
      | Omit<
          Extract<
            RunnerVoiceCommand,
            {
              action: "renew";
            }
          >,
          "runId" | "sessionId"
        >
      | {
          action: "say";
          id: string;
          text: string;
        }
      | {
          action: "context";
          view: Extract<
            RunnerVoiceCommand,
            {
              action: "context";
            }
          >["view"];
        },
  ) => {
    const call = await callFor(sessionId, context);
    const result = await dependencies.runners.voice(
      call.environmentId,
      owner(context),
      {
        ...command,
        sessionId,
        runId: call.runId,
      },
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
  const usableCatalog = async (
    ownerId: UserId,
    input: {
      environmentId: EnvironmentId;
      harnessInstanceId: HarnessInstanceId;
    },
  ) => {
    if (!(await dependencies.store.environmentIsAvailableToUser(input.environmentId, ownerId)))
      return null;
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
      return null;
    const catalog = await dependencies.store.getHarnessCatalog(
      input.environmentId,
      input.harnessInstanceId,
    );
    return catalog?.connections.some(
      (c) => c.authKind === "subscription" && c.status === "connected",
    )
      ? catalog
      : null;
  };
  const requireAccount = async (
    ownerId: UserId,
    input: {
      environmentId: EnvironmentId;
      harnessInstanceId: HarnessInstanceId;
    },
  ) => {
    const catalog = await usableCatalog(ownerId, input);
    if (!catalog) throw unavailable();
    return catalog;
  };
  /** Waits out whatever is finishing on the Voice Thread; the store has asked it to stop. */
  const admit = async (
    ownerId: UserId,
    input: {
      sessionId: string;
      environmentId: EnvironmentId;
      harnessInstanceId: HarnessInstanceId;
    },
    context: HostApiServerContext,
  ) => {
    const deadline = Date.now() + voiceThreadWaitMs;
    for (;;) {
      const call = await dependencies.store.startVoiceCall({
        ownerId,
        sessionId: input.sessionId,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
      });
      for (const event of call.events) dependencies.publishDeploymentEvent?.(event);
      if (!call.busy) return call;
      if (Date.now() >= deadline)
        throw new OpensteerError({
          code: "conflict",
          reason: "voice-refused",
          message: "The Voice Thread is still finishing something else.",
        });
      await delay(voiceThreadRetryMs, undefined, {
        signal: context.signal,
      });
    }
  };
  return {
    "voice.open": async (input, context) => {
      const ownerId = owner(context);
      const catalog = await requireAccount(ownerId, input);
      const { events, ...opened } = await dependencies.store.openVoiceThread({
        ownerId,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        ...(input.accessMode
          ? {
              accessMode: input.accessMode,
            }
          : {}),
      });
      for (const event of events) dependencies.publishDeploymentEvent?.(event);
      if (
        opened.harnessInstanceId === input.harnessInstanceId ||
        opened.environmentId !== input.environmentId ||
        (await usableCatalog(ownerId, opened))
      )
        return rpcSuccess(opened);
      // Its account is gone. A Thread can't change computer, but it can change account here.
      const thread = await dependencies.store.getThreadForOwner(opened.threadId, ownerId);
      const modelSelection = voiceModelSelection(catalog);
      if (!thread || !modelSelection) throw unavailable();
      await dependencies.threads.configure(
        {
          kind: "person",
          userId: ownerId,
        },
        {
          continuation: {
            expectedProviderSessionId: thread.providerSessionId,
          },
          harnessInstanceId: input.harnessInstanceId,
          idempotencyKey: `voice-move:${thread.providerSessionId ?? thread.id}:${input.harnessInstanceId}`,
          modelSelection,
          threadId: thread.id,
          type: "thread.execution.update",
        },
      );
      return rpcSuccess({
        ...opened,
        harnessInstanceId: input.harnessInstanceId,
      });
    },
    "voice.start": async (input, context) => {
      const ownerId = owner(context);
      await requireAccount(ownerId, input);
      const call = await admit(ownerId, input, context);
      try {
        if (
          call.threadStatus === "archived" ||
          !["queued", "starting", "running", "waiting"].includes(call.status)
        )
          throw ended();
        const result = await dependencies.runners.voice(
          call.environmentId,
          ownerId,
          {
            action: "start",
            sessionId: input.sessionId,
            runId: call.runId,
            offer: input.offer,
          },
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
    "voice.renew": (input, context) =>
      relay(input.sessionId, context, {
        action: "renew",
      }),
    "voice.say": (input, context) =>
      relay(input.sessionId, context, {
        action: "say",
        id: input.id,
        text: input.text,
      }),
    "voice.context": (input, context) =>
      relay(input.sessionId, context, {
        action: "context",
        view: input.view,
      }),
    "voice.stop": async (input, context) => {
      await stop(input.sessionId, context);
      return rpcSuccess({});
    },
  };
}
