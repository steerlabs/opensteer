import { expect, it } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { HostTransportError } from "../connections/host-transport-error.js";
import { ClientOperationError } from "../connections/operation-error.js";
import { HostClientRequestError } from "./client.js";
import { failureNotice, hostUnanswered, operationFailure } from "./operation-failure.js";

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
  ["a service outage", new ClientOperationError("Account is down.", "transient"), "unavailable"],
])("%s reads as %s", (_name, error, expected) => {
  expect(operationFailure(error)).toBe(expected);
});

it("says offline only when the device itself is offline", () => {
  expect(failureNotice("unavailable", "offline").tone).toBe("offline");
  expect(failureNotice("unavailable", "online").tone).toBe("unreachable");
  expect(failureNotice("unavailable", "unknown").tone).toBe("unreachable");
  // A refusal that arrived proves the answer came back, whatever the device reports.
  expect(failureNotice("gone", "offline").tone).toBe("gone");
  expect(failureNotice("failed", "offline").tone).toBe("failed");
});

it("tells a Host that answered from one that never did", () => {
  expect(hostUnanswered(refused("internal", 500, { reason: "transport-unreachable" }))).toBe(true);
  expect(hostUnanswered(new HostTransportError("timed-out"))).toBe(true);
  // A Host that says something it depends on is offline has itself answered.
  expect(hostUnanswered(refused("runner_offline", 503, { retryable: true }))).toBe(false);
  expect(hostUnanswered(new HostTransportError("deployment-changed"))).toBe(false);
  expect(hostUnanswered(new TypeError("Failed to fetch"))).toBe(false);
});
