import { expect, it } from "vitest";
import { channelReplyMarkdown } from "./channel-deliveries.js";
it("removes local image destinations before a bridge reply can be split", () => {
  expect(
    channelReplyMarkdown(
      [
        {
          type: "text",
          text: "Answer ![chart](</private/a b.png>) ![web](https://example.test/image.png)",
        },
      ],
      "https://opensteer.test/thread",
    ),
  ).toBe("Answer chart ![web](https://example.test/image.png)");
});
