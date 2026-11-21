import { ZodError } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerId } from "@opensteer/control-plane-protocol";

/** What settling a deleted Cloud Computer with Stripe can be stuck on; see `#settleDeletion`. */
export type CloudComputerDeletionStep = "cancel" | "refund" | "checkout" | "customer";

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

// Provider responses and database errors can carry secrets in their messages, causes and stacks.
const safeMessages = new Set([
  "Cloud Computer billing portal allows unsupported changes",
  "Paid Stripe Checkout has no invoice",
  "Stripe billing is temporarily unavailable",
  "Stripe Checkout payment is not refundable by the Account",
  "Stripe Checkout payments could not be established",
  "Stripe did not delete the customer",
  "Stripe pagination was incomplete",
  "Stripe returned another charge",
  "Stripe returned another payment",
  "Stripe did not confirm Checkout expiry",
  "The configured Stripe price does not match the Cloud Computer offer",
]);

export function billingErrorDetails(error: unknown): Record<string, unknown> {
  // The row and the step it is stuck on, so an operator can see it through.
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
