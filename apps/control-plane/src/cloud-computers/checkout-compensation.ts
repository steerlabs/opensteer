import type { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import { billingStatus, type StripeBilling, type StripePaidCheckoutSchema } from "./stripe.js";

export async function cancelAndRefundCheckout(
  stripe: Pick<StripeBilling, "subscription" | "cancel" | "refundCheckout">,
  payment: z.infer<typeof StripePaidCheckoutSchema>,
): Promise<boolean> {
  const subscription = await stripe.subscription(payment.subscription);
  if (
    subscription.id !== payment.subscription ||
    subscription.customer !== payment.customer ||
    subscription.metadata["account_id"] !== payment.metadata.account_id ||
    subscription.metadata["request_id"] !== payment.metadata.request_id
  )
    throw new ControlPlaneError("unavailable", "Stripe returned another subscription");
  if (billingStatus(subscription) !== "canceled") await stripe.cancel(subscription.id);
  return stripe.refundCheckout(payment);
}
