import { ZodError } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerId } from "@opensteer/control-plane-protocol";

/** What settling a deleted Cloud Computer with Stripe can be stuck on; see `#settleDeletion`. */
export type CloudComputerDeletionStep = "cancel" | "customer" | "record";

/** A deleted Cloud Computer still unsettled with Stripe an hour after its request. */
export class CloudComputerDeletionUnsettled extends Error {
  readonly computerId: CloudComputerId;
  readonly step: CloudComputerDeletionStep;

  constructor(
    computerId: CloudComputerId,
    step: CloudComputerDeletionStep,
    options?: { cause?: unknown },
  ) {
    super("A deleted Cloud Computer is not settled with Stripe an hour after its request", options);
    this.name = "CloudComputerDeletionUnsettled";
    this.computerId = computerId;
    this.step = step;
  }
}

/**
 * A deleted Cloud Computer whose subscription was not cancelled at the first attempt: cancelled
 * `waitedMs` after its deletion was requested. A renewal charged in that time is refunded by hand.
 */
export class CloudComputerCancelledLate extends Error {
  readonly computerId: CloudComputerId;
  readonly waitedMs: number;

  constructor(computerId: CloudComputerId, waitedMs: number) {
    super("A deleted Cloud Computer's subscription was cancelled late; check for a renewal");
    this.name = "CloudComputerCancelledLate";
    this.computerId = computerId;
    this.waitedMs = waitedMs;
  }
}

// Provider responses and database errors can carry secrets in their messages, causes and stacks.
const safeMessages = new Set([
  "Cloud Computer billing portal allows unsupported changes",
  "Paid Stripe Checkout has no invoice",
  "Stripe billing is temporarily unavailable",
  "Stripe Checkout payment is not refundable by the Account",
  "Stripe Checkout payments could not be established",
  "Stripe did not delete the customer",
  "Stripe Checkout refunds could not be established",
  "The subscription is not cancelled yet",
  "Stripe did not confirm Checkout expiry",
  "The configured Stripe price does not match the Cloud Computer offer",
]);

/** The stable event a billing failure is logged as (apps/control-plane/src/server/events.ts). */
export function billingEvent(
  error: unknown,
):
  | "account.billing.cancelled_late"
  | "account.billing.deletion_unsettled"
  | "account.billing.failed" {
  if (error instanceof CloudComputerCancelledLate) return "account.billing.cancelled_late";
  if (error instanceof CloudComputerDeletionUnsettled) return "account.billing.deletion_unsettled";
  return "account.billing.failed";
}

export function billingErrorDetails(error: unknown): Record<string, unknown> {
  // A deleted Cloud Computer names its row, so an operator can see it through.
  if (error instanceof CloudComputerCancelledLate)
    return {
      type: error.name,
      message: error.message,
      computerId: error.computerId,
      waitedMs: error.waitedMs,
    };
  if (error instanceof CloudComputerDeletionUnsettled)
    return {
      type: error.name,
      message: error.message,
      computerId: error.computerId,
      step: error.step,
      ...(error.cause === undefined ? {} : { cause: billingErrorDetails(error.cause) }),
    };
  if (error instanceof ControlPlaneError) {
    return {
      type: "ControlPlaneError",
      code: error.code,
      status: error.status,
      message: safeMessages.has(error.message) ? error.message : "Account billing request failed",
    };
  }
  if (error instanceof ZodError) return { type: "ZodError", message: "Invalid billing data" };
  if (error instanceof TypeError) return { type: "TypeError", message: "Billing operation failed" };
  return { type: "Error", message: "Billing operation failed" };
}
