import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostApi } from "./host-api.js";
import {
  commandFamilies,
  commandTable,
  effectClasses,
  type CommandStep,
  type CommandType,
} from "./command-table.js";
import expected from "./command-table.rows.json" with { type: "json" };

interface ExpectedFace {
  readonly when: string | null;
  readonly class: string;
  readonly step?: string;
}
interface ExpectedRow {
  readonly type: string;
  readonly family: string;
  readonly step: string;
  readonly stepFor?: Readonly<Record<string, string>>;
  readonly faces: readonly ExpectedFace[];
}
const rows = expected.rows as readonly ExpectedRow[];
const step = (value: string): CommandStep => (value === "—" ? "none" : (value as CommandStep));

/** Every member of the command union, by its `type` literal; a type may have several variants. */
function unionMembers(): Map<string, z.ZodObject[]> {
  const members = new Map<string, z.ZodObject[]>();
  for (const option of (
    hostApi["commands.dispatch"].payload as unknown as z.ZodUnion<z.ZodObject[]>
  ).options) {
    const literal = option.shape.type as z.ZodLiteral<string>;
    const type = literal.value;
    members.set(type, [...(members.get(type) ?? []), option]);
  }
  return members;
}

describe("the command table", () => {
  it("has exactly one row for every command type the Home accepts", () => {
    // A type added to the union without a row fails here (and fails to compile in the table).
    const types = [...unionMembers().keys()].sort();
    expect(Object.keys(commandTable).sort()).toEqual(types);
    expect(rows.map((row) => row.type).sort()).toEqual(types);
    expect(types).toHaveLength(136);
  });

  it("says what the data file says, row by row and face by face", () => {
    for (const row of rows) {
      const table = commandTable[row.type as CommandType];
      expect({ type: row.type, family: table.family }).toEqual({
        type: row.type,
        family: row.family,
      });
      expect({ type: row.type, step: table.step }).toEqual({
        type: row.type,
        step: step(row.step),
      });
      const stepFor: Record<string, string> = {};
      if (table.stepFor?.connections) Object.assign(stepFor, { c: "B", d: "B" });
      if (table.stepFor?.selected) Object.assign(stepFor, { d: "B" });
      expect({ type: row.type, stepFor }).toEqual({ type: row.type, stepFor: row.stepFor ?? {} });
      expect(
        table.faces.map((face) => ({
          class: face.also ? `${face.class} + ${face.also}` : face.class,
          step: face.step ?? table.step,
        })),
        row.type,
      ).toEqual(
        row.faces.map((face) => ({ class: face.class, step: step(face.step ?? row.step) })),
      );
      // Two faces are told apart by the input or, failing that, by the store.
      expect(table.faces.length > 1, row.type).toBe(table.face !== undefined);
    }
  });

  it("uses only known families and classes", () => {
    for (const row of Object.values(commandTable)) {
      expect(commandFamilies).toContain(row.family);
      for (const face of row.faces) expect(effectClasses).toContain(face.class);
    }
  });

  it("names only secret fields every variant of the command has", () => {
    const members = unionMembers();
    for (const [type, row] of Object.entries(commandTable)) {
      for (const field of row.secretFields ?? [])
        for (const member of members.get(type) ?? [])
          expect(Object.keys(member.shape), `${type}.${field}`).toContain(field);
    }
  });

  it("decides the face from the input where the input can tell", () => {
    const done = commandTable["thread.done.set"];
    const base = { type: "thread.done.set", idempotencyKey: "k", threadId: "thr_x" } as const;
    expect(done.face?.({ ...base, done: true } as never)).toBe(0);
    expect(done.face?.({ ...base, done: false } as never)).toBe(1);
    const status = commandTable["channel.connection.status.set"];
    const chat = { type: "channel.connection.status.set", idempotencyKey: "k" } as const;
    expect(status.face?.({ ...chat, status: "paused" } as never)).toBe(0);
    expect(status.face?.({ ...chat, status: "revoked" } as never)).toBe(0);
    expect(status.face?.({ ...chat, status: "connected" } as never)).toBe(1);
    // Only the stored policy says whether a switch goes up.
    expect(commandTable["machine.access.update"].face?.({} as never)).toBeUndefined();
    expect(commandTable["connection.update"].face?.({} as never)).toBeUndefined();
  });
});
