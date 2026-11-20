import { describe, expect, it } from "vitest";
import { ToolFailureSchema, agentToolFailureResult, normalizeToolError } from "./results.js";

const connection = { tools: new Set(["computer_list"]) };

describe("connection tool refusals", () => {
  it.each([
    ["person-declined", "declined_by_person"],
    ["agent-session-stopped", "stopped_by_person"],
    ["authority-changed", "access_changed"],
    ["work-policy", "organization_not_allowed"],
    ["target-unavailable", "not_found"],
    ["device-access-off", "access_denied"],
    ["device-stopped", "computer_stopped"],
    ["device-asleep", "computer_asleep"],
    ["device-offline", "computer_offline"],
    [undefined, "access_denied"],
  ])("maps %s to %s in both result channels", (reason, code) => {
    const result = agentToolFailureResult(
      { code: "forbidden", message: "Refused.", reason },
      connection,
    );
    expect(result.structuredContent.error.code).toBe(code);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("uses one not_found reply and drops advice for tools the connection cannot use", () => {
    const hidden = normalizeToolError(
      {
        code: "forbidden",
        reason: "target-unavailable",
        message: "That private target exists.",
        next: "Use computer_access_request.",
      },
      connection,
    );
    expect(hidden).toEqual(
      normalizeToolError({ code: "not_found", message: "No such target." }, connection),
    );
    const blocked = {
      code: "forbidden",
      message: "Switch off.",
      reason: "device-access-off",
      computerId: "device",
      capability: "apps" as const,
    };
    expect(normalizeToolError(blocked).next).toContain("computer_access_request");
    expect(normalizeToolError(blocked, connection).next).not.toContain("computer_access_request");
    expect(
      normalizeToolError({ ...blocked, next: "Use computer_list." }, connection).next,
    ).toContain("computer_list");
    expect(normalizeToolError({ ...blocked, reason: "person-declined" }).code).toBe(
      "access_denied",
    );
  });
});

it("normalizes both MCP channels to one ToolError and discards internal control fields", () => {
  const result = agentToolFailureResult({
    code: "forbidden",
    message: "Access denied",
    next: "Use computer_access_request with computerId=rnr_example.",
    computerId: "rnr_example",
    capability: "apps",
    reason: "internal-reason",
    retryable: true,
  });
  const expected = {
    error: {
      code: "access_denied",
      message: "Access denied",
      next: "Use computer_access_request with computerId=rnr_example.",
    },
  };
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify(expected) }],
    structuredContent: expected,
    isError: true,
  });
  expect(ToolFailureSchema.parse(result.structuredContent)).toEqual(expected);
  expect(
    agentToolFailureResult({
      code: "outcome_unknown",
      message: "Observe before repeating.",
      retryable: true,
    }).structuredContent.error.next,
  ).toBeNull();
});
