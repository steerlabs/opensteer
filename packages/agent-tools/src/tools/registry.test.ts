import { describe, expect, it } from "vitest";
import {
  agentTools,
  computer,
  delegate_task,
  pending_request,
  thread_wait,
  thread_configure,
} from "./index.js";
import { sign_in } from "./browser.js";
import { person_message } from "./person.js";
import { trigger_read, trigger_write } from "./triggers.js";

describe("Opensteer tool registry", () => {
  it("has one specification per product and integration tool", () => {
    expect(agentTools).toHaveLength(51);
    expect(new Set(agentTools.map(({ name }) => name)).size).toBe(51);
    const runs = agentTools.filter((t) => t.callers.some((c) => c === "run")).map((t) => t.name);
    expect(runs).toContain("integration_call");
    expect(runs).toEqual(
      expect.arrayContaining([
        "delegate_task",
        "thread_send",
        "thread_wait",
        "pending_request",
        "orchestrator_capabilities",
      ]),
    );
    for (const old of ["thread_delegate", "thread_message", "request_list"])
      expect(runs).not.toContain(old);
    const programs = agentTools
      .filter((t) => t.callers.some((c) => c === "program"))
      .map((t) => t.name);
    expect(programs).toContain("delegate_task");
    expect(programs).not.toContain("person_show");
    expect(programs).not.toContain("computer");
  });
  it("exposes bounded waiting and connection work without human-only controls", () => {
    const connections = agentTools.filter((t) => t.callers.some((c) => c === "connection"));
    for (const name of [
      "delegate_task",
      "thread_send",
      "thread_wait",
      "thread_configure",
      "thread_queue",
    ])
      expect(connections.map((t) => t.name)).toContain(name);
    const wait = agentTools.find((t) => t.name === "thread_wait");
    expect(
      wait?.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        timeoutMs: 100001,
      }).success,
    ).toBe(false);
  });
  it("strips an unnamed secret from a tool result", () => {
    expect(
      person_message.output.parse({
        messageId: "msg_11111111-1111-4111-8111-111111111111",
        surpriseSecret: "never leave the Host",
      }),
    ).not.toHaveProperty("surpriseSecret");
  });
  it("refuses task placement, ambiguous waits and unobserved Request answers", () => {
    expect(
      delegate_task.input.safeParse({ task: "Inspect", environmentId: "env_any" }).success,
    ).toBe(false);
    expect(thread_wait.input.safeParse({}).success).toBe(false);
    expect(
      thread_wait.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        assignmentId: "dlg_11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(pending_request.input.safeParse({ action: "read" }).success).toBe(false);
    expect(pending_request.input.safeParse({ action: "respond" }).success).toBe(false);
    expect(
      pending_request.input.safeParse({
        action: "respond",
        requestId: "req_11111111-1111-4111-8111-111111111111",
        expectedRevision: "seen",
        response: { kind: "form", answers: { answer: ["42"] } },
      }).success,
    ).toBe(true);
  });
  it("strips wait metadata and refuses access-mode changes through configure", () => {
    expect(
      thread_wait.output.parse({
        hasMore: false,
        status: "running",
        items: [],
        token: "secret",
        run: {
          id: "run_11111111-1111-4111-8111-111111111111",
          status: "running",
          token: "secret",
        },
      }),
    ).toEqual({
      hasMore: false,
      status: "running",
      items: [],
      run: { id: "run_11111111-1111-4111-8111-111111111111", status: "running" },
    });
    expect(
      thread_configure.input.safeParse({
        threadId: "thr_11111111-1111-4111-8111-111111111111",
        accessMode: "full-access",
      }).success,
    ).toBe(false);
  });
  it("retains safe Trigger details and cancellation receipts", () => {
    const detail = {
      activation: null,
      anchorThreadTitle: "Anchor",
      createdByThreadTitle: null,
      downstreamRuns: [],
      downstreamRunsTruncated: false,
      canceledOccurrenceIds: ["toc_11111111-1111-4111-8111-111111111111"],
    };
    expect(trigger_write.output.parse({ ...detail, unnamedSecret: "hidden" })).toEqual(detail);
  });
  it("preserves the image detail hint while stripping unnamed metadata", () => {
    const image = {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" },
    };
    expect(
      computer.output.parse({
        content: [
          {
            ...image,
            surpriseSecret: "hidden",
            _meta: { ...image._meta, surpriseSecret: "hidden" },
          },
        ],
      }),
    ).toEqual({ content: [image] });
  });
  it("returns a ready sign-in's login reference, which grants nothing without the Run's authority", () => {
    const ready = {
      status: "ready",
      site: "https://example.com",
      loginRef: `lgn_${"1".repeat(32)}`,
      account: "a•••@example.com",
    };
    expect(sign_in.output.parse({ ...ready, password: "hidden" })).toEqual(ready);
  });
  it("returns webhook setup credentials on writes and excludes them from reads", () => {
    const result = {
      webhook: { secret: "oswh_private", url: "https://example.test/private" },
    };
    expect(trigger_write.output.parse(result)).toEqual(result);
    expect(trigger_read.output.parse(result)).toEqual({});
  });
});
