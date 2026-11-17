import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";

it("can import the picture owner directly in native ESM", () => {
  const module = new URL("../src/host/run-place-picture.ts", import.meta.url).href;
  expect(() =>
    execFileSync(
      execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(module)})`,
      ],
      { timeout: 3_000, stdio: "pipe" },
    ),
  ).not.toThrow();
});
