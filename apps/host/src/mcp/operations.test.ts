import { describe, expect, it } from "vitest";
import type { AgentCaller } from "./agent-caller.js";
import { fingerprint, operationId, toolOperationKey } from "./operations.js";

describe("domain operation identity", () => {
  it("canonicalizes input while excluding only the top-level operationKey", () => {
    const input = { operationKey: "first", b: 2, a: { operationKey: "nested" } };
    expect(fingerprint(input)).toBe(
      fingerprint({ a: { operationKey: "nested" }, b: 2, operationKey: "second" }),
    );
    expect(fingerprint(input)).not.toBe(
      fingerprint({ ...input, a: { operationKey: "different" } }),
    );
  });
  it("honors explicit keys before Watch observation deduplication", () => {
    const watch = { kind: "program", program: { kind: "watch" } } as AgentCaller;
    expect(
      toolOperationKey(watch, { operationKey: "explicit", observationId: "seen" }, "rpc"),
    ).toBe("explicit");
    expect(toolOperationKey(watch, { observationId: "seen" }, "rpc")).toBe("seen");
    expect(toolOperationKey(watch, {}, "rpc")).toBe("rpc");
    expect(toolOperationKey({ kind: "run" } as AgentCaller, { observationId: "seen" }, "rpc")).toBe(
      "rpc",
    );
  });
  it("namespaces a domain key by caller and tool", () => {
    const caller = { kind: "connection", key: "connection:one" } as AgentCaller;
    const key = operationId(caller, "same", "thread_send");
    expect(operationId({ ...caller, key: "connection:two" }, "same", "thread_send")).not.toBe(key);
    expect(operationId(caller, "same", "delegate_task")).not.toBe(key);
  });
});
