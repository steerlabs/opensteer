import { expect, it } from "vitest";
import { defaultTaskSymbol } from "@opensteer/core";
import { taskMark } from "./task-marks.js";
it("presents the default symbol without changing the task's null provenance", () => {
  const task = { icon: null, color: null };
  expect(taskMark(task).icon).toBe(defaultTaskSymbol);
  expect(task.icon).toBeNull();
});
