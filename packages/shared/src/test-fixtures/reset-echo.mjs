import { startEchoTestServer } from "../tcpServer.test-support.ts";
import { connect } from "node:net";
const echo = await startEchoTestServer();
const client = connect(echo.port, "127.0.0.1");
client.on("error", () => client.destroy());
client.once("connect", () => client.write("reset-after-echo"));
await new Promise((resolve) => client.once("data", resolve));
// Receiving the echo acknowledges that the exact fixture's accepted socket is reading.
const closed = new Promise((resolve) => client.once("close", resolve));
client.resetAndDestroy();
await closed;
// A new client proves the listener remains usable after the previous peer resets.
const next = connect(echo.port, "127.0.0.1");
next.on("error", () => next.destroy());
next.once("connect", () => next.write("still-alive"));
const reply = await new Promise((resolve) => {
  let pending = Buffer.alloc(0);
  next.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length >= Buffer.byteLength("still-alive")) resolve(pending);
  });
});
if (reply.toString() !== "still-alive") throw new Error("echo lost its protocol");
const peerClosed = new Promise((resolve) => next.once("close", resolve));
await echo.close();
await peerClosed;
console.log("survived peer reset");
