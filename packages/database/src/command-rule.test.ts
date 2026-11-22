import { describe, expect, it } from "vitest";
import { ThreadAccessModeSchema, type ThreadAccessMode } from "@opensteer/core";
import {
  commandFaceStep,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import expected from "../../protocol/src/command-table.rows.json" with { type: "json" };
import { commandRule, type CommandAnswer, type CommandRuleCaller } from "./resource-access.js";

type Column = "a" | "b" | "c" | "d";
interface ExpectedRow {
  readonly type: string;
  readonly faces: readonly { readonly answers: Readonly<Record<Column, CommandAnswer>> }[];
}
const rows = expected.rows as readonly ExpectedRow[];
const belowFullAccess = ThreadAccessModeSchema.options.filter(
  (mode): mode is Exclude<ThreadAccessMode, "full-access"> => mode !== "full-access",
);

/** The four callers of the data file; each covers the resource the command governs. */
const callers: Readonly<Record<Column, (mode?: ThreadAccessMode) => CommandRuleCaller>> = {
  a: () => ({ connection: null, mode: "full-access", reach: true }),
  b: (mode = "auto") => ({ connection: null, mode, reach: true }),
  c: (mode = "full-access") => ({ connection: { grant: "everything" }, mode, reach: true }),
  d: (mode = "full-access") => ({ connection: { grant: "selected" }, mode, reach: true }),
};
const row = (type: string) => commandTable[type as CommandType] as CommandRow;
const answer = (type: string, face: number, caller: CommandRuleCaller) =>
  commandRule(row(type), face, caller).answer;

describe("the command rule, generated from the table", () => {
  it("answers what the data file says for every type, face and caller", () => {
    const mismatches: string[] = [];
    for (const expectedRow of rows)
      expectedRow.faces.forEach((face, index) => {
        for (const column of ["a", "b", "c", "d"] as const) {
          const modes = column === "b" ? belowFullAccess : [undefined];
          for (const mode of modes) {
            const got = answer(expectedRow.type, index, callers[column](mode));
            if (got !== face.answers[column])
              mismatches.push(
                `${expectedRow.type} face ${index} (${column}${mode ? ` ${mode}` : ""}): ${got}, expected ${face.answers[column]}`,
              );
          }
        }
      });
    expect(mismatches).toEqual([]);
  });

  it("asks a connection below Full access for every effect outside its own task work", () => {
    // Derived from the data file alone: (c) below Full access is (c), except that a `now` stays
    // `now` only where your own agent below Full access also gets `now` (its own task work). The
    // organization's ceiling lowers the same mode, so it is the same case.
    for (const expectedRow of rows)
      expectedRow.faces.forEach((face, index) => {
        for (const mode of belowFullAccess) {
          for (const column of ["c", "d"] as const) {
            const full = face.answers[column];
            const want = full === "now" && face.answers.b !== "now" ? "ask" : full;
            expect(
              answer(expectedRow.type, index, callers[column](mode)),
              `${expectedRow.type} face ${index} (${column} ${mode})`,
            ).toBe(want);
          }
        }
      });
  });

  it("reads anything outside a connection's reach exactly like something that does not exist", () => {
    for (const type of Object.keys(commandTable)) {
      const table = row(type);
      table.faces.forEach((_, index) => {
        for (const grant of ["everything", "selected"] as const) {
          const outside = answer(type, index, {
            connection: { grant },
            mode: "full-access",
            reach: false,
          });
          // A new thing has nothing to be outside of; a Home-wide one is decided by the grant.
          if (table.scope === "new" || table.scope === "home")
            expect(outside).toBe(answer(type, index, callers[grant === "selected" ? "d" : "c"]()));
          else expect(outside, `${type} face ${index} (${grant})`).toBe("not_found");
        }
      });
    }
  });

  it("never shows a connected agent another connection, `everything` included", () => {
    for (const [type, table] of Object.entries(commandTable)) {
      if (table.scope !== "connection" && table.scope !== "other-connection") continue;
      table.faces.forEach((_, index) => {
        for (const grant of ["everything", "selected"] as const)
          expect(
            answer(type, index, { connection: { grant }, mode: "full-access", reach: false }),
            `${type} (${grant})`,
          ).toBe("not_found");
      });
    }
  });

  it("asks your own agent below Full access about a task that is not its own work", () => {
    for (const [type, table] of Object.entries(commandTable)) {
      if (table.scope !== "task") continue;
      table.faces.forEach((face, index) => {
        const got = answer(type, index, { connection: null, mode: "auto", reach: false });
        expect(got, type).toBe(face.class === "person-view" ? "not_found" : "ask");
      });
    }
  });

  it("holds a face only the store can tell to the strictest of its faces", () => {
    const own = callers.a();
    expect(commandRule(row("machine.access.update"), undefined, own).answer).toBe("ask");
    expect(commandRule(row("machine.access.update"), 0, own).answer).toBe("now");
    expect(commandRule(row("connection.update"), undefined, callers.c()).answer).toBe("ask");
  });

  it("gives `now` in step A exactly where the handler takes an agent today", () => {
    // The counts the plan's data file prints for the messaging rows (README, "With --messaging").
    const nowInStepA = (column: Column) =>
      rows.filter((expectedRow) => {
        const table = row(expectedRow.type);
        const caller = callers[column]();
        return table.faces.some(
          (_, index) =>
            commandRule(table, index, caller).answer === "now" &&
            commandFaceStep(table, index, {
              connection: caller.connection !== null,
              selected: caller.connection?.grant === "selected",
            }) === "A",
        );
      }).length;
    expect({
      a: nowInStepA("a"),
      b: nowInStepA("b"),
      c: nowInStepA("c"),
      d: nowInStepA("d"),
    }).toEqual({ a: 51, b: 21, c: 47, d: 22 });
  });
});
