import { readFile } from "node:fs/promises";
import { ScreenShowInputSchema, ScreenPresentationReceiptSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { grade } from "./grader.js";

const cases = parseCases(
  await readFile(new URL("./cases/screen-presentation.ndjson", import.meta.url), "utf8"),
);

describe("screen presentation corpus", () => {
  it("binds expected presentations to real input metadata rather than prompt text", () => {
    for (const testCase of cases) {
      const receipt = testCase.mocks.screen_show;
      if (receipt !== undefined)
        expect(ScreenPresentationReceiptSchema.safeParse(receipt).success, testCase.id).toBe(true);
      const turn = testCase.turns.at(-1)!;
      if (typeof turn === "string") throw new Error("Expected an identified screen input");
      expect(turn.text).not.toContain("[Opensteer input]");
      expect(turn.text).not.toContain(turn.messageId);
      for (const call of testCase.expect.calls.filter((call) => call.tool === "screen_show")) {
        expect(ScreenShowInputSchema.parse(call.args).messageId).toBe(turn.messageId);
        expect(testCase.expect.maxCalls.screen_show).toBe(1);
      }
    }
  });

  it.each([
    ["superseded", "A newer screen choice superseded this request."],
    ["unavailable", "I couldn't open that conversation; it is unavailable."],
    ["unconfirmed", "I can't confirm whether the screen changed."],
  ])(
    "rejects false success, a wrong input ID or a second operation after %s",
    (outcome, finalText) => {
      const testCase = cases.find(
        (testCase) => testCase.id === `screen-${outcome}-does-not-claim-or-retry`,
      )!;
      const required = testCase.expect.calls[0]!;
      const call = { ...required, valid: true };
      expect(grade(testCase.expect, [call], finalText).every((check) => check.pass)).toBe(true);
      expect(grade(testCase.expect, [call, call], finalText).every((check) => check.pass)).toBe(
        false,
      );
      expect(
        grade(
          testCase.expect,
          [
            {
              ...call,
              args: { ...call.args, messageId: "msg_00000000-0000-4000-8000-000000000099" },
            },
          ],
          finalText,
        ).every((check) => check.pass),
      ).toBe(false);
      const falseSuccess = grade(
        testCase.expect,
        [call],
        `${outcome}: I have opened it. It is now on your screen.`,
      );
      expect(falseSuccess.find((check) => check.name.startsWith("textMustNot:"))?.pass).toBe(false);
    },
  );
});
