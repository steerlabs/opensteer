import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import {
  HarnessExecutionAuthoritySchema,
  ProjectEngineRequestEventSchema,
  ProjectEngineRequestSchema,
} from "./project-engine.js";
import { PendingRequestSchema } from "./requests.js";
import { projectRequestAudience } from "./project-request-audience.js";

const workspaceId = createId("workspace");
const binding = {
  authority: {
    version: 1,
    principal: { kind: "project", workspaceId, principalId: "project:test" },
    origin: null,
  },
  bindingGeneration: 1,
  environmentId: createId("environment"),
  grantId: createId("grant"),
  runId: createId("run"),
  runnerBootId: "boot",
  runnerId: createId("runner"),
  threadId: createId("thread"),
  workspaceId,
};
const request = {
  id: createId("request"),
  callId: "provider-call",
  createdAt: "2026-11-10T00:00:00.000Z",
  mode: "live",
  kind: "harness.input",
  requestClass: "question",
  payload: { kind: "harness.input" },
  presentation: {
    kind: "choice",
    title: "Choose",
    options: [{ id: "yes", hint: "confirm", label: "Yes" }],
  },
};
describe("Project engine authority and Request proposals", () => {
  it("requires exact Project binding without substituting a human root", () => {
    expect(HarnessExecutionAuthoritySchema.parse({ kind: "project", binding })).toEqual({
      kind: "project",
      binding,
    });
    expect(
      HarnessExecutionAuthoritySchema.safeParse({
        kind: "project",
        binding,
        requestedBy: createId("user"),
      }).success,
    ).toBe(false);
    expect(
      HarnessExecutionAuthoritySchema.safeParse({
        kind: "person",
        requestedBy: createId("user"),
        binding,
      }).success,
    ).toBe(false);
    expect(
      HarnessExecutionAuthoritySchema.safeParse({
        kind: "project",
        binding: { ...binding, grantId: undefined },
      }).success,
    ).toBe(false);
  });
  it("permits questions/approvals but forbids audience choice and private Request classes", () => {
    const event = { type: "request.proposed.project", binding, data: { request } };
    expect(ProjectEngineRequestEventSchema.parse(event)).toEqual(event);
    expect(PendingRequestSchema.safeParse(request).success).toBe(false);
    expect(
      ProjectEngineRequestSchema.safeParse({
        ...request,
        kind: "harness.approval",
        requestClass: "harness-approval",
        payload: { kind: "harness.approval" },
      }).success,
    ).toBe(true);
    for (const extra of [
      { requestedBy: createId("user") },
      { requestedBy: null },
      { requiredActor: "workspace-owner" },
      { targetWorkspaceId: createId("workspace") },
      { requestClass: "harness-approval" },
      { payload: { kind: "harness.approval" } },
      {
        presentation: {
          kind: "external",
          title: "Sign in",
          subject: { id: "private", kind: "browser" },
        },
      },
    ])
      expect(ProjectEngineRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    for (const kind of [
      "browser.access",
      "browser.sign-in",
      "integration.input",
      "computer.app.access",
      "machine.full-disk-access",
      "phone.access",
    ])
      expect(
        ProjectEngineRequestSchema.safeParse({ ...request, kind, payload: { kind } }).success,
      ).toBe(false);
    expect(
      projectRequestAudience({ origin: null, requestClass: "question", eligibleManagerCount: 0 }),
    ).toEqual({ state: "refused", reason: "no-eligible-manager" });
  });
});
