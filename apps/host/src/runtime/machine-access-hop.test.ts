import { connect } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { probeTestServer } from "@opensteer/shared/test-support/serverProbes";
import { startHoldingHop } from "./machine-access-hop.test-support.js";

// A local Run can finish correctly while an unrelated localhost probe stays held.
it("counts only its Run's held Host handshake when foreign probes arrive before release", async () => {
  const hop = await startHoldingHop();
  const peerClosed = Promise.withResolvers<void>();
  const observe = (socket: import("node:net").Socket) => {
    if (socket.remotePort !== client.localPort) return;
    socket.once("close", () => peerClosed.resolve());
  };
  hop.server.prependListener("connection", observe);
  hop.hold();
  const client = connect(Number(hop.url.port), "127.0.0.1");
  client.on("error", () => client.destroy());
  const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  try {
    await once(client, "connect");
    client.end(
      "GET /internal/v1/shell/connect?target=test HTTP/1.1\r\n" +
        "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await Promise.all([clientClosed, peerClosed.promise]);
    await probeTestServer(hop.server);
    hop.release();
    expect(hop.counts()).toEqual({ closedBeforeRelease: 1, forwarded: 0, held: 1 });
  } finally {
    client.destroy();
    await clientClosed;
    hop.server.off("connection", observe);
    await hop.close();
  }
});
