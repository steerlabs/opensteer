import { expect, it } from "vitest";
import { plainTextExcerpt } from "./plainTextExcerpt.js";

it("sanitizes full source before flattening and clipping excerpts", () => {
  expect(
    plainTextExcerpt(
      "[answer][private]\n\n" + " ".repeat(20_000) + "\n[private]: /private/secret.txt",
      30,
    ),
  ).toBe("answer");
  expect(plainTextExcerpt("[task](opensteer:future) [file](</private/a b.txt>)", 100)).toBe(
    "task file",
  );
  expect(plainTextExcerpt("[label](</private/" + "a".repeat(30_000) + ">)", 15)).toBe("label");
  expect(plainTextExcerpt("[unfinished](opensteer:future", 15)).toBeNull();
});
