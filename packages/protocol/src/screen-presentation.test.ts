import { randomUUID } from "node:crypto";
import { createId, zeroSequence } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { describe, expect, it } from "vitest";
import { AgentControlRequestSchema, AgentControlResponseSchema } from "./agent-control.js";
import { ClientToHostMessageSchema, HostToClientMessageSchema } from "./client.js";
import { hostApi } from "./host-api.js";

describe("negotiated screen presentation wire", () => {
  it("keeps ordinary subscribe/send frames functional and admits the opt-in transport context", () => {
    const subscribe = {
      type: "client.subscribe",
      apiVersion: hostApiVersion,
      afterSequence: zeroSequence,
      threadId: null,
      workspaceId: createId("workspace"),
    };
    expect(ClientToHostMessageSchema.parse(subscribe)).toEqual(subscribe);
    expect(ClientToHostMessageSchema.parse({ ...subscribe, screenShow: true })).toEqual({
      ...subscribe,
      screenShow: true,
    });
    expect(ClientToHostMessageSchema.safeParse({ ...subscribe, screenShow: false }).success).toBe(
      false,
    );
    const command = {
      type: "thread.sendMessage",
      idempotencyKey: "screen-wire",
      threadId: createId("thread"),
      content: [{ type: "text", text: "Show my task" }],
    };
    const ordinary = hostApi["commands.dispatch"].payload.parse(command);
    expect(ordinary).not.toHaveProperty("screenPresentation");
    const context = {
      endpointRef: "a".repeat(64),
      voiceSessionId: randomUUID(),
      utteranceSequence: 1,
      interactionRevision: 0,
    };
    expect(
      hostApi["commands.dispatch"].payload.parse({ ...command, screenPresentation: context }),
    ).toHaveProperty("screenPresentation", context);
  });
  it("keeps acknowledgement and model results bounded and free of titles or endpoint references", () => {
    const operationId = randomUUID();
    const done = { type: "client.screen.done", operationId, receipt: { outcome: "applied" } };
    expect(ClientToHostMessageSchema.parse(done)).toEqual(done);
    expect(
      ClientToHostMessageSchema.safeParse({ ...done, endpointRef: "a".repeat(64) }).success,
    ).toBe(false);
    expect(
      ClientToHostMessageSchema.safeParse({
        ...done,
        receipt: { outcome: "applied", title: "Private title" },
      }).success,
    ).toBe(false);
    const request = {
      type: "screen.show",
      requestId: randomUUID(),
      messageId: createId("message"),
      target: { conversationId: createId("thread") },
    };
    expect(AgentControlRequestSchema.parse(request)).toEqual(request);
    const result = {
      type: "screen.show.result",
      requestId: request.requestId,
      receipt: { outcome: "unconfirmed" },
    };
    expect(AgentControlResponseSchema.parse(result)).toEqual(result);
    expect(
      AgentControlResponseSchema.safeParse({ ...result, endpointRef: "a".repeat(64) }).success,
    ).toBe(false);
  });
  it("uses finite monotonic readiness/deadline values and refuses ambiguous native sources", () => {
    const endpointRef = "f".repeat(64);
    expect(
      HostToClientMessageSchema.parse({ type: "host.screen.ready", endpointRef, serverTime: 42 }),
    ).toMatchObject({ serverTime: 42 });
    const show = {
      type: "host.screen.show",
      endpointRef,
      operationId: randomUUID(),
      messageId: createId("message"),
      voiceSessionId: randomUUID(),
      utteranceSequence: 2,
      interactionRevision: 3,
      deadlineAt: 5042,
      target: {
        surface: {
          kind: "app",
          machineId: createId("runner"),
          appKey: "com.example.app",
          source: { kind: "task-session", sessionId: "cus_00000000-0000-4000-8000-000000000001" },
        },
      },
    };
    expect(HostToClientMessageSchema.parse(show)).toEqual(show);
    expect(HostToClientMessageSchema.safeParse({ ...show, deadlineAt: Infinity }).success).toBe(
      false,
    );
    expect(
      HostToClientMessageSchema.safeParse({
        ...show,
        target: {
          surface: { kind: "app", machineId: createId("runner"), appKey: "com.example.app" },
        },
      }).success,
    ).toBe(false);
  });
});
