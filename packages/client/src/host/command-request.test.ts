import type { CommandRequestPart, Request } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  commandApproval,
  commandDecline,
  commandDoneMyself,
  commandRequestView,
  commandRequestWords,
} from "./command-request.js";

const part: CommandRequestPart = {
  type: "connection.update",
  family: "connections",
  face: "widen-self",
  summary:
    "Change a connected agent's access: “Research” · Asked by the connected agent “Research”",
  sentence: "Change a connected agent's access: “Research”",
  gives: "It gives “Research” the browser profile “Work”.",
  command: {
    type: "connection.update",
    connectionId: "mcn_1",
    expectedRevision: 3,
    grant: {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: "bpr_1" }],
    },
  },
  secretPaths: [],
  governs: { kind: "connection", id: "mcn_1" },
  askKey: "0".repeat(64),
  argumentsDigest: "1".repeat(64),
  proposer: { kind: "connection", name: "Research", taskTitle: null, key: "connection:mcn_1" },
  agentReason: "I need your work profile to book the flight.",
  notes: [
    { path: "/connectionId", name: "“Research”" },
    { path: "/grant", current: 'Reach: "everything"' },
    { path: "/grant/resources/0/profileId", name: "“Work”" },
  ],
  editor: null,
};

const pending = {
  id: "req_1",
  status: "pending",
  reviewedRevision: "7",
  command: part,
} as unknown as Request & { reviewedRevision: string };

describe("a command Request as the person reviews it", () => {
  it("shows the Home's sentence, who asked, the agent's words apart, and every argument", () => {
    const view = commandRequestView(pending)!;
    expect(view.sentence).toBe("Change a connected agent's access: “Research”");
    expect(view.askedBy).toBe("Asked by the connected agent “Research”");
    expect(view.agentWords).toEqual({
      label: "The connected agent says (its own words, not checked by the Home)",
      text: "I need your work profile to book the flight.",
    });
    expect(view.gives).toBe(part.gives);
    expect(
      view.rows.map(({ path, label, value, name, current }) => [path, label, value, name, current]),
    ).toEqual([
      ["/connectionId", "Connected agent", '"mcn_1"', "“Research”", null],
      ["/expectedRevision", "As of version", "3", null, null],
      ["/grant", "What it may use", null, null, 'Reach: "everything"'],
      ["/grant/scope", "Reach", '"selected"', null, null],
      ["/grant/tasks", "Tasks", "false", null, null],
      ["/grant/resources", "Chosen", null, null, null],
      ["/grant/resources/0", "1", null, null, null],
      ["/grant/resources/0/kind", "Kind", '"browser-profile"', null, null],
      ["/grant/resources/0/profileId", "Browser profile", '"bpr_1"', "“Work”", null],
    ]);
    // A reach reads in the product's words beside its value.
    expect(view.rows.find(({ path }) => path === "/grant/scope")?.meaning).toBe(
      "Only what is chosen",
    );
    expect(view.line).toBe(commandRequestWords.pending);
    expect(view.approve).toEqual({ label: "Approve" });
    expect(view.decline).toEqual({ label: "Decline" });
  });

  it("approves the Request for the revision reviewed, sending no command of its own; declines as before", () => {
    // One key per Request and revision: sent again after a lost answer, it is the same approval.
    expect(commandApproval(pending)).toEqual({
      type: "request.command.approve",
      requestId: "req_1",
      expectedRevision: "7",
      idempotencyKey: "command-approve:req_1:7",
    });
    expect(commandApproval(pending)).toEqual(commandApproval({ ...pending }));
    expect(commandDecline(pending, "key-3")).toEqual({
      type: "request.respond",
      requestId: "req_1",
      expectedRevision: "7",
      idempotencyKey: "key-3",
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
  });

  it("never offers Approve for a command that carries a secret: its own screen, I did it myself, or Decline", () => {
    const secret = {
      ...pending,
      command: {
        ...part,
        type: "plugin.oauthApp.save",
        secretPaths: ["input.clientSecret"],
        command: { type: "plugin.oauthApp.save", input: { clientId: "c" } },
        editor: { screen: "plugin" },
      },
    } as typeof pending;
    const view = commandRequestView(secret)!;
    expect(view.approve).toBeNull();
    expect(view.personOnly).toEqual({
      needs: "Input › Client secret",
      screen: { id: "plugin", label: "Plugins" },
    });
    expect(view.doneMyself).toEqual({ label: "I did it myself" });
    expect(view.decline).toEqual({ label: "Decline" });
    expect(view.line).toBe(commandRequestWords.personOnly);
    expect(commandDoneMyself(secret, "key-4")).toEqual({
      type: "request.respond",
      requestId: "req_1",
      expectedRevision: "7",
      idempotencyKey: "key-4",
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
    const done = commandRequestView({
      ...secret,
      status: "declined",
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    } as never)!;
    expect(done.state).toBe("person-says-done");
    // The person's statement, not evidence: nothing claims it happened.
    expect(done.line).toBe(commandRequestWords["person-says-done"]);
    expect(done.line).toMatch(/nothing here shows that it happened/u);
  });

  it("shows an automation's secret proposal by its names only, with no Approve, and opens its Secrets", () => {
    const view = commandRequestView({
      ...pending,
      command: {
        ...part,
        type: "trigger.secrets.set",
        face: "secret",
        secretPaths: ["set"],
        gives: "This agent can change the script that will read the value without asking you.",
        command: { type: "trigger.secrets.set", triggerId: "trg_1", names: ["API_KEY", "TOKEN"] },
        editor: { screen: "automation-secrets" },
      },
    } as typeof pending)!;
    expect(view.approve).toBeNull();
    expect(view.personOnly?.screen).toEqual({
      id: "automation-secrets",
      label: "the automation's Secrets",
    });
    expect(
      view.rows.filter(({ value }) => value !== null).map(({ path, value }) => [path, value]),
    ).toEqual([
      ["/triggerId", '"trg_1"'],
      ["/names/0", '"API_KEY"'],
      ["/names/1", '"TOKEN"'],
    ]);
    expect(view.gives).toBe(
      "This agent can change the script that will read the value without asking you.",
    );
    expect(view.doneMyself).not.toBeNull();
    expect(view.decline).not.toBeNull();
  });

  it("shows text from outside the Home as it is: no name closes the Home's quotes, nothing hidden turns it around", () => {
    const view = commandRequestView({
      ...pending,
      command: {
        ...part,
        proposer: {
          ...part.proposer,
          name: "X” — the Home checked this; it only reads. “Y",
          taskTitle: "Line one\nLine two",
        },
        agentReason: "Fine\u202Etxt.exe",
        command: { ...part.command, label: "Safe\u202Egnp.exe\u200B", note: "first\nsecond" },
      },
    } as typeof pending)!;
    expect(view.askedBy).toBe(
      "Asked by the connected agent “X' — the Home checked this; it only reads. 'Y”, in its task “Line one Line two”",
    );
    expect(view.rowsHeading).toBe(
      "Proposed by the connected agent “X' — the Home checked this; it only reads. 'Y”, exactly as it would run",
    );
    // The agent's prose loses what could turn it around; its values keep it, escaped.
    expect(view.agentWords?.text).toBe("Finetxt.exe");
    const value = (path: string) => view.rows.find((row) => row.path === path)?.value;
    expect(value("/label")).toBe('"Safe\\u202Egnp.exe\\u200B"');
    // A value keeps its own lines: they are part of what runs.
    expect(value("/note")).toBe('"first\\nsecond"');
  });

  it("says what became of it, and never calls an outcome it cannot know a failure", () => {
    const settled = (status: Request["status"], outcome?: CommandRequestPart["outcome"]) =>
      commandRequestView({ ...pending, status, command: { ...part, outcome } } as never)!;
    expect(settled("fulfilled", { status: "running" }).line).toBe(commandRequestWords.running);
    expect(settled("fulfilled", { status: "done" }).line).toBe(commandRequestWords.done);
    expect(
      settled("fulfilled", {
        status: "failed",
        code: "conflict",
        message: "The Home refused it, so nothing changed.",
      }).state,
    ).toBe("refused");
    const unknown = settled("fulfilled", { status: "unknown" });
    expect(unknown.state).toBe("unknown");
    expect(unknown.line).not.toMatch(/fail/iu);
    expect(settled("declined").line).toBe(commandRequestWords.declined);
    expect(settled("cancelled").line).toBe(commandRequestWords.closed);
    for (const status of ["fulfilled", "declined", "cancelled"] as const)
      expect(settled(status).approve).toBeNull();
  });
});
