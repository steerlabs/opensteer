import { describe, expect, it } from "vitest";
import { classifyClientFailure } from "./operation-error.js";
import { HostTransportError } from "./host-transport-error.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { teamRpcResult } from "../team/rpc-result.js";

describe("observed client failures", () => {
  it("keeps an RPC failure's provenance and retryability through both unwrap paths", () => {
    const cases = [
      {
        reason: "transport-timed-out",
        retryable: true,
        kind: "transport",
        provenance: "transport",
      },
      { reason: "proxy-unavailable", retryable: true, kind: "service", provenance: "proxy" },
      { reason: "invalid-response", retryable: false, kind: "protocol", provenance: "protocol" },
      { reason: "permission-denied", retryable: false, kind: "rejection", provenance: "host" },
    ] as const;
    for (const sample of cases) {
      const result = {
        ok: false,
        error: {
          code: "forbidden",
          message: "Private internals",
          reason: sample.reason,
          retryable: sample.retryable,
        },
      } as const;
      for (const unwrap of [unwrapRpcResult, teamRpcResult]) {
        let failure: unknown;
        try {
          unwrap(result);
        } catch (error) {
          failure = error;
        }
        expect(classifyClientFailure(failure)).toMatchObject(sample);
      }
    }
  });
  it("does not infer transport failure from an arbitrary programming TypeError", () => {
    expect(classifyClientFailure(new TypeError("undefined field"))).toMatchObject({
      kind: "unexpected",
      retryable: false,
    });
    expect(classifyClientFailure(new HostTransportError("cancelled"))).toMatchObject({
      kind: "cancelled",
      retryable: false,
    });
    expect(classifyClientFailure(new HostTransportError("timed-out"))).toMatchObject({
      kind: "transport",
      retryable: true,
    });
  });
});
