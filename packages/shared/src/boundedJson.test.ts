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
