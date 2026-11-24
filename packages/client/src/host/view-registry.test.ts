import { expect, test, vi } from "vitest";
import { ViewRegistry } from "./view-registry.js";

test("the newest view answers, and each release hands the Thread back to the view under it", () => {
  const registry = new ViewRegistry<string>();
  const apply = vi.fn();
  const companion = registry.register("thread", "companion", apply);
  const screen = registry.register("thread", "screen", apply);
  expect(registry.current("thread")).toBe("screen");
  // The screen opened over the companion closes: the companion answers again.
  screen();
  expect(registry.current("thread")).toBe("companion");
  expect(apply).toHaveBeenLastCalledWith("companion");
  // A release runs once; a late second call takes nothing more away.
  screen();
  expect(registry.current("thread")).toBe("companion");
  // Released out of order, the newest still answers.
  const again = registry.register("thread", "screen", apply);
  companion();
  expect(registry.current("thread")).toBe("screen");
  again();
  expect(registry.current("thread")).toBeUndefined();
  expect(apply).toHaveBeenLastCalledWith(undefined);
});
