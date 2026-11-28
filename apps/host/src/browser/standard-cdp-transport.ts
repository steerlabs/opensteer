import type { BrowserRuntime, StandardCdpAttachment } from "@opensteer/browser-runtime-core";
import { standardCdpSettledReason, type StandardCdpMode } from "@opensteer/protocol/standard-cdp";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import WebSocket from "ws";
import { z } from "zod";
import type { BrowserRuntimeConnection } from "./browser-service.js";

export const standardCdpAdmissionMs = 5_000;
export const standardCdpMaxLivePerBinding = 4;
export const standardCdpMaxLivePerRunner = 16;

export const RawCdpRequestSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: z.string().max(256),
    params: z.record(z.string(), z.unknown()).optional(),
    sessionId: z.string().max(512).optional(),
  })
  .strict();

export interface StandardCdpTransport {
  readonly mode: StandardCdpMode;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  readonly contactLost?: Promise<void>;
  close(): void;
  onFrame(listener: (frame: Buffer) => void): void;
  send(frame: Buffer): Promise<void>;
}

export function relayStandardTransport(
  connection: BrowserRuntimeConnection,
  mode: StandardCdpMode,
): StandardCdpTransport {
  const ending = new AbortController();
  const settlement = Promise.withResolvers<void>();
  const contact = Promise.withResolvers<void>();
  let receive: ((frame: Buffer) => void) | undefined;
  const close = () => {
    if (!ending.signal.aborted) ending.abort();
    receive = undefined;
    connection.close();
  };
  connection.once("close", (code, reason) => {
    if (code === 1000 && reason.toString("utf8") === standardCdpSettledReason) settlement.resolve();
    else contact.resolve();
    ending.abort(code);
    receive = undefined;
  });
  connection.on("error", close);
  connection.on("message", (data, binary) => {
    if (binary) close();
    else receive?.(rawDataBuffer(data));
  });
  if (connection.readyState !== WebSocket.OPEN) close();
  return {
    mode,
    signal: ending.signal,
    settled: settlement.promise,
    contactLost: contact.promise,
    close,
    onFrame: (listener) => {
      receive = listener;
    },
    send: (frame) =>
      new Promise((resolve, reject) =>
        connection.send(frame.toString("utf8"), { binary: false }, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  };
}

export async function directStandardTransport(
  runtime: Pick<BrowserRuntime, "attachStandardCdp">,
  ticket: string,
  signal: AbortSignal,
): Promise<StandardCdpTransport> {
  const overload = new AbortController();
  const client = await runtime.attachStandardCdp(ticket, () => overload.abort(1013), signal);
  return routerStandardTransport(
    client,
    client.mode ?? "session",
    AbortSignal.any([client.signal, overload.signal]),
    () => overload.abort(1013),
  );
}

export function routerStandardTransport(
  client: StandardCdpAttachment,
  mode: StandardCdpMode,
  signal: AbortSignal,
  onOverflow: () => void = client.close,
): StandardCdpTransport {
  let receive: ((frame: Buffer) => void) | undefined;
  const emit = (value: unknown) => receive?.(Buffer.from(JSON.stringify(value), "utf8"));
  client.onEvent(({ method, parameters, sessionId }) =>
    emit({ method, params: parameters, sessionId }),
  );
  return {
    mode,
    signal,
    settled: client.settled,
    close: client.close,
    onFrame: (listener) => {
      receive = listener;
    },
    send: async (frame) => {
      const { id, method, params, sessionId } = RawCdpRequestSchema.parse(
        JSON.parse(frame.toString("utf8")),
      );
      // Handoff completes here, so a blocked renderer cannot hold a later dialog answer.
      void client
        .send({
          method,
          ...(params ? { parameters: params } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
        .then(
          (result) => emit({ id, sessionId, result: result ?? {} }),
          (error: unknown) =>
            emit({
              id,
              sessionId,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : "CDP command failed.",
              },
            }),
        )
        .catch(onOverflow);
    },
  };
}
