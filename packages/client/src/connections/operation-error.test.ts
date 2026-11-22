import { OpensteerError } from "@opensteer/core";
import { HostClientRequestError, isHostRefusal } from "../host/client.js";
import { describe, expect, it } from "vitest";
import {
  classifyClientFailure,
  clientEndpointUnavailable,
  hostUnanswered,
  isMissingClientResource,
} from "./operation-error.js";
import { HostTransportError } from "./host-transport-error.js";
import { unwrapRpcResult } from "../host/host-session-client.js";

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
      for (const unwrap of [unwrapRpcResult]) {
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

const refused = (
  code: string,
  status: number,
  extra: { reason?: string; retryable?: boolean } = {},
) => new HostClientRequestError({ code, message: "Refused.", status, ...extra });

it.each([
  ["a local TypeError", new TypeError("Cannot read properties of undefined"), "failed"],
  ["a plain Error", new Error("Unexpected result."), "failed"],
  [
    "no answer arriving",
    refused("internal", 500, { reason: "transport-unreachable", retryable: true }),
    "unavailable",
  ],
  [
    "an answer that couldn't be read",
    refused("internal", 500, { reason: "invalid-response", retryable: false }),
    "failed",
  ],
  ["a Host refusal it says won't change", refused("conflict", 409, { retryable: false }), "failed"],
  [
    "no answer, as a team session reports it",
    new OpensteerError({
      code: "internal",
      message: "The Host could not be reached.",
      reason: "transport-unreachable",
      retryable: true,
    }),
    "unavailable",
  ],
  [
    "no answer in time",
    refused("internal", 500, { reason: "transport-timed-out", retryable: true }),
    "unavailable",
  ],
  // The Host answered, so it was reached; its "try again" is a failure to retry, not an outage.
  ["a Host failure it says may pass", refused("internal", 500, { retryable: true }), "failed"],
  ["a Host that is busy", refused("resource_exhausted", 429, { retryable: true }), "failed"],
  ["the Runner being offline", refused("runner_offline", 503), "unavailable"],
  ["a missing thing", refused("not_found", 404), "gone"],
  ["a forbidden thing", new OpensteerError({ code: "forbidden", message: "No." }), "gone"],
  [
    "a method an older Host lacks",
    refused("not_found", 404, { reason: "unknown-method" }),
    "failed",
  ],
  ["a signed-out reader", refused("unauthorized", 401), "signed-out"],
  ["a transport deadline", new HostTransportError("timed-out"), "unavailable"],
  ["a transport with no route", new HostTransportError("unreachable"), "unavailable"],
  ["a transport refusal", new HostTransportError("response-too-large"), "failed"],
])("%s reads as %s", (_name, error, expected) => {
  const failure = classifyClientFailure(error);
  expect(isMissingClientResource(failure)).toBe(expected === "gone");
  expect(clientEndpointUnavailable(failure)).toBe(expected === "unavailable");
  expect(failure.code === "unauthorized").toBe(expected === "signed-out");
});

it("tells a Host that answered from one that never did", () => {
  const unanswered = (error: unknown) => hostUnanswered(classifyClientFailure(error));
  expect(unanswered(refused("internal", 500, { reason: "transport-unreachable" }))).toBe(true);
  expect(unanswered(new HostTransportError("timed-out"))).toBe(true);
  // A Host that says something it depends on is offline has itself answered.
  expect(unanswered(refused("runner_offline", 503, { retryable: true }))).toBe(false);
  expect(unanswered(new HostTransportError("deployment-changed"))).toBe(false);
  expect(unanswered(new TypeError("Failed to fetch"))).toBe(false);
});

it("distinguishes confirmed refusal from an unknown commit outcome", () => {
  expect(
    isHostRefusal(
      new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "Revision changed",
      }),
    ),
  ).toBe(true);
  expect(isHostRefusal(new Error("Lost response"))).toBe(false);
  expect(
    isHostRefusal(
      new HostClientRequestError({
        code: "internal",
        status: 500,
        message: "Unavailable",
      }),
    ),
  ).toBe(false);
});
