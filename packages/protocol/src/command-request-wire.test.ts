import { readFileSync } from "node:fs";
import { PendingRequestViewSchema, type CommandRequestPart } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostApi } from "./host-api.js";

/**
 * The oldest wire this Home still serves: what released apps read. A command Request must parse
 * with it as an ordinary question, its command part simply not read.
 */
const baseline = JSON.parse(
  readFileSync(new URL("./personal-wire.baseline.json", import.meta.url), "utf8"),
) as Record<"input" | "output", Record<string, z.core.JSONSchema.JSONSchema>>;
function frozen(surface: "input" | "output", name: string) {
  const root = baseline[surface][name];
  if (!root) throw new Error(`No frozen surface ${name}`);
  return z.fromJSONSchema(root);
}

const requestId = "req_00000000-0000-4000-8000-000000000001";
const threadId = "thr_00000000-0000-4000-8000-000000000002";
const runId = "run_00000000-0000-4000-8000-000000000003";
const userId = "usr_00000000-0000-4000-8000-000000000004";
const part: CommandRequestPart = {
  type: "connection.update",
  family: "connections",
  face: "widen-other",
  summary: "Claude Code, from the task “Tidy up”, wants to: Change a connected agent's access",
  gives: "It gives this connected agent more than it holds now.",
  command: { connectionId: "acn_1", expectedRevision: 1, accessMode: "full-access" },
  secretPaths: [],
  governs: { kind: "connection", id: "acn_1" },
  askKey: "a".repeat(64),
  argumentsDigest: "b".repeat(64),
  proposer: { kind: "run", name: "Claude Code", taskTitle: "Tidy up", key: `task:${threadId}` },
  agentReason: "It needs to finish the export",
  editor: { screen: "connected-agent" },
};
const commandRequest = {
  callId: "command:task:1",
  cancellationReason: null,
  createdAt: "2026-11-22T10:00:00.000Z",
  id: requestId,
  kind: "person.question",
  mode: "durable",
  originatingOccurrenceId: null,
  originatingRunId: runId,
  originatingThreadId: threadId,
  payload: { kind: "person.question" },
  presentation: {
    kind: "form",
    title: part.summary,
    detail: `What changes: Change a connected agent's access\n\n${part.gives}\n\nApproving this needs an up-to-date Opensteer app.\n\nThe agent's own reason (its words, not checked): ${part.agentReason}`,
    detailFormat: "plain",
    fields: [
      {
        id: "decision",
        prompt: "Decline it here, or approve it in an up-to-date Opensteer app.",
        choices: [{ label: "Decline", value: "decline" }],
        custom: true,
        multiSelect: false,
        secret: false,
      },
    ],
  },
  requestedBy: userId,
  requiredActor: "owner",
  resolvedAt: null,
  resolvedBy: null,
  response: null,
  status: "pending",
  command: part,
} as const;

describe("a command Request on the wire", () => {
  it("is an ordinary question to the apps the Home still serves, and the part to newer ones", () => {
    const view = PendingRequestViewSchema.parse(commandRequest);
    expect(view.command).toMatchObject({ type: "connection.update" });
    const page = {
      count: 1,
      entries: [
        {
          kind: "request",
          request: view,
          originThreadId: threadId,
          navigationThreadId: threadId,
          purpose: "task",
          title: "Tidy up",
        },
      ],
      window: { byteCount: 1, hasMore: false, itemCount: 1, totalItems: 1, nextBefore: null },
    };
    // The released app's Needs-you page: strict where it is strict, and the count agrees.
    const parsed = frozen("output", "rpc needsYou.get").parse(page) as {
      count: number;
      entries: { request: { kind: string; presentation: { title: string } } }[];
    };
    expect(parsed.count).toBe(parsed.entries.length);
    expect(parsed.entries[0]!.request.kind).toBe("person.question");
    // What it shows is the Home's sentence, not the agent's.
    expect(parsed.entries[0]!.request.presentation.title).toBe(part.summary);
  });

  it("lets the released app answer it only in ways the Home reads as a decline", () => {
    // The released app's own `request.respond` input: everything it can send there declines.
    const respond = frozen("input", "command request.respond");
    for (const response of [
      { kind: "form", answers: { decision: ["decline"] } },
      { kind: "form", answers: { decision: ["Not now, I'll do it myself"] } },
      { kind: "choice", optionId: "decline" },
      { kind: "external", value: { decision: "declined" } },
    ])
      expect(
        respond.safeParse({
          type: "request.respond",
          idempotencyKey: "k",
          requestId,
          response,
          expectedRevision: "1",
        }).success,
        JSON.stringify(response),
      ).toBe(true);
    // Approving is its own command, never a respond: no release is kept yet (rule 6), so the
    // frozen shapes are this branch's own and hold it; only the person's session sends it.
    expect(baseline.input["command request.command.approve"]).toBeDefined();
    const approve = (extra: Record<string, unknown>) =>
      hostApi["commands.dispatch"].payload.safeParse({
        type: "request.command.approve",
        idempotencyKey: "k",
        requestId,
        expectedRevision: "1",
        ...extra,
      }).success;
    // The approval names the Request and the revision reviewed; the Home runs what it stored, so
    // an approval that carries a command of its own is not an approval at all (D1).
    expect(approve({})).toBe(true);
    expect(approve({ command: {} })).toBe(false);
  });
});
