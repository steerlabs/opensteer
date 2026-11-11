import { createId, type Thread } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { ConnectionCaller } from "./agent-caller.js";
import { toolAccess } from "./tool-access.js";

function authority() {
  const caller: ConnectionCaller = {
    kind: "connection",
    key: "connection:test",
    connectionId: "test",
    userId: createId("user"),
    accessMode: "auto",
  };
  const target = {
    lineageRootThreadId: createId("thread"),
    accessMode: "full-access",
  } as Thread;
  return { caller, target };
}
describe("MCP access kinds", () => {
  it.each(["write"] as const)("refuses access-mode escalation for %s", (kind) => {
    const { caller, target } = authority();
    expect(() => toolAccess[kind](caller, [target])).toThrow("stronger access mode");
  });
  it("permits reads of a stronger Thread and requires full access for settings", () => {
    const { caller, target } = authority();
    expect(() => toolAccess.read(caller, [target])).not.toThrow();
    expect(() => toolAccess.settings(caller, [])).toThrow("requires full-access");
    expect(() =>
      toolAccess.settings({ ...caller, accessMode: "full-access" }, [target]),
    ).not.toThrow();
  });
});
