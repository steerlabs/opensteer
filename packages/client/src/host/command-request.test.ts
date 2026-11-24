import type { CommandRequestPart, Request } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  commandApproval,
  commandDecline,
  commandRequestView,
  commandRequestWords,
} from "./command-request.js";

const part: CommandRequestPart = {
  type: "connection.update",
  family: "connections",
  face: "widen-self",
  summary: "Change a connected agent: “Research” · Asked by the agent “Research”",
  sentence: "Change a connected agent: “Research”",
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
    { path: "connectionId", name: "“Research”" },
    { path: "grant", current: "Reach: everything" },
    { path: "grant.resources.0.profileId", name: "“Work”" },
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
    expect(view.sentence).toBe("Change a connected agent: “Research”");
    expect(view.askedBy).toBe("Asked by the connected agent “Research”");
    expect(view.agentWords).toEqual({
      label: "The connected agent says (its own words, not checked by the Home)",
      text: "I need your work profile to book the flight.",
    });
    expect(view.gives).toBe(part.gives);
    expect(
      view.rows.map(({ path, label, value, name, current }) => [path, label, value, name, current]),
    ).toEqual([
      ["connectionId", "Connected agent", "mcn_1", "“Research”", null],
      ["expectedRevision", "As of version", "3", null, null],
      ["grant", "What it may use", null, null, "Reach: everything"],
      ["grant.scope", "Reach", "selected", null, null],
      ["grant.tasks", "Tasks", "No", null, null],
      ["grant.resources", "Chosen", null, null, null],
      ["grant.resources.0", "1", null, null, null],
      ["grant.resources.0.kind", "Kind", "browser-profile", null, null],
      ["grant.resources.0.profileId", "Browser profile", "bpr_1", "“Work”", null],
    ]);
    expect(view.line).toBe(commandRequestWords.pending);
    expect(view.approve).toEqual({ label: "Approve" });
    expect(view.decline).toEqual({ label: "Decline" });
  });

  it("approves exactly the command as proposed, for the revision reviewed, with what only the person types", () => {
    expect(commandApproval(pending, "key-1")).toEqual({
      type: "request.command.approve",
      requestId: "req_1",
      expectedRevision: "7",
      idempotencyKey: "key-1",
      command: part.command,
    });
    const secret = {
      ...pending,
      command: {
        ...part,
        secretPaths: ["input.clientSecret"],
        command: { type: "plugin.oauthApp.save", input: { clientId: "c" } },
      },
    } as typeof pending;
    expect(commandRequestView(secret)!.secrets).toEqual([
      { path: "input.clientSecret", label: "Input › Client secret" },
    ]);
    expect(commandApproval(secret, "key-2", { "input.clientSecret": "s3cret" }).command).toEqual({
      type: "plugin.oauthApp.save",
      input: { clientId: "c", clientSecret: "s3cret" },
    });
    expect(commandDecline(pending, "key-3")).toEqual({
      type: "request.respond",
      requestId: "req_1",
      expectedRevision: "7",
      idempotencyKey: "key-3",
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
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
