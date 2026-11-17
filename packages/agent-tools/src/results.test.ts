import { expect, it } from "vitest";
import { ToolFailureSchema, agentToolFailureResult } from "./results.js";
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
