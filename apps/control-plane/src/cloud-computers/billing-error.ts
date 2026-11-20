import { ZodError } from "zod";
import { ControlPlaneError } from "../server/errors.js";

// Provider responses and database errors can carry secrets in their messages, causes and stacks.
const safeMessages = new Set([
  "Cloud Computer billing portal allows unsupported changes",
  "Paid Stripe Checkout has no invoice",
  "Stripe billing is temporarily unavailable",
  "Stripe Checkout payment is not refundable by the Account",
  "Stripe Checkout payments could not be established",
  "Stripe Checkout refunds could not be established",
  "Stripe did not confirm Checkout expiry",
  "The configured Stripe price does not match the Cloud Computer offer",
]);

export function billingErrorDetails(error: unknown) {
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
