// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { removeRetiredStorage } from "./retired-storage.js";

it("removes the unsent waiting-edit text an earlier build kept, and leaves everything else", () => {
  localStorage.setItem(
    "opensteer:unsent-waiting-edits:v1",
    JSON.stringify({ version: 1, edits: {} }),
  );
  localStorage.setItem("opensteer:composer-draft:v1:dep:me:thread:t", "kept");
  removeRetiredStorage(localStorage);
  expect(localStorage.getItem("opensteer:unsent-waiting-edits:v1")).toBeNull();
  expect(localStorage.getItem("opensteer:composer-draft:v1:dep:me:thread:t")).toBe("kept");
  localStorage.clear();
});

it("does nothing where storage refuses access", () => {
  expect(() =>
    removeRetiredStorage({
      removeItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    }),
  ).not.toThrow();
  expect(() => removeRetiredStorage(undefined)).not.toThrow();
});
