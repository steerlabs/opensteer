import { describe, expect, it } from "vitest";
import {
  isAllowedConnectionPageUrl,
  isExtensionUrl,
  normalizePageOpenUrl,
  ThreadAccessModeSchema,
  type ThreadAccessMode,
} from "@opensteer/core";
import {
  commandFace,
  commandFaceStep,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import expected from "../../protocol/src/command-table.rows.json" with { type: "json" };
import {
  commandRule,
  executionMayManageExtensions,
  type CommandAnswer,
  type CommandRuleCaller,
  type ExecutionAuthority,
} from "./resource-access.js";

type Column = "a" | "b" | "c" | "d";
interface ExpectedRow {
  readonly type: string;
  readonly faces: readonly {
    /** `b:auto` where Auto answers otherwise than the other modes below Full access. */
    readonly answers: Readonly<Record<Column, CommandAnswer>> & {
      readonly "b:auto"?: CommandAnswer;
    };
  }[];
}
const rows = expected.rows as readonly ExpectedRow[];
const belowFullAccess = ThreadAccessModeSchema.options.filter(
  (mode): mode is Exclude<ThreadAccessMode, "full-access"> => mode !== "full-access",
);

/** The four callers of the data file; each covers the resource the command governs, as its own. */
const callers: Readonly<Record<Column, (mode?: ThreadAccessMode) => CommandRuleCaller>> = {
  a: () => ({ connection: null, mode: "full-access", reach: true, ownWork: true }),
  b: (mode = "auto") => ({ connection: null, mode, reach: true, ownWork: true }),
  c: (mode = "full-access") => ({
    connection: { grant: "everything" },
    mode,
    reach: true,
    ownWork: true,
    ownLineage: true,
  }),
  d: (mode = "full-access") => ({
    connection: { grant: "selected" },
    mode,
    reach: true,
    ownWork: true,
    ownLineage: true,
  }),
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
            const want =
              column === "b" && mode === "auto"
                ? (face.answers["b:auto"] ?? face.answers.b)
                : face.answers[column];
            if (got !== want)
              mismatches.push(
                `${expectedRow.type} face ${index} (${column}${mode ? ` ${mode}` : ""}): ${got}, expected ${want}`,
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
            const own =
              mode === "auto" ? (face.answers["b:auto"] ?? face.answers.b) : face.answers.b;
            // A face that holds only connections to the read-write ceiling asks below Auto.
            const heldToReadWrite =
              row(expectedRow.type).faces[index]?.readWrite === "connections" && mode !== "auto";
            const want = full === "now" && (own !== "now" || heldToReadWrite) ? "ask" : full;
            expect(
              answer(expectedRow.type, index, callers[column](mode)),
              `${expectedRow.type} face ${index} (${column} ${mode})`,
            ).toBe(want);
          }
        }
      });
  });

  it("reads anything outside the caller's reach exactly like something that does not exist", () => {
    // Outside a grant, outside a lineage, another principal's, or not there at all: one answer,
    // for connections and for your own agents alike. Only a Home-wide thing (decided by the grant)
    // and a new one (nothing exists yet to be outside of) have no reach to miss.
    for (const type of Object.keys(commandTable)) {
      const table = row(type);
      table.faces.forEach((_, index) => {
        for (const connection of [
          null,
          { grant: "everything" as const },
          { grant: "selected" as const },
        ]) {
          for (const mode of ["full-access", "auto"] as const) {
            const outside = answer(type, index, { connection, mode, reach: false, ownWork: true });
            const label = `${type} face ${index} (${connection?.grant ?? "own"} ${mode})`;
            if (table.scope === "home")
              expect(outside, label).toBe(
                answer(type, index, { connection, mode, reach: true, ownWork: true }),
              );
            else expect(outside, label).toBe("not_found");
          }
        }
      });
    }
  });

  it("never shows a connected agent another connection, `everything` included", () => {
    for (const [type, table] of Object.entries(commandTable)) {
      if (table.scope !== "connection" && table.scope !== "other-connection") continue;
      table.faces.forEach((_, index) => {
        for (const grant of ["everything", "selected"] as const) {
          const caller = { connection: { grant }, mode: "full-access" as const, ownWork: true };
          expect(answer(type, index, { ...caller, reach: false }), `${type} (${grant})`).toBe(
            "not_found",
          );
          if (table.scope === "other-connection")
            expect(answer(type, index, { ...caller, reach: true }), `${type} (${grant})`).toBe(
              "not_found",
            );
        }
      });
    }
  });

  it("never shows a connected agent a chat account or a chat: they are other connections (X13)", () => {
    for (const [type, table] of Object.entries(commandTable)) {
      if (table.family !== "chats") continue;
      table.faces.forEach((_, index) => {
        for (const grant of ["everything", "selected"] as const)
          expect(
            answer(type, index, {
              connection: { grant },
              mode: "full-access",
              reach: true,
              ownWork: true,
            }),
            `${type} face ${index} (${grant})`,
          ).toBe("not_found");
      });
    }
  });

  it("asks a connection before an effect that goes on outside its own lineage (X11)", () => {
    const outside = (grant: "everything" | "selected") => ({
      connection: { grant },
      mode: "full-access" as const,
      reach: true,
      ownWork: true,
      ownLineage: false,
    });
    const at = (command: Record<string, unknown>, caller: CommandRuleCaller) =>
      commandRule(row(command.type as string), commandFace(command as never), caller);
    const script = { interpreter: null, text: "console.log(1)" };
    for (const grant of ["everything", "selected"] as const) {
      // What another lineage's automation will run, or a run of it now, is recorded as that
      // lineage's: Disconnect would not reach it.
      for (const command of [
        { type: "trigger.update", triggerId: "trg_1", input: { script } },
        {
          type: "trigger.update",
          triggerId: "trg_1",
          input: {
            source: {
              kind: "schedule",
              schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
            },
          },
        },
        { type: "trigger.run", triggerId: "trg_1" },
      ])
        expect(at(command, outside(grant)), `${command.type} ${grant}`).toEqual({
          answer: "ask",
          reason: "lineage",
        });
      // Renaming, pausing, archiving and cancelling leave nothing running in anyone's name.
      for (const command of [
        { type: "trigger.update", triggerId: "trg_1", input: { name: "Renamed" } },
        { type: "trigger.status.set", triggerId: "trg_1", status: "paused" },
        { type: "trigger.status.set", triggerId: "trg_1", status: "archived" },
        { type: "trigger.cancel", triggerId: "trg_1" },
      ])
        expect(at(command, outside(grant)).answer, `${command.type} ${grant}`).toBe("now");
      // In its own lineage, as approved.
      expect(
        at({ type: "trigger.run", triggerId: "trg_1" }, { ...outside(grant), ownLineage: true })
          .answer,
      ).toBe("now");
    }
  });

  it("asks a connection before anything that runs on where its lineage is not proven its own (X11)", () => {
    const at = (command: Record<string, unknown>, ownLineage: boolean | undefined) =>
      commandRule(row(command.type as string), commandFace(command as never), {
        connection: { grant: "everything" },
        mode: "full-access",
        reach: true,
        ownWork: true,
        ...(ownLineage === undefined ? {} : { ownLineage }),
      }).answer;
    const script = { interpreter: null, text: "console.log('x')" };
    for (const command of [
      { type: "trigger.status.set", triggerId: "trg_1", status: "active" },
      { type: "trigger.create", input: { anchorThreadId: "thr_1", name: "n", script } },
      { type: "thread.inputQueue.resume", threadId: "thr_1" },
      { type: "thread.input.steer", threadId: "thr_1", messageId: "msg_1" },
      { type: "thread.execution.update", threadId: "thr_1" },
      { type: "request.respond", requestId: "req_1", response: { kind: "external" } },
      { type: "browser.session.start", input: { threadId: "thr_1" } },
      { type: "app.start", appId: "app_1" },
      { type: "plugins.install", source: { kind: "mcp" } },
      { type: "plugins.version.activate", pluginId: "p", versionId: "v" },
      { type: "plugins.workflow.start", pluginId: "p" },
    ]) {
      for (const lineage of [false, undefined])
        expect(at(command, lineage), `${command.type} ${lineage}`).toBe("ask");
      expect(at(command, true), command.type).not.toBe("not_found");
    }
  });

  it("lets a connection remove something for good only at Full access (the lead's C2 line)", () => {
    for (const type of [
      "browser.profile.delete",
      "browser.history.clear",
      "browser.history.remove",
      "browser.site.remove",
      "machine.revoke",
    ]) {
      const at = (grant: "everything" | "selected", mode: ThreadAccessMode) =>
        answer(type, 0, {
          connection: { grant },
          mode,
          reach: true,
          ownWork: true,
          ownLineage: true,
        });
      expect(at("everything", "full-access"), type).toBe("now");
      for (const mode of belowFullAccess)
        expect(at("everything", mode), `${type} ${mode}`).toBe("ask");
      for (const mode of ThreadAccessModeSchema.options)
        expect(at("selected", mode), `${type} selected ${mode}`).not.toBe("now");
    }
  });

  it("lets a connection change and run an automation in its own lineage as the rule says (X11 pin)", () => {
    const own = (mode: ThreadAccessMode) => ({
      connection: { grant: "everything" as const },
      mode,
      reach: true,
      ownWork: true,
      ownLineage: true,
    });
    const script = { interpreter: null, text: "console.log('x')" };
    for (const command of [
      { type: "trigger.create", input: { anchorThreadId: "thr_1", name: "n", script } },
      { type: "trigger.update", triggerId: "trg_1", input: { script } },
      { type: "trigger.run", triggerId: "trg_1" },
    ]) {
      const at = (mode: ThreadAccessMode) =>
        commandRule(row(command.type), commandFace(command as never), own(mode)).answer;
      expect(at("full-access"), command.type).toBe("now");
      // Below Full access these need Full access today (D1), so they ask.
      for (const mode of belowFullAccess) expect(at(mode), `${command.type} ${mode}`).toBe("ask");
    }
  });

  it("asks before opening a tab below the read-write ceiling, as today's tab_open refuses (X12)", () => {
    for (const type of ["tab.open"]) {
      const at = (mode: ThreadAccessMode) =>
        answer(type, 0, { connection: null, mode, reach: true, ownWork: true });
      expect(at("full-access"), type).toBe("now");
      expect(at("auto"), type).toBe("now");
      expect(at("approval-required"), type).toBe("ask");
      expect(at("auto-accept-edits"), type).toBe("ask");
    }
  });

  it("lets a connection open or close a tab from Auto up and asks below it (approved C2 line)", () => {
    for (const type of ["tab.open", "tab.close"]) {
      const at = (mode: ThreadAccessMode) =>
        answer(type, 0, {
          connection: { grant: "everything" },
          mode,
          reach: true,
          ownWork: true,
          ownLineage: true,
        });
      expect(at("full-access"), type).toBe("now");
      expect(at("auto"), type).toBe("now");
      expect(at("auto-accept-edits"), type).toBe("ask");
      expect(at("approval-required"), type).toBe("ask");
    }
    // Your own agent closes a tab as today's tab_close lets it, in any mode (D0a recording).
    expect(
      answer("tab.close", 0, {
        connection: null,
        mode: "approval-required",
        reach: true,
        ownWork: true,
      }),
    ).toBe("now");
  });

  it("asks your own agent below Full access about a task above its mode", () => {
    // In reach (the person's own task) but not its own work: a higher mode than it holds.
    for (const [type, table] of Object.entries(commandTable)) {
      if (table.scope !== "task") continue;
      table.faces.forEach((face, index) => {
        for (const mode of belowFullAccess) {
          const got = answer(type, index, { connection: null, mode, reach: true, ownWork: false });
          expect(got, `${type} ${mode}`).toBe(face.class === "person-view" ? "not_found" : "ask");
        }
      });
    }
  });

  it("lets your own Full agent make a schedule that approves itself, and asks everyone else", () => {
    // The lead's ruling: a schedule a task makes never asks less than that task, and at Full
    // access nothing asks; a connection's would run on past its Disconnect.
    const automatic = commandFace({
      type: "plugins.schedule.configure",
      pluginId: "plugin",
      schedule: "tick",
      enabled: true,
      idempotencyKey: "k",
    } as never);
    expect(automatic).toBe(2);
    const rule = (caller: CommandRuleCaller) =>
      commandRule(row("plugins.schedule.configure"), automatic, caller).answer;
    expect(rule(callers.a())).toBe("now");
    for (const mode of belowFullAccess) expect(rule(callers.b(mode)), mode).toBe("ask");
    for (const mode of ThreadAccessModeSchema.options) {
      expect(rule(callers.c(mode)), `everything ${mode}`).toBe("ask");
      expect(rule(callers.d(mode)), `selected ${mode}`).toBe("ask");
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
      // b is 19, not the data file's first 21: creating (D1) or changing (D0a) an automation
      // needs Full access, as today's tools say.
    }).toEqual({ a: 51, b: 19, c: 46, d: 23 });
  });
});

describe("a command whose effect a store cannot admit, for an agent (AD3)", () => {
  it("never runs the owner's name change for an agent: every caller, every mode, asks or finds nothing", () => {
    // `viewer.name.update` goes through `ownerProfile.update`, which takes no identity: so no agent
    // may reach it as `now`. An approval runs it as the person, on the person's session.
    for (const column of ["a", "b", "c", "d"] as const)
      for (const mode of ThreadAccessModeSchema.options)
        expect(
          answer("viewer.name.update", 0, callers[column](mode)),
          `${column} ${mode}`,
        ).not.toBe("now");
  });
});

describe("executionMayManageExtensions (Rule 1 / 2b)", () => {
  const baseExecution = (
    overrides: Partial<Pick<ExecutionAuthority, "actor" | "agentConnection" | "mode">> = {},
  ): Pick<ExecutionAuthority, "actor" | "agentConnection" | "mode"> => ({
    actor: "native",
    mode: "full-access",
    agentConnection: null,
    ...overrides,
  });

  it("allows only a native Full access execution with personal context on the person's own lineage", () => {
    expect(executionMayManageExtensions(baseExecution())).toBe(true);
    for (const mode of belowFullAccess) {
      expect(executionMayManageExtensions(baseExecution({ mode })), mode).toBe(false);
    }
    expect(executionMayManageExtensions(baseExecution({ actor: "agent" }))).toBe(false);
    expect(executionMayManageExtensions(baseExecution({ actor: "person" }))).toBe(false);
    expect(
      executionMayManageExtensions(
        baseExecution({
          agentConnection: {
            agentConnectionId: "acn_00000000-0000-0000-0000-000000000001" as never,
            grant: { scope: "everything" },
            grantRevision: 1,
            consentVersion: 1,
            accessMode: "full-access",
            bridgeSenders: null,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("connection page-open URL protocol checks (M4)", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";

  it("uses WHATWG URL parsing so tabs, newlines, control chars, mixed case, and view-source cannot bypass scheme guards", () => {
    for (const blocked of [
      `chrome-extension://${id}/options.html`,
      `chrome-ex\ttension://${id}/options.html`,
      `chrome-ex\ntension://${id}/options.html`,
      `\u0001chrome-extension://${id}/options.html`,
      `  ChRoMe-ExTeNsIoN://${id}/options.html`,
      `view-source:chrome-extension://${id}/options.html`,
      `view-source:chrome-ex\ttension://${id}/options.html`,
      `blob:chrome-extension://${id}/0b1c`,
      `filesystem:chrome-extension://${id}/temporary/x`,
    ]) {
      expect(isExtensionUrl(blocked), blocked).toBe(true);
      expect(isAllowedConnectionPageUrl(blocked), blocked).toBe(false);
    }
    for (const otherBlocked of [
      "view-source:https://example.test/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.test/",
    ]) {
      expect(isAllowedConnectionPageUrl(otherBlocked), otherBlocked).toBe(false);
    }
    expect(isAllowedConnectionPageUrl("about:blank")).toBe(true);
    expect(isAllowedConnectionPageUrl("https://example.test/path")).toBe(true);
    expect(isAllowedConnectionPageUrl("http://127.0.0.1:8080/")).toBe(true);
    expect(normalizePageOpenUrl("about:blank")).toBe("about:blank");
    expect(normalizePageOpenUrl("  ht\ttps://example.test/path ")).toBe(
      "https://example.test/path",
    );
  });
});
