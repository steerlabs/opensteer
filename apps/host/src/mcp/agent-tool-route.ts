import { agentToolFailureResult } from "@opensteer/agent-tools";
import { createToolOutput, opensteerToolNamespace, type RunId } from "@opensteer/core";
import {
  AgentToolRelayRequestSchema,
  agentToolHostRoutePath,
  type AgentToolRelayResponse,
} from "@opensteer/protocol/agent-tool-relay";
import { redactToolArgumentsForStorage } from "@opensteer/protocol/command-table";
import type { FastifyInstance } from "fastify";
import type { AgentToolActivityStore } from "@opensteer/database";
import type { RealtimeHub } from "@opensteer/orchestration";
import { digestToolArgumentsWithSecrets } from "../commands/secret-digest.js";
import type { AgentCallerResolver, RunCaller } from "./agent-caller.js";
import type { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { fingerprint } from "./operations.js";
import { agentToolFailure } from "./agent-tool-failure.js";

type Context = Pick<
  RunCaller["claims"],
  "runId" | "threadId" | "environmentId" | "bindingGeneration"
>;
const unknownOutcome = () =>
  agentToolFailureResult({
    code: "outcome_unknown",
    message: "The previous call’s complete result is unavailable; its effects may have completed.",
    next: "Observe the result before making another effectful call.",
  });

export function registerAgentToolRoute(
  app: FastifyInstance,
  options: {
    readonly callers: Pick<AgentCallerResolver, "authenticate">;
    readonly service: Pick<
      OpensteerMcpService,
      "callToolResult" | "validateToolInput" | "assertToolOffered" | "authorizeReplay"
    >;
    readonly activity: Pick<AgentToolActivityStore, "start" | "complete">;
    readonly realtime: Pick<RealtimeHub, "observeScopes">;
    readonly secretDigestKey: Buffer;
  },
): void {
  if (options.secretDigestKey.byteLength === 0) {
    throw new Error("Agent tool relay route requires a non-empty secretDigestKey.");
  }
  const active = new Map<
    string,
    {
      fingerprint: string;
      result: Promise<AgentToolRelayResponse>;
      admitted: string | undefined;
    }
  >();
  const controllers = new Map<AbortController, { token: string; runId: RunId }>();
  const unobserve = options.realtime.observeScopes(["authority"], () => {
    for (const [controller, call] of controllers)
      void options.callers.authenticate(call.token).then(
        (caller) => {
          if (caller.kind !== "run" || caller.claims.runId !== call.runId)
            controller.abort(new DOMException("Run tool authority ended", "AbortError"));
        },
        () => controller.abort(new DOMException("Run tool authority ended", "AbortError")),
      );
  });
  app.addHook("onClose", async () => {
    unobserve();
    for (const controller of controllers.keys())
      controller.abort(new DOMException("Host closed", "AbortError"));
    await Promise.allSettled([...active.values()].map((call) => call.result));
  });
  app.post(agentToolHostRoutePath, { bodyLimit: 1_048_576 }, async (request, reply) => {
    const controller = new AbortController();
    const disconnect = () =>
      controller.abort(new DOMException("Harness disconnected", "AbortError"));
    reply.raw.once("close", disconnect);
    if (reply.raw.destroyed) disconnect();
    const authorization = request.headers.authorization;
    let caller: RunCaller;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
    try {
      const authenticated = await options.callers.authenticate(token);
      if (authenticated.kind !== "run") throw new Error("Run token required");
      caller = authenticated;
    } catch {
      return reply.code(401).send({
        error: {
          code: "access_denied",
          message: "A current Run tool token is required.",
          next: null,
        },
      });
    }
    const parsed = AgentToolRelayRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send(agentToolFailureResult(agentToolFailure(parsed.error, "write")));
    const { callId: uuid, name, input } = parsed.data;
    const context: Context = caller.claims;
    const callId = `harness:${context.runId}:${context.bindingGeneration}:${uuid}`;
    let args: unknown = null;
    try {
      args = options.service.validateToolInput(name, input);
    } catch {
      // Rejected input is never persisted; its failed call still gets an activity pair.
    }
    // An earlier result is returned only under the authority it was produced under: the call's
    // own checks pass again now, and a lineaged Run's grant revision and mode are unchanged.
    const admitted = admittedUnder(caller);
    const replayable = async (
      producedUnder: string | undefined,
    ): Promise<AgentToolRelayResponse | null> => {
      if (admitted !== undefined && producedUnder !== admitted)
        return agentToolFailureResult({
          code: "access_denied",
          message:
            "This agent's access changed after the call ran, so its earlier result is not returned. Check the current state.",
          next: null,
        });
      return options.service.authorizeReplay(caller, name, input).then(
        () => null,
        (error: unknown) => agentToolFailureResult(agentToolFailure(error, "write")),
      );
    };
    const requestFingerprint = fingerprint({ name, input });
    const pending = active.get(callId);
    if (pending) {
      if (pending.fingerprint !== requestFingerprint)
        return agentToolFailureResult({
          code: "conflict",
          message: "This callId already names different arguments.",
          next: null,
        });
      // Checked before joining and again before answering: authority can end while it waits.
      const early = await replayable(pending.admitted);
      if (early) return early;
      const joined = await pending.result;
      return (await replayable(pending.admitted)) ?? joined;
    }
    const deadline = request.headers["x-opensteer-deadline"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadline !== undefined) {
      const at = typeof deadline === "string" ? Number(deadline) : NaN;
      if (!Number.isSafeInteger(at) || at <= Date.now())
        return reply.code(400).send({
          error: {
            code: "invalid_input",
            message: "The call deadline has expired or is invalid.",
            next: null,
          },
        });
      timer = setTimeout(
        () => controller.abort(new DOMException("Tool deadline ended", "AbortError")),
        Math.min(2_147_483_647, at - Date.now()),
      );
    }
    controllers.set(controller, { token, runId: context.runId });
    const result = (async (): Promise<AgentToolRelayResponse> => {
      let started: Awaited<ReturnType<AgentToolActivityStore["start"]>>["handle"] | undefined;
      try {
        controller.signal.throwIfAborted();
        const recordedArgs = redactToolArgumentsForStorage(args, {
          namespace: opensteerToolNamespace,
          name,
        });
        const argumentDigest =
          recordedArgs !== args
            ? digestToolArgumentsWithSecrets(options.secretDigestKey, { toolName: name, args })
            : undefined;
        const activity = await options.activity.start(
          context,
          callId,
          name,
          recordedArgs,
          argumentDigest,
        );
        started = activity.handle;
        if (activity.completed) {
          // Durable output is bounded and sanitized like every engine-reported tool result.
          if (activity.completed.output.truncation) return unknownOutcome();
          let replay: AgentToolRelayResponse;
          try {
            replay = JSON.parse(activity.completed.output.text) as AgentToolRelayResponse;
          } catch {
            return unknownOutcome();
          }
          const meta = replay._meta as Record<string, unknown> | undefined;
          const producedUnder = meta?.[admittedKey];
          const refused = await replayable(
            typeof producedUnder === "string" ? producedUnder : undefined,
          );
          if (refused) return refused;
          if (meta?.["opensteer/harness-activity-only"]) return unknownOutcome();
          const { [admittedKey]: _admitted, ...rest } = meta ?? {};
          const { _meta: _stored, ...result } = replay;
          return (
            Object.keys(rest).length ? { ...result, _meta: rest } : result
          ) as AgentToolRelayResponse;
        }
        const response = activity.replay
          ? unknownOutcome()
          : await options.service.callToolResult(token, name, input, {
              operationKey: callId,
              signal: controller.signal,
            });
        await options.activity.complete(
          started,
          activityOutput(response, admitted),
          response.isError === true,
        );
        return response;
      } catch (error) {
        const response = agentToolFailureResult(agentToolFailure(error, "write"));
        if (started) {
          await options.activity.complete(started, activityOutput(response), true);
        }
        return response;
      } finally {
        clearTimeout(timer);
        reply.raw.off("close", disconnect);
        controllers.delete(controller);
      }
    })();
    active.set(callId, { fingerprint: requestFingerprint, result, admitted });
    try {
      return await result;
    } finally {
      if (active.get(callId)?.result === result) active.delete(callId);
    }
  });
}

/** Where a stored result records the authority it was produced under. */
const admittedKey = "opensteer/admitted-under";
/** A lineaged Run's grant revision and mode; undefined for the person's own work. */
function admittedUnder(caller: RunCaller): string | undefined {
  return caller.agentConnection
    ? `${caller.agentConnection.grantRevision}:${caller.accessMode}`
    : undefined;
}

function activityOutput(response: AgentToolRelayResponse, admitted?: string) {
  // Inline image bytes stay on the result transport, never in incidental task activity.
  const image = response.content.some((block) => block.type === "image");
  const meta = {
    ...response._meta,
    ...(admitted !== undefined ? { [admittedKey]: admitted } : {}),
    ...(image ? { "opensteer/harness-activity-only": true } : {}),
  };
  return createToolOutput(
    JSON.stringify({
      ...response,
      ...(Object.keys(meta).length ? { _meta: meta } : {}),
      ...(image ? { structuredContent: undefined } : {}),
      content: response.content.map((block) =>
        block.type === "image"
          ? { type: "text", text: "[Tool image omitted from activity]" }
          : block,
      ),
    }),
  );
}
