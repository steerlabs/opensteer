import type WebSocket from "ws";
import { ComputerAppSubmissionNotStartedError } from "./computer-app-hub.js";

type ComputerAppWebSocket = Pick<WebSocket, "OPEN" | "bufferedAmount" | "readyState" | "send">;

/**
 * Sends one computer-app frame while preserving whether submission began.
 *
 * A slow socket is closed by the hub only after it settles the pending invoke
 * as definitely unsent. Keeping the close request on the error prevents even a
 * synchronous close event from racing that classification.
 */
export function sendComputerAppFrame(
  socket: ComputerAppWebSocket,
  message: unknown,
  maxBufferedBytes: number,
): Promise<void> {
  const frame = JSON.stringify(message);
  const bytes = Buffer.byteLength(frame, "utf8");
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== socket.OPEN) {
      reject(new ComputerAppSubmissionNotStartedError("WebSocket is closed"));
      return;
    }
    if (socket.bufferedAmount + bytes > maxBufferedBytes) {
      reject(
        new ComputerAppSubmissionNotStartedError("WebSocket slow consumer", {
          code: 4009,
          reason: "slow module consumer",
        }),
      );
      return;
    }
    socket.send(frame, (error) => (error ? reject(error) : resolve()));
  });
}
