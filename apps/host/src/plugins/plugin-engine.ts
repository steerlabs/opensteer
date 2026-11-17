import { randomUUID } from "node:crypto";
import { responseChunkReader } from "@opensteer/shared/boundedJson";
import { Effect, Cause, Schema } from "effect";
import { FormElicitation, type ElicitationHandler } from "apps/contracts";
import {
  EngineMessageSchema,
  HostMessageSchema,
  operations,
  callbackOperations,
  JsonSchema,
  PluginServiceError,
  PluginBrokerError,
  checkPluginOutputSize,
  parseIpcMessage,
  type PluginOperation,
  type PluginCallback,
} from "./engine-protocol.js";
import { startEngine } from "./engine-runtime.js";
import type { z } from "zod";

if (!process.send) throw new Error("Plugin engine must be started by its Host over IPC");
const send = (value: unknown) => {
  if (process.connected) process.send?.(parseIpcMessage(EngineMessageSchema, value), () => {});
};
const callbacks = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void; elicitation?: ElicitationHandler }
>();
const elicitations = new Map<string, AbortController>();
const requests = new Map<string, AbortController>();
const streams = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
let initializing: Promise<void> | undefined;
let closing = false;
const errorData = (error: unknown) => {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  return failure instanceof PluginServiceError
    ? {
        code: failure.code,
        message: failure.message,
        ...(failure.tag === undefined ? {} : { tag: failure.tag }),
      }
    : {
        code: "engine" as const,
        message: "Plugin engine operation failed",
        ...(failure !== null &&
        typeof failure === "object" &&
        "_tag" in failure &&
        typeof failure._tag === "string" &&
        /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(failure._tag)
          ? { tag: failure._tag }
          : {}),
      };
};
const callback = <K extends PluginCallback>(
  operation: K,
  input: z.infer<(typeof callbackOperations)[K]["input"]>,
  elicitation?: ElicitationHandler,
): Effect.Effect<z.infer<(typeof callbackOperations)[K]["output"]>, Error> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<z.infer<(typeof callbackOperations)[K]["output"]>>((resolve, reject) => {
        const id = randomUUID();
        const abort = () => {
          callbacks.delete(id);
          send({ type: "callbackCancel", id });
          reject(new PluginServiceError("cancelled", "Host callback cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        callbacks.set(id, {
          resolve: (result) => {
            signal.removeEventListener("abort", abort);
            resolve(
              callbackOperations[operation].output.parse(result) as z.infer<
                (typeof callbackOperations)[K]["output"]
              >,
            );
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
          ...(elicitation ? { elicitation } : {}),
        });
        try {
          send({
            type: "callback",
            id,
            operation,
            input: callbackOperations[operation].input.parse(input),
          });
        } catch (error) {
          callbacks.delete(id);
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      }),
    catch: (error) => (error instanceof Error ? error : new Error("Host callback failed")),
  });
const stop = async () => {
  if (closing) return;
  closing = true;
  for (const request of requests.values()) request.abort();
  for (const stream of streams.values()) await stream.cancel().catch(() => {});
  streams.clear();
  await initializing;
  await engine?.close();
  process.disconnect?.();
};
process.on("disconnect", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.on("message", (raw: unknown) => {
  void (async () => {
    const parsed = HostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      send({
        type: "fatal",
        error: { code: "invalid", message: "Host sent an invalid plugin message" },
      });
      return;
    }
    const message = parsed.data;
    if (message.type === "init") {
      if (engine || initializing || closing) return;
      process.env.PLUGIN_ENGINE_WORKER_BUNDLE = message.config.bridge;
      initializing = startEngine(
        message.config,
        callback,
        (execution) => send({ type: "execution", execution }),
        (phase) => send({ type: "diagnostic", phase }),
      )
        .then((started) => {
          engine = started;
          if (!closing) send({ type: "ready", pid: process.pid, startupMs: engine.startupMs });
        })
        .catch((error: unknown) => {
          send({ type: "fatal", error: errorData(error) });
        });
      await initializing;
      initializing = undefined;
      if (!engine) await stop();
      return;
    }
    if (message.type === "stop") {
      await stop();
      return;
    }
    if (message.type === "cancel") {
      requests.get(message.id)?.abort();
      await streams
        .get(message.id)
        ?.cancel()
        .catch(() => {});
      streams.delete(message.id);
      return;
    }
    if (message.type === "callbackResult" || message.type === "callbackError") {
      const pending = callbacks.get(message.id);
      callbacks.delete(message.id);
      if (message.type === "callbackResult") pending?.resolve(message.result);
      else
        pending?.reject(
          message.error.brokerReason
            ? new PluginBrokerError(message.error.brokerReason)
            : new PluginServiceError(message.error.code, message.error.message, message.error.tag),
        );
      return;
    }
    if (message.type === "elicit") {
      // Only the provider call that is still waiting may ask, and only through its own handler.
      const handler = callbacks.get(message.callback)?.elicitation;
      const request = Schema.decodeUnknownOption(FormElicitation)(message.request);
      if (!handler || request._tag === "None") {
        send({
          type: "elicitError",
          id: message.id,
          error: { code: "invalid", message: "This call cannot ask the person for input" },
        });
        return;
      }
      const controller = new AbortController();
      elicitations.set(message.id, controller);
      try {
        const response = await Effect.runPromise(handler(request.value, controller.signal));
        send({
          type: "elicitResult",
          id: message.id,
          response: {
            action: response.action,
            ...(response.action === "accept" && response.content
              ? { content: JSON.parse(JSON.stringify(response.content)) }
              : {}),
          },
        });
      } catch {
        send({
          type: "elicitError",
          id: message.id,
          error: { code: "cancelled", message: "The question ended without an answer" },
        });
      } finally {
        elicitations.delete(message.id);
      }
      return;
    }
    if (message.type === "elicitCancel") {
      elicitations.get(message.id)?.abort();
      return;
    }
    if (message.type === "streamPull") {
      const reader = streams.get(message.id);
      if (!reader) {
        send({ type: "streamChunk", id: message.id, done: true });
        return;
      }
      try {
        const chunk = await reader.read();
        send({
          type: "streamChunk",
          id: message.id,
          done: chunk.done === true,
          ...(chunk.done ? {} : { chunk: Buffer.from(chunk.value).toString("base64") }),
        });
        if (chunk.done) streams.delete(message.id);
      } catch {
        streams.delete(message.id);
        send({
          type: "streamChunk",
          id: message.id,
          done: true,
          error: "Plugin page stream ended",
        });
      }
      return;
    }
    if (!engine || closing) {
      send({
        type: "error",
        id: message.id,
        error: { code: "unavailable", message: "Plugin engine is not ready" },
      });
      return;
    }
    const controller = new AbortController();
    requests.set(message.id, controller);
    try {
      const operation = message.operation as PluginOperation;
      const result = await engine.request(
        operation,
        operations[operation].input.parse(message.input),
        message.context,
        controller.signal,
      );
      if (result instanceof Response) {
        if (result.body) streams.set(message.id, responseChunkReader(result.body));
        send({
          type: "result",
          id: message.id,
          operation,
          result: {
            status: result.status,
            headers: Object.fromEntries(result.headers),
            body: "",
            ...(result.body ? { stream: message.id } : {}),
          },
        });
      } else {
        checkPluginOutputSize(operation, result);
        send({
          type: "result",
          id: message.id,
          operation,
          result: operations[operation].output.parse(
            JsonSchema.parse(JSON.parse(JSON.stringify(result ?? null))),
          ),
        });
      }
    } catch (error) {
      send({ type: "error", id: message.id, error: errorData(error) });
    } finally {
      requests.delete(message.id);
    }
  })().catch(() => {
    send({
      type: "fatal",
      error: { code: "engine", message: "Plugin engine message dispatch failed" },
    });
  });
});
