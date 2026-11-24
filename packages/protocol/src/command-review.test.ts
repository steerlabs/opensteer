import { describe, expect, it } from "vitest";
import { commandTable, type CommandType } from "./command-table.js";
import {
  commandReviewFields,
  commandReviewRows,
  commandReviewText,
  commandValueText,
} from "./command-review.js";
import { everyFieldCommand } from "./command-samples.test-support.js";

/** Every value inside a command, by its dotted path, found without the walk under test. */
function leaves(value: unknown, path: string, into: Map<string, unknown>) {
  const container =
    value !== null && typeof value === "object" && Object.keys(value as object).length > 0;
  if (!container) {
    into.set(path, value);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    leaves(item, `${path}.${key}`, into);
}

describe("the proposed command as the person reviews it", () => {
  it("shows every argument of every command type, each value whole, nothing left out", () => {
    const types = Object.keys(commandTable) as CommandType[];
    expect(types.length).toBeGreaterThan(60);
    for (const type of types) {
      const command = everyFieldCommand(type);
      const expected = new Map<string, unknown>();
      for (const [key, value] of Object.entries(command))
        if (key !== "type") leaves(value, key, expected);
      const shown = new Map(
        commandReviewFields(command)
          .filter((field) => field.value !== null)
          .map((field) => [field.path, field.value]),
      );
      expect([...shown.keys()].sort(), type).toEqual([...expected.keys()].sort());
      for (const [path, value] of expected)
        expect(shown.get(path), `${type} ${path}`).toBe(commandValueText(value));
    }
  });

  it("heads each object and list, labels in the Home's words, and keeps long text whole", () => {
    const script = "x".repeat(50_000);
    const fields = commandReviewFields({
      type: "connection.update",
      connectionId: "mcn_1",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: "bpr_1" }],
      },
      note: script,
      empty: [],
    });
    expect(fields.map(({ path, depth, label, value }) => [path, depth, label, value])).toEqual([
      ["connectionId", 0, "Connected agent", "mcn_1"],
      ["grant", 0, "What it may use", null],
      ["grant.scope", 1, "Reach", "selected"],
      ["grant.tasks", 1, "Tasks", "No"],
      ["grant.resources", 1, "Chosen", null],
      ["grant.resources.0", 2, "1", null],
      ["grant.resources.0.kind", 3, "Kind", "browser-profile"],
      ["grant.resources.0.profileId", 3, "Browser profile", "bpr_1"],
      ["note", 0, "Note", script],
      ["empty", 0, "Empty", "None"],
    ]);
  });

  it("puts what the Home knows beside a value, and nothing beside a value not proposed", () => {
    const rows = commandReviewRows({ type: "connection.update", label: "New" }, [
      { path: "label", current: "Old" },
      { path: "grant", current: "Reach: everything" },
    ]);
    expect(rows).toEqual([
      { path: "label", depth: 0, label: "Name", value: "New", name: null, current: "Old" },
    ]);
    expect(commandReviewText({ scope: "selected", tasks: true })).toBe(
      "Reach: selected\nTasks: Yes",
    );
  });
});
