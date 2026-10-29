/**
 * What a provider said about one message.
 *
 * `delivered` means Apple or Google accepted it for delivery. It is never
 * evidence that a person saw anything: no provider reports that, and treating
 * acceptance as "seen" would silently suppress the next notification.
 */
export type PushDeliveryResult =
  | { readonly outcome: string; readonly status: "delivered" }
  /** The token is dead. The registration ends with it. */
  | { readonly outcome: string; readonly status: "unregistered" }
  /** The provider refused this message and will refuse it again. */
  | { readonly outcome: string; readonly status: "rejected" }
  /** A transient failure worth another attempt inside the freshness window. */
  | { readonly outcome: string; readonly status: "retry" };
