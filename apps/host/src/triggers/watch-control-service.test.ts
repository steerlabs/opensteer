import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requestFingerprintForToolContract, requestForToolContract } from "./tool-contract.js";

describe("WatchControlService tool contracts", () => {
  it("normalizes both version 1 message delivery values before current parsing", () => {
    expect(
      requestForToolContract(1, { delivery: "trigger", type: "thread.message" }),
    ).toMatchObject({
      delivery: "queue",
    });
    expect(requestForToolContract(1, { delivery: "queue", type: "thread.message" })).toMatchObject({
      delivery: "report",
    });
  });

  it("leaves version 2 calls strict and unchanged", () => {
    const input = { delivery: "trigger", type: "thread.message" };
    expect(requestForToolContract(2, input)).toBe(input);
  });

  it("preserves the version 1 durable request representation after translation", () => {
    const current = {
      content: [{ text: "status", type: "text" }],
      delivery: "report",
      observationId: "stable",
      requestId: "request",
      threadId: "thr_legacy",
      type: "thread.message",
    };
    expect(requestFingerprintForToolContract(1, current)).toEqual({
      ...current,
      delivery: "queue",
    });
    expect(requestFingerprintForToolContract(2, current)).toBe(current);

    const legacy = { ...current, delivery: "queue" };
    const { requestId: _oldRequestId, ...oldFingerprint } = legacy;
    const { requestId: _newRequestId, ...newFingerprint } = requestFingerprintForToolContract(
      1,
      current,
    ) as typeof legacy;
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    expect(hash(newFingerprint)).toBe(hash(oldFingerprint));
  });
});
