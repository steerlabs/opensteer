import { describe, expect, it } from "vitest";
import { nextAccountName, accountDisplayName } from "./account-name.js";

describe("nextAccountName", () => {
  it("takes the engine's own name first, then the lowest free number", () => {
    expect(nextAccountName("Codex", [])).toBe("Codex");
    expect(nextAccountName("Codex", ["Codex"])).toBe("Codex 2");
    expect(nextAccountName("Codex", ["Codex", "Codex 3"])).toBe("Codex 2");
    expect(nextAccountName("Codex", ["Work", "Codex 2"])).toBe("Codex");
  });
});

it.each([
  ["Work", "me@example.com", "Work"],
  ["Codex", "me@example.com", "me@example.com"],
  ["Codex 2", "me@example.com", "me@example.com"],
  ["Codex 2a", "me@example.com", "Codex 2a"],
  ["Codex 2", undefined, "Codex 2"],
])("displays %s with label %s as %s", (name, accountLabel, expected) => {
  expect(accountDisplayName({ name, engineName: "Codex", accountLabel })).toBe(expected);
});
