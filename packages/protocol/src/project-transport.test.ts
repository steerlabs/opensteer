import { createId, ProjectEngineRequestEventSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  ProjectHostToRunnerMessageSchema,
  ProjectProgramCapabilityClaimsSchema,
  ProjectRunnerToHostMessageSchema,
} from "./project-transport.js";
import {
  HostToRunnerMessageSchema,
  PendingAgentEventSchema,
  RunnerToHostMessageSchema,
} from "./runner.js";

const runnerId = createId("runner");
const bootId = "rbt_00000000-0000-4000-8000-000000000001";
const workspaceId = createId("workspace");
const authority = {
  version: 1,
  principal: { kind: "project", workspaceId, principalId: "project:test" },
  origin: null,
};
const run = {
  kind: "run",
  authority,
  bindingGeneration: 1,
  environmentId: createId("environment"),
  grantId: createId("grant"),
  runId: createId("run"),
  runnerBootId: bootId,
  runnerId,
  threadId: createId("thread"),
  workspaceId,
};
const fence = {
  runnerId,
  bootId,
  connectionGeneration: 1,
  connectionId: "rcn_00000000-0000-4000-8000-000000000002",
  connectionLeaseId: "rls_00000000-0000-4000-8000-000000000003",
};
const trigger = {
  authority,
  environmentId: run.environmentId,
  runnerId,
  runnerBootId: bootId,
  workspaceId,
  anchorThreadId: run.threadId,
  triggerId: createId("trigger"),
  revisionId: createId("triggerRevision"),
  executionGeneration: 1,
  kind: "trigger",
  occurrenceId: createId("triggerOccurrence"),
};
const watch = {
  ...trigger,
  kind: "watch",
  occurrenceId: undefined,
  activationId: createId("triggerWatchActivation"),
};
const { kind: _kind, ...runBinding } = run;
const proposal = {
  type: "request.proposed.project",
  binding: runBinding,
  data: {
    request: {
      id: createId("request"),
      callId: "call",
      createdAt: "2026-11-10T00:00:00.000Z",
      kind: "harness.input",
      mode: "live",
      requestClass: "question",
      payload: { kind: "harness.input" },
      presentation: {
        kind: "choice",
        title: "Choose",
        options: [{ id: "yes", hint: "confirm", label: "Yes" }],
      },
    },
  },
};

describe("dormant binding-aware Project transport", () => {
  it("separates Project events from both the legacy event and transport unions", () => {
    expect(ProjectEngineRequestEventSchema.safeParse(proposal).success).toBe(true);
    const event = { ...proposal, ordinal: 0, emittedAt: "2026-11-10T00:00:00.000Z" };
    const frame = { ...fence, type: "runner.project.event", event };
    expect(ProjectRunnerToHostMessageSchema.parse(frame)).toEqual(frame);
    expect(RunnerToHostMessageSchema.safeParse(frame).success).toBe(false);
    const live = {
      ...fence,
      type: "runner.project.live",
      binding: runBinding,
      progress: {
        runId: run.runId,
        threadId: run.threadId,
        workspaceId,
        items: [{ stream: "assistant", op: "append", at: 0, text: "text" }],
      },
    };
    expect(ProjectRunnerToHostMessageSchema.parse(live)).toEqual(live);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({
        ...live,
        progress: { ...live.progress, workspaceId: createId("workspace") },
      }).success,
    ).toBe(false);
    expect(PendingAgentEventSchema.safeParse(event).success).toBe(false);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({
        ...frame,
        event: { ...event, type: "request.opened" },
      }).success,
    ).toBe(false);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({
        ...frame,
        event: { ...event, binding: { ...runBinding, runnerBootId: "stale" } },
      }).success,
    ).toBe(false);
  });
  it("requires exact incarnation addresses on refresh, attach, acknowledgement and renewal", () => {
    const frames = [
      { ...fence, type: "runner.project.grants.refresh", requestId: "request", binding: run },
      {
        ...fence,
        type: "runner.project.executions.attach",
        complete: true,
        executions: [{ binding: run, nextOrdinal: 1, terminal: false }],
      },
      {
        ...fence,
        type: "runner.project.heartbeat",
        sentAt: "2026-11-10T00:00:00.000Z",
        bindings: [run],
      },
    ];
    for (const frame of frames)
      expect(ProjectRunnerToHostMessageSchema.safeParse(frame).success).toBe(true);
    const ack = {
      ...fence,
      type: "host.project.events.acked",
      acks: [{ binding: run, sessionBound: true, throughOrdinal: 2 }],
    };
    const renewed = {
      ...fence,
      type: "host.project.executions.renewed",
      bindings: [run],
      heartbeatSentAt: "2026-11-10T00:00:00.000Z",
      leaseMs: 90_000,
    };
    expect(ProjectHostToRunnerMessageSchema.parse(ack)).toEqual(ack);
    expect(ProjectHostToRunnerMessageSchema.parse(renewed)).toEqual(renewed);
    expect(HostToRunnerMessageSchema.safeParse(ack).success).toBe(false);
    for (const missing of ["grantId", "bindingGeneration", "runnerBootId", "authority"])
      expect(
        ProjectHostToRunnerMessageSchema.safeParse({
          ...ack,
          acks: [{ ...ack.acks[0], binding: { ...run, [missing]: undefined } }],
        }).success,
      ).toBe(false);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({
        ...renewed,
        bindings: undefined,
        runIds: [run.runId],
      }).success,
    ).toBe(false);
  });
  it("addresses Request answers and durable refusals to the exact execution", () => {
    const commandId = createId("command");
    const control = {
      ...fence,
      commandId,
      correlationId: "answer",
      type: "host.project.run-control",
      binding: runBinding,
      control: {
        kind: "request.resolve",
        requestId: proposal.data.request.id,
        response: { kind: "choice", optionId: "yes" },
      },
    };
    expect(ProjectHostToRunnerMessageSchema.parse(control)).toEqual(control);
    expect(HostToRunnerMessageSchema.safeParse(control).success).toBe(false);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({
        ...control,
        control: { kind: "node.stop", nodeId: createId("executionNode") },
      }).success,
    ).toBe(false);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({
        ...control,
        binding: { ...runBinding, runnerBootId: "stale" },
      }).success,
    ).toBe(false);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({
        ...control,
        control: { ...control.control, requestedBy: createId("user") },
      }).success,
    ).toBe(false);
    const refused = {
      ...fence,
      commandId,
      correlationId: "refusal",
      type: "host.project.run-control",
      binding: runBinding,
      control: {
        kind: "request.refuse",
        requestId: proposal.data.request.id,
        callId: "call",
        reason: "no-eligible-manager",
      },
    };
    expect(ProjectHostToRunnerMessageSchema.parse(refused)).toEqual(refused);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({ ...refused, commandId: undefined }).success,
    ).toBe(false);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({
        ...fence,
        commandId,
        correlationId: "answer",
        type: "runner.project.control-result",
        binding: runBinding,
        result: { status: "accepted" },
      }).success,
    ).toBe(true);
  });

  it("binds program audiences to source type/incarnation and refuses user credentials", () => {
    const output = {
      completedAt: "2026-11-10T00:00:00.000Z",
      error: null,
      exitCode: 0,
      occurrenceId: trigger.occurrenceId,
      result: null,
      status: "succeeded",
      stderr: "",
      stdout: "",
    };
    const result = {
      ...fence,
      type: "runner.project.trigger-result",
      binding: trigger,
      ordinal: 0,
      emittedAt: "2026-11-10T00:00:00.000Z",
      output,
    };
    expect(ProjectRunnerToHostMessageSchema.parse(result)).toEqual(result);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({
        ...result,
        output: { ...output, occurrenceId: createId("triggerOccurrence") },
      }).success,
    ).toBe(false);
    expect(
      ProjectRunnerToHostMessageSchema.safeParse({ ...result, ordinal: undefined }).success,
    ).toBe(false);
    const claims = {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      exp: 100,
      iat: 1,
      iss: "opensteer-host",
      jti: "00000000-0000-4000-8000-000000000004",
    };
    expect(
      ProjectProgramCapabilityClaimsSchema.safeParse({
        ...trigger,
        ...claims,
        aud: "opensteer-project-trigger-control",
      }).success,
    ).toBe(true);
    const { occurrenceId: _occurrence, ...watchBinding } = watch;
    expect(
      ProjectProgramCapabilityClaimsSchema.safeParse({
        ...watchBinding,
        ...claims,
        aud: "opensteer-project-watch-control",
      }).success,
    ).toBe(true);
    for (const changed of [
      { aud: "opensteer-trigger-control" },
      { aud: "opensteer-project-watch-control" },
      { createdBy: createId("user") },
      { membershipGeneration: 1 },
      { executionGeneration: 0 },
      { workspaceId: createId("workspace") },
    ])
      expect(
        ProjectProgramCapabilityClaimsSchema.safeParse({
          ...trigger,
          ...claims,
          aud: "opensteer-project-trigger-control",
          ...changed,
        }).success,
      ).toBe(false);
    const frame = {
      ...fence,
      type: "host.project.grants.credentials",
      requestId: "request",
      binding: trigger,
      result: {
        status: "issued",
        credentials: { kind: "run", agentTools: "token", egress: "token" },
      },
    };
    expect(ProjectHostToRunnerMessageSchema.safeParse(frame).success).toBe(false);
    expect(
      ProjectHostToRunnerMessageSchema.safeParse({
        ...fence,
        type: "host.project.events.acked",
        acks: [{ binding: trigger, sessionBound: true, throughOrdinal: 0 }],
      }).success,
    ).toBe(false);
  });
});
