import { describe, expect, it } from "vitest";
import { commandTable, type CommandType } from "./command-table.js";
import {
  commandReviewFields,
  commandReviewRows,
  commandReviewText,
  commandValueText,
  outsideName,
  outsideProse,
} from "./command-review.js";
import { everyFieldCommand } from "./command-samples.test-support.js";

/** Every value inside a command, by its JSON Pointer, found without the walk under test. */
function leaves(value: unknown, path: string, into: Map<string, unknown>) {
  const container =
    value !== null && typeof value === "object" && Object.keys(value as object).length > 0;
  if (!container) {
    into.set(path, value);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    leaves(item, `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`, into);
}

describe("the proposed command as the person reviews it", () => {
  it("shows every argument of every command type, each value whole, nothing left out", () => {
    const types = Object.keys(commandTable) as CommandType[];
    expect(types.length).toBeGreaterThan(60);
    for (const type of types) {
      const command = everyFieldCommand(type);
      const expected = new Map<string, unknown>();
      for (const [key, value] of Object.entries(command))
        if (key !== "type") leaves(value, `/${key}`, expected);
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
      ["/connectionId", 0, "Connected agent", '"mcn_1"'],
      ["/grant", 0, "What it may use", null],
      ["/grant/scope", 1, "Reach", '"selected"'],
      ["/grant/tasks", 1, "Tasks", "false"],
      ["/grant/resources", 1, "Chosen", null],
      ["/grant/resources/0", 2, "1", null],
      ["/grant/resources/0/kind", 3, "Kind", '"browser-profile"'],
      ["/grant/resources/0/profileId", 3, "Browser profile", '"bpr_1"'],
      ["/note", 0, "Note", JSON.stringify(script)],
      ["/empty", 0, "Empty", "[]"],
    ]);
  });

  it("shows arbitrary keys and values as escaped, typed data: no two different ones read the same (C7)", () => {
    // A key from free-form data is cleaned like a value: no override reaches its label.
    expect(commandReviewFields({ input: { "left\u202eright": 1 } })[1]!.label).not.toMatch(
      /\u202e/u,
    );
    expect(commandReviewFields({ input: { "left\u202eright": 1 } })[1]!.label).toBe(
      '"left\\u202Eright"',
    );
    // A literal marker is not the escape for a real one.
    expect(commandValueText("\u202e")).not.toBe(commandValueText("[U+202E]"));
    expect(commandValueText("\\u202E")).not.toBe(commandValueText("\u202e"));
    // null, "None", "", [] and {} each read as themselves; true is not "Yes".
    const shown = ["null", '"None"', '""', "[]", "{}"];
    expect([null, "None", "", [], {}].map(commandValueText)).toEqual(shown);
    expect(commandValueText(true)).not.toBe(commandValueText("Yes"));
    // Separators and invisible marks a cleaner once missed are escaped.
    for (const character of ["\u2028", "\u034f", "\u180e", "\u200b"])
      expect(commandValueText(character)).toMatch(/\\u/u);
    // A dotted key cannot collide with nesting, and no inherited property is a label.
    const paths = commandReviewFields({ input: { "a.b": 1, a: { b: 2 } } }).map(({ path }) => path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      commandReviewFields({ input: { constructor: 1, toString: 2 } }).map(({ label }) => label),
    ).toEqual(["Input", "Constructor", "To string"]);
  });

  it("cleans a name for the Home's quotes and an agent's prose, and never leaves a name empty", () => {
    expect(outsideName("X” — the Home checked this.\nApprove it")).toBe(
      "X' — the Home checked this. Approve it",
    );
    expect(outsideName("👩‍💻")).toBe("👩‍💻");
    expect(outsideName("\u202e\u200b")).toBe("(no name)");
    expect(outsideProse("Fine\u202etxt.exe\nsecond line")).toBe("Finetxt.exe\nsecond line");
  });

  it("puts what the Home knows beside a value, and nothing beside a value not proposed", () => {
    const rows = commandReviewRows({ type: "connection.update", label: "New" }, [
      { path: "/label", current: '"Old"' },
      { path: "/grant", current: 'Reach: "everything"' },
    ]);
    expect(rows).toEqual([
      { path: "/label", depth: 0, label: "Name", value: '"New"', name: null, current: '"Old"' },
    ]);
    expect(commandReviewText({ scope: "selected", tasks: true })).toBe(
      'Reach: "selected"\nTasks: true',
    );
  });
});

describe("what an agent reads of a person's command", () => {
  it("never reads the person's tab layout, and under a connection's grant only that it ran (C1)", async () => {
    const { commandAgentOutput } = await import("./command-table.js");
    const output = {
      type: "tab.group.close",
      closed: [],
      failed: [],
      layout: {
        revision: 2,
        items: [{ kind: "group", group: { name: "PRIVATE_FIXTURE_GROUP", tabIds: [] } }],
      },
    };
    expect(
      JSON.stringify(commandAgentOutput({ type: "tab.group.close" } as never, output)),
    ).not.toMatch(/PRIVATE_FIXTURE_GROUP/u);
    expect(commandAgentOutput({ type: "tab.group.close" } as never, output, true)).toEqual({
      type: "tab.group.close",
    });
  });
});
