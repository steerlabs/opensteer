import { resetTestServer } from "./serverProbes.test-support.js";
import { createServer, type Socket } from "node:net";

export async function startEchoTestServer(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("echo server has no port");
  const close = () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const socket of sockets) socket.destroy();
    return closed;
  };
  try {
    // Each consumer exercises a real reset before using its listener, including the DB journeys.
    await resetTestServer(
      server,
      (client) =>
        new Promise<void>((resolve, reject) => {
          const expected = Buffer.from("reset-probe");
          let pending = Buffer.alloc(0);
          const read = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            if (!expected.subarray(0, pending.length).equals(pending)) {
              client.off("data", read);
              reject(new Error("Echo reset probe was not acknowledged"));
            } else if (pending.length === expected.length) {
              client.off("data", read);
              resolve();
            }
          };
          client.on("data", read);
          client.write(expected);
        }),
    );
  } catch (error) {
    await close();
    throw error;
  }
  return { close, port: address.port };
}
