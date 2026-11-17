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

it("sanitizes references across assembled parts before provider splitting", () => {
  expect(
    channelReplyMarkdown(
      [
        { type: "text", text: "See [answer][private] and [task](opensteer:future)." },
        { type: "text", text: "[private]: /private/secret.txt" },
      ],
      "https://opensteer.test/thread",
    ),
  ).toBe("See answer and task.");
});
