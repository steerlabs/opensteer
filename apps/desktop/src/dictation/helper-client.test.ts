import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { encodeLengthPrefixedJson } from "@opensteer/shared/lengthPrefixedJson";
import { dictationHelperMaxFrameBytes } from "@opensteer/protocol/dictation-helper";
const seams = vi.hoisted(() => ({ open: vi.fn<() => Promise<Socket>>() }));
vi.mock("./install.js", () => ({
  ensureDictationBrokerInstalled: async () => ({
    path: "/unused",
    launchFreshInstance: false,
    protocolVersion: 1,
  }),
  dictationBrokerIdentity: () => ({ executableName: "unused" }),
}));
vi.mock("../signed-helpers/signed-helper.js", async (original) => ({
  ...(await original<typeof import("../signed-helpers/signed-helper.js")>()),
  withSignedHelperLifecycleLock: async (_options: unknown, work: () => Promise<Socket>) => work(),
  runSignedHelperPeerVerifier: async () => undefined,
  verifySignedHelperSignature: async () => undefined,
  openSignedHelperSocket: () => seams.open(),
}));
import { NativeDictationHelperClient } from "./helper-client.js";
describe("verified dictation transport", () => {
  it("closes malformed frames, rejects pending commands, and reconnects on the next request", async () => {
    const peers = new Set<Socket>();
    let malformed = true;
    const server = createServer((socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.once("data", () =>
        socket.write(
          encodeLengthPrefixedJson(
            malformed
              ? { unexpected: true }
              : { id: 2, result: { available: false, reason: "os" } },
            dictationHelperMaxFrameBytes,
          ),
        ),
      );
    });
    const client = new NativeDictationHelperClient({
      development: true,
      bundledAppPath: "/unused",
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing port");
      seams.open.mockImplementation(async () => {
        const socket = connect(address.port, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      });
      const lost = vi.fn();
      client.subscribe(() => undefined, lost);
      await expect(client.call("availability")).rejects.toThrow("connection lost");
      expect(lost).toHaveBeenCalledTimes(1);
      malformed = false;
      await expect(client.call("availability")).resolves.toEqual({
        available: false,
        reason: "os",
      });
      expect(seams.open).toHaveBeenCalledTimes(2);
    } finally {
      client.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
