import { EventEmitter } from "node:events";
import { createId } from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { TeamLinkConnection } from "./connection.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  send(): void {}
  terminate(): void {
    this.emit("close", 1006);
  }
}

it("never lets a close's late unreachable write land after the reconnect's active", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const unreachable = Promise.withResolvers<void>();
  const socket = new FakeSocket();
  const opened = Promise.withResolvers<void>();
  let opens = 0;
  const connection = new TeamLinkConnection({
    teamId: createId("deployment"),
    open: async () => {
      if (++opens === 1) throw new Error("team unreachable");
      opened.resolve();
      return socket as unknown as WebSocket;
    },
    terminalRequests: async () => [],
    onReady: async () => undefined,
    onFrame: async () => undefined,
    onState: async (state) => {
      if (state === "unreachable") await unreachable.promise;
      writes.push(state);
    },
  });
  connection.start();
  await vi.advanceTimersByTimeAsync(30_000);
  await opened.promise;
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "ready",
        teamApiVersion,
        accessRevision: "1",
        link: {
          teamName: "Acme",
          id: createId("teamLink"),
          ownerUserId: createId("user"),
          personalDeploymentId: null,
          installationLabel: null,
          state: "active",
          lastSeenAt: null,
        },
      }),
    ),
    false,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toEqual([]);
  unreachable.resolve();
  await vi.waitFor(() => expect(writes).toEqual(["unreachable", "active"]), { timeout: 1000 });
  connection.stop();
});
