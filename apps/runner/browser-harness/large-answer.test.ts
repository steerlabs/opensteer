import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  standardCdpAnswerMaxBytes,
  standardCdpMessageMaxBytes,
} from "../../../packages/browser-core/src/standard-cdp-limits.js";
import {
  maxBrowserRelayEnvelopeBytes,
  maxRelayedBrowserFrameBytes,
} from "../../../packages/protocol/src/browser-relay.js";
import { relayCdpFrameMaxBytes } from "../src/browser/browser-cdp-relay.js";
// @ts-expect-error The standalone Harness runs directly as JavaScript.
import { CdpClient, MAX_MESSAGE_BYTES } from "./cdp.mjs";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A CDP endpoint that answers `Big` with `bytes` of text and anything else with `{ ok: true }`. */
async function fakeCdp(bytes: number) {
  const http = createServer();
  const server = new WebSocketServer({ server: http, perMessageDeflate: false });
  const sockets: import("ws").WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string };
      if (method === "BigEvent")
        socket.send(JSON.stringify({ method: "Big.event", params: { text: "e".repeat(bytes) } }));
      socket.send(
        JSON.stringify(
          method === "Big"
            ? { id, result: { result: { type: "string", value: "x".repeat(bytes) } } }
            : { id, result: { ok: true } },
        ),
      );
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  closers.push(() => {
    for (const socket of sockets) socket.terminate();
    server.close();
    http.close();
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fake CDP did not bind");
  return { url: `ws://127.0.0.1:${address.port}/cdp`, sockets };
}

it("fails only the command whose answer is over the limit, naming its size, and keeps the page", async () => {
  const cdp = await fakeCdp(MAX_MESSAGE_BYTES + 1_024 * 1_024);
  const client = await CdpClient.connect(cdp.url, "session-1");
  try {
    await expect(client.command("Big")).rejects.toThrow(
      /^The browser's answer to Big is 9\.0 MiB, over the 8\.0 MiB limit for one answer\. Ask the page for less: a slice of the text, an element by selector, or innerText instead of the HTML\.$/u,
    );
    // The same socket answers the next command of the same script.
    await expect(client.command("Runtime.evaluate")).resolves.toEqual({ ok: true });
    // An event over the limit is dropped; the connection stays.
    await expect(client.command("BigEvent")).resolves.toEqual({ ok: true });
    await expect(client.command("Runtime.evaluate")).resolves.toEqual({ ok: true });
    expect(cdp.sockets[0]?.readyState).toBe(1);
  } finally {
    client.close();
  }
});

it("carries an answer of a few megabytes, as an ordinary screenshot's or a page's HTML", async () => {
  const cdp = await fakeCdp(1_164_588);
  const client = await CdpClient.connect(cdp.url, "session-1");
  try {
    const answer = (await client.command("Big")) as { result: { value: string } };
    expect(answer.result.value).toHaveLength(1_164_588);
  } finally {
    client.close();
  }
});

it("keeps one limit for a CDP message on the harness's path, no hop smaller than the one before it", () => {
  // The limit, from its one constant: 8 MiB.
  expect(standardCdpMessageMaxBytes).toBe(8 * 1_024 * 1_024);
  // From the browser outwards: the router beside it passes answers up to standardCdpAnswerMaxBytes
  // and fails a larger one as its own command; every hop after it carries a whole message.
  expect(standardCdpAnswerMaxBytes).toBeLessThan(standardCdpMessageMaxBytes);
  // The pool relay's frame carries a whole message, its envelope a little more.
  expect(maxRelayedBrowserFrameBytes).toBeGreaterThanOrEqual(standardCdpMessageMaxBytes);
  expect(maxBrowserRelayEnvelopeBytes).toBeGreaterThan(maxRelayedBrowserFrameBytes);
  // The Host's CDP route (its socket and its frames) takes the same constant.
  const server = readFileSync(new URL("../../host/src/server.ts", import.meta.url), "utf8");
  expect(server).toMatch(/standardCdp\s*\?\s*standardCdpMessageMaxBytes/u);
  const route = readFileSync(
    new URL("../../host/src/browser/standard-cdp-route.ts", import.meta.url),
    "utf8",
  );
  expect(route).toContain("frame.length > standardCdpMessageMaxBytes");
  // The Runner's relay can only close its socket over its limit: it carries every message.
  expect(relayCdpFrameMaxBytes).toBeGreaterThanOrEqual(standardCdpMessageMaxBytes);
  // The harness, last, answers for itself at the same limit (it ships as plain files, so it
  // keeps the number; this is where the two are held equal).
  expect(MAX_MESSAGE_BYTES).toBe(standardCdpMessageMaxBytes);
});
