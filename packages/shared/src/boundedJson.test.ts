/** Bounded HTTP response decoding behavior. */

import { describe, expect, it } from "vitest";
import { readBoundedJson, readBoundedResponse } from "./boundedJson.js";

describe("bounded HTTP response decoding", () => {
  it.each(["-1", "+1", "1.0", "01", "1e1", "NaN"])(
    "rejects malformed content-length %s",
    async (contentLength) => {
      const response = new Response("{}", { headers: { "content-length": contentLength } });

      await expect(readBoundedResponse(response, { maximumBytes: 16 })).rejects.toThrow(
        "Response exceeded its size limit",
      );
    },
  );

  it("rejects a valid declared length above the bound before reading", async () => {
    const response = new Response("{}", { headers: { "content-length": "17" } });

    await expect(readBoundedResponse(response, { maximumBytes: 16 })).rejects.toThrow(
      "Response exceeded its size limit",
    );
  });

  it("decodes JSON within the bound", async () => {
    const response = new Response('{"ok":true}', {
      headers: { "content-length": "11", "content-type": "application/json" },
    });

    await expect(
      readBoundedJson(response, {
        expectedContentType: "application/json",
        maximumBytes: 16,
      }),
    ).resolves.toEqual({ ok: true });
  });
});

it("enforces the decoded byte bound even when compressed Content-Length fits", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.enqueue(new Uint8Array(9));
        controller.close();
      },
    }),
    { headers: { "content-length": "2", "content-encoding": "gzip" } },
  );
  await expect(readBoundedResponse(response, { maximumBytes: 16 })).rejects.toThrow(
    "Response exceeded its size limit",
  );
});

it("bounds buffered fetch bodies without a JS stream", async () => {
  const response = {
    body: null,
    headers: new Headers(),
    arrayBuffer: async () => new Uint8Array(17).buffer,
  } as Response;
  await expect(readBoundedResponse(response, { maximumBytes: 16 })).rejects.toThrow(
    "Response exceeded its size limit",
  );
});
