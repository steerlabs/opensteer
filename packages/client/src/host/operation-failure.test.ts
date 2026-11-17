import { expect, it } from "vitest";
import { OpensteerError } from "@opensteer/core";
import { HostTransportError } from "../connections/host-transport-error.js";
import { ClientOperationError } from "../connections/operation-error.js";
import { HostClientRequestError } from "./client.js";
import { failureNotice, operationFailure } from "./operation-failure.js";

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
  ["a Host failure it says may pass", refused("internal", 500, { retryable: true }), "unavailable"],
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
