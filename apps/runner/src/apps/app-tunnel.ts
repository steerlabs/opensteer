import { once } from "node:events";
import { connect } from "node:net";
import { pipeline } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import { runnerWebSocketTransport } from "@opensteer/runner-client";
import { appTunnelMaxFrameBytes } from "@opensteer/protocol";
import type { RunnerConfig } from "@opensteer/config";

/** One HTTP exchange; HTTP framing, rather than upload EOF, ends the response. */
export async function openAppTunnel(
  config: Pick<RunnerConfig, "hostUrl" | "mode" | "controlCaPath">,
  ticket: string,
  port: number,
  signal: AbortSignal,
  setupSignal: AbortSignal,
): Promise<{ readonly done: Promise<void> }> {
  const transport = await runnerWebSocketTransport(
    {
      hostOrigin: config.hostUrl,
      mode: config.mode,
      ...(config.controlCaPath ? { controlCaPath: config.controlCaPath } : {}),
    },
    "/internal/v1/apps/tunnel",
  );
  signal.throwIfAborted();
  transport.url.searchParams.set("ticket", ticket);
  const ws = new WebSocket(transport.url, {
    ...(transport.ca ? { ca: transport.ca } : {}),
    perMessageDeflate: false,
    maxPayload: appTunnelMaxFrameBytes,
    handshakeTimeout: 30_000,
    followRedirects: false,
  });
  const abort = () => ws.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await once(ws, "open", { signal: AbortSignal.any([signal, setupSignal]) });
    const tcp = connect({ host: "127.0.0.1", port, signal });
    const connected = once(tcp, "connect", { signal: AbortSignal.any([signal, setupSignal]) });
    const stream = createWebSocketStream(ws, { highWaterMark: 16 * 1_024 });
    const done = new Promise<void>((resolve) => {
      pipeline(stream, tcp, stream, () => {
        signal.removeEventListener("abort", abort);
        ws.terminate();
        resolve();
      });
    });
    try {
      await connected;
    } catch (error) {
      stream.destroy();
      await done;
      throw error;
    }
    return { done };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    ws.terminate();
    throw error;
  }
}
