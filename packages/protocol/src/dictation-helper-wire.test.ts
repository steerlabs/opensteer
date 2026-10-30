import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import {
  DictationHelperRequestSchema,
  DictationHelperReplySchema,
  dictationHelperMaxFrameBytes,
} from "./dictation-helper.js";
it("accepts the Swift helper's encoded request and rejects malformed method parameters", () => {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../apps/desktop/native/dictation/Tests/Fixtures/request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(DictationHelperRequestSchema.parse(fixture).method).toBe("start");
  expect(
    DictationHelperRequestSchema.safeParse({ id: 1, method: "start", params: {} }).success,
  ).toBe(false);
  expect(
    DictationHelperRequestSchema.safeParse({
      id: 1,
      method: "availability",
      params: { session: "other" },
    }).success,
  ).toBe(false);
  expect(
    DictationHelperReplySchema.safeParse({
      id: 1,
      result: { available: false, reason: "os" },
      extra: true,
    }).success,
  ).toBe(false);
  expect(dictationHelperMaxFrameBytes).toBe(256 * 1024);
});
