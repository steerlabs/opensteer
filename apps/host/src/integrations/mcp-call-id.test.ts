import { describe, expect, it } from "vitest";
import { mcpToolCallId } from "./mcp-call-id.js";

describe("mcpToolCallId", () => {
  it("replays only the same protocol call identity", () => {
    const first = mcpToolCallId("run_1", "session_1", 17, "integration_request");

    expect(mcpToolCallId("run_1", "session_1", 17, "integration_request")).toBe(first);
    expect(mcpToolCallId("run_1", "session_1", 18, "integration_request")).not.toBe(first);
    expect(mcpToolCallId("run_1", "session_2", 17, "integration_request")).not.toBe(first);
    expect(mcpToolCallId("run_2", "session_1", 17, "integration_request")).not.toBe(first);
    expect(mcpToolCallId("run_1", "session_1", 17, "browser_access_request")).not.toBe(first);
  });

  it("uses an explicit identity while the MCP session is initializing", () => {
    const initializingCall = mcpToolCallId("run_1", undefined, "call-1", "request_list");
    expect(initializingCall).toBe(mcpToolCallId("run_1", undefined, "call-1", "request_list"));
    expect(initializingCall).toMatch(/^[a-f0-9-]{36}$/);
  });
});
