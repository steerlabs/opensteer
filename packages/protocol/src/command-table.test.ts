import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostApi } from "./host-api.js";
import {
  commandFamilies,
  commandResourceKey,
  commandTable,
  effectClasses,
  type CommandResource,
  type CommandStep,
  type CommandType,
} from "./command-table.js";
import { commandEditor, commandTitles } from "./command-words.js";
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

/** Whether a JSON Schema has a property at this path, through objects, unions and $refs. */
function hasPath(schema: unknown, path: readonly string[], root: unknown = schema): boolean {
  if (!schema || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    const target = node.$ref
      .replace(/^#\//u, "")
      .split("/")
      .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], root);
    return hasPath(target, path, root);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const)
    if (Array.isArray(node[key]) && node[key].some((option) => hasPath(option, path, root)))
      return true;
  if (path.length === 0) return true;
  const properties = node.properties as Record<string, unknown> | undefined;
  return properties?.[path[0]!] !== undefined && hasPath(properties[path[0]!], path.slice(1), root);
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

  it("names only secret paths every variant of the command has, nested ones included", () => {
    const members = unionMembers();
    for (const [type, row] of Object.entries(commandTable)) {
      for (const path of row.secretFields ?? [])
        for (const member of members.get(type) ?? []) {
          const schema = z.toJSONSchema(member, { unrepresentable: "any", io: "input" });
          expect(hasPath(schema, path.split(".")), `${type}.${path}`).toBe(true);
        }
    }
    // The reviewer's two: a nested client secret is named; the rest of the input is not.
    expect(commandTable["plugin.authorization.begin"].secretFields).toEqual([
      "input.client.clientSecret",
    ]);
    expect(commandTable["plugin.oauthApp.save"].secretFields).toEqual(["input.clientSecret"]);
  });

  it("gives a face to every input that lifts a gate, releases a login or turns on automatic", () => {
    const face = (type: CommandType, input: Record<string, unknown>) =>
      (commandTable[type] as unknown as { face?: (c: unknown) => number | undefined }).face?.({
        type,
        idempotencyKey: "k",
        ...input,
      });
    const classOf = (type: CommandType, input: Record<string, unknown>) => {
      const index = face(type, input);
      return index === undefined ? "the store decides" : commandTable[type].faces[index]!.class;
    };
    const password = "browser.password-sign-in.respond";
    expect(classOf(password, { decision: { kind: "approve" } })).toBe("approve");
    expect(classOf(password, { decision: { kind: "approve-card" } })).toBe("approve");
    expect(classOf(password, { decision: { kind: "decline" } })).toBe("narrow");
    const defaults = "execution.preferences.remember";
    expect(classOf(defaults, {})).toBe("preference");
    expect(classOf(defaults, { accessMode: "approval-required" })).toBe("preference");
    expect(classOf(defaults, { accessMode: "full-access" })).toBe("the store decides");
    const schedule = "plugins.schedule.configure";
    expect(classOf(schedule, { enabled: true, approvalMode: "automatic" })).toBe("approve");
    expect(classOf(schedule, { enabled: false, approvalMode: "automatic" })).toBe("approve");
    expect(classOf(schedule, { enabled: true })).toBe("widen-self");
    expect(classOf(schedule, { enabled: false, approvalMode: "browser" })).toBe("narrow");
    expect(classOf("connection.authorize", { decision: { kind: "deny" } })).toBe("narrow");
    expect(classOf("connection.authorize", { decision: { kind: "approve" } })).toBe("widen-other");
    expect(classOf("plugins.schedule.answer", { action: "decline" })).toBe("narrow");
    expect(classOf("plugins.schedule.answer", { action: "accept" })).toBe("approve");
  });

  it("names what a command governs the same way however the input orders it", () => {
    const governs = (type: CommandType, input: Record<string, unknown>) =>
      commandResourceKey(
        (commandTable[type].governs as (c: unknown) => CommandResource)({ type, ...input }),
      );
    expect(governs("tab.close", { tabIds: ["b", "a", "a"] })).toBe(
      governs("tab.close", { tabIds: ["a", "b"] }),
    );
    const target = governs("settings.plugin.enabled.set", {
      target: { kind: "plugin", pluginId: "github" },
    });
    expect(target).toBe(JSON.stringify(["plugin-setting", "plugin:github", null, null, null]));
    // A direct session is reached through its own task; a delegation is not a Request.
    expect(
      (commandTable["agent.session.stop"].governs as (c: unknown) => CommandResource)({
        threadId: "thr_1",
        agentSessionId: "ags_1",
      }),
    ).toEqual({ kind: "agent-session", id: "ags_1", task: "thr_1" });
    expect(
      (commandTable["assignment.cancel"].governs as (c: unknown) => CommandResource)({
        assignmentId: "asg_1",
      }).kind,
    ).toBe("assignment");
  });

  it("gives every command a title and says where the person reviews it", () => {
    for (const type of Object.keys(commandTable) as CommandType[]) {
      expect(commandTitles[type].length, type).toBeGreaterThan(0);
      expect(commandTitles[type].length, type).toBeLessThanOrEqual(60);
      const editor = commandEditor(type);
      if (editor !== null) expect(editor.screen.length, type).toBeGreaterThan(0);
    }
    expect(commandEditor("connection.update")).toEqual({ screen: "connected-agent" });
    expect(commandEditor("browser.pool.restart")).toBeNull();
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
