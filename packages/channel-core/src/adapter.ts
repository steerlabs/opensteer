import type {
  ChannelConnectionInspection,
  ChannelConnectionIssue,
  ChannelDelivery,
  ChannelProviderManifest,
  ChannelTransportKind,
  NormalizedChannelEvent,
} from "./models.js";

export class ChannelConnectionError extends Error {
  readonly issue: ChannelConnectionIssue;
  readonly retryable: boolean;

  constructor(
    issue: ChannelConnectionIssue,
    options: ErrorOptions & { readonly retryable?: boolean } = {},
  ) {
    super(issue.message, options);
    this.name = "ChannelConnectionError";
    this.issue = issue;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * How a send failed, from the provider's point of view. `retryable` means the
 * provider refused and will accept later (rate limits, outages); `dead` means
 * it refused for good (a channel the bot is not in, bad credentials);
 * `unknown` means the answer never arrived, so the message may or may not
 * exist and only `reconcile` can say.
 */
export class ChannelDeliveryError extends Error {
  readonly kind: "dead" | "retryable" | "unknown";
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    kind: "dead" | "retryable" | "unknown",
    options: ErrorOptions & { readonly retryAfterSeconds?: number | null } = {},
  ) {
    super(message, options);
    this.name = "ChannelDeliveryError";
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/**
 * The secrets one adapter call may use. There is no expiry on it: the fences
 * that matter are purpose scoping — the lease carries only the fields the
 * manifest marks for the job at hand — and `credentialGeneration`, which
 * restarts the adapter session when the secrets behind it are rotated.
 */
export interface ChannelCredentialLease {
  readonly accountId: string;
  /** The provider account the connection was set up with. */
  readonly externalAccountId: string;
  readonly secrets: Readonly<Record<string, string>>;
}

/** Where one delivery goes, as the provider names it. */
export interface ChannelDeliveryDestination {
  readonly externalConversationId: string;
  readonly externalScopeId: string | null;
  readonly externalThreadId: string | null;
  /** The person an `actor`-audience delivery is for; null for a conversation. */
  readonly externalUserId: string | null;
}

interface ChannelOutboundAdapter {
  /**
   * Decide whether a delivery whose outcome was lost actually reached the
   * provider. `sent` carries the receipt the send would have returned;
   * `unknown` means the adapter cannot tell and the delivery is sent again.
   */
  reconcile(input: {
    readonly delivery: ChannelDelivery;
    readonly destination: ChannelDeliveryDestination;
    readonly lease: ChannelCredentialLease;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: "sent"; readonly receipt: Readonly<Record<string, unknown>> }
    | { readonly kind: "unknown" }
  >;
  /**
   * Post one delivery as exactly one provider message. The content is already
   * within `manifest.maxMessageChars`; the adapter renders it into the
   * provider's own markup. Failures are thrown as `ChannelDeliveryError`.
   */
  send(input: {
    readonly delivery: ChannelDelivery;
    readonly destination: ChannelDeliveryDestination;
    readonly lease: ChannelCredentialLease;
    readonly signal: AbortSignal;
  }): Promise<{ readonly receipt: Readonly<Record<string, unknown>> }>;
}

interface ChannelConnectionAdapter {
  inspect(input: {
    readonly credentials: Readonly<Record<string, string>>;
    readonly transportKind: ChannelTransportKind;
  }): Promise<ChannelConnectionInspection>;
  /**
   * Hold the provider transport open until `signal` aborts, handing every
   * message the bot should act on to `onEvent` exactly once per provider
   * message. `onEvent` resolves once the Host has durably recorded the event;
   * it rejects when the Host could not, and the adapter must then leave the
   * provider's copy unacknowledged so the provider redelivers, without
   * dropping the transport. A resolved promise is the only acknowledgement.
   *
   * `onReady` is what makes the connection `connected`, and it is the
   * adapter's to call once the transport is actually carrying messages. An
   * adapter that never calls it never becomes `connected`, and nothing is ever
   * delivered through it — the Host only claims deliveries for a connected
   * connection — so a transport that is up but silent about it is the same as
   * one that never opened.
   */
  run(input: {
    /** This channel account: the key an adapter keeps any position of its own under. */
    readonly accountId: string;
    readonly credentials: Readonly<Record<string, string>>;
    readonly expectedAccountExternalId: string;
    /**
     * Where a transport that reads a history begins, as its own `inspect`
     * described it at setup; null once the connection has been connected,
     * when a position the adapter lost is not a fresh start.
     */
    readonly initialCursor: string | null;
    readonly onEvent: (event: NormalizedChannelEvent) => Promise<void>;
    readonly onReady: () => Promise<void>;
    readonly signal: AbortSignal;
    readonly transportKind: ChannelTransportKind;
  }): Promise<void>;
}

/**
 * Everything provider-specific lives behind this: the transport, the
 * provider's message shape, its markup, and its delivery receipts. The Host
 * and the messaging service are provider-agnostic; adding a provider is a
 * package that exports one of these plus a manifest in `catalog.ts`.
 */
export interface ChannelAdapter {
  readonly connection: ChannelConnectionAdapter;
  readonly manifest: ChannelProviderManifest;
  readonly outbound: ChannelOutboundAdapter;
}
