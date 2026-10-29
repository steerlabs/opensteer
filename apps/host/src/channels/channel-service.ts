import { safeMessage } from "@opensteer/shared/safeMessage";
import { sha256Base64Url } from "@opensteer/core/crypto";
import {
  ChannelAccountIdSchema,
  ChannelAccessPolicySchema,
  type ChannelAccessPolicy,
  ChannelBindingIdSchema,
  ChannelDeliveryIdSchema,
  ChannelProviderSchema,
  IntegrationConnectionIdSchema,
  channelProviderCatalog,
  normalizePersonalAddress,
  type ChannelDashboard,
  type ChannelProvider,
  type ChannelConnectionInspection,
  type ChannelProviderManifest,
} from "@opensteer/channel-core";
import {
  ChannelStore,
  ChannelIngressDeferredError,
  type ChannelIngressNotices,
  type OpensteerStore,
} from "@opensteer/database";
import {
  OpensteerError,
  isLoopbackHostname,
  RunnerIdSchema,
  WorkspaceIdSchema,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  ClaimChannelDeliveryResultSchema,
  CommitChannelIngressResultSchema,
  InspectChannelConnectionResponseSchema,
  type ChannelCredentialPurpose,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import type { MessagingRelayHub } from "./messaging-relay-hub.js";
import type { CredentialService } from "../identity/credential-service.js";

interface ChannelServiceOptions {
  /** Where a person signs in to redeem a link code. */
  readonly canonicalOrigin: string;
  readonly credentials: CredentialService;
  /** Named because an adopted channel message makes one work location dispatchable. */
  readonly onExecutionQueued: (environmentId: EnvironmentId) => void;
  readonly onWorkspaceEvent: (event: AgentEvent) => void;
  readonly relay: MessagingRelayHub;
  readonly runners: RunnerRegistry;
  readonly store: OpensteerStore;
  readonly channels: ChannelStore;
}

export class ChannelService {
  readonly #canonicalOrigin: string;
  readonly #channels: ChannelStore;
  readonly #credentials: CredentialService;
  readonly #onExecutionQueued: (environmentId: EnvironmentId) => void;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #relay: MessagingRelayHub;
  readonly #runners: RunnerRegistry;
  readonly #store: OpensteerStore;
  #closed = false;
  #draining: Promise<void> | null = null;
  #wakeAgain = false;
  #ticks = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ChannelServiceOptions) {
    this.#canonicalOrigin = options.canonicalOrigin;
    this.#channels = options.channels;
    this.#credentials = options.credentials;
    this.#onExecutionQueued = options.onExecutionQueued;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#relay = options.relay;
    this.#runners = options.runners;
    this.#store = options.store;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 1_000);
    this.#timer.unref();
    this.wake();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#draining;
  }

  #tick(): void {
    this.#ticks += 1;
    // Retention is bookkeeping, not work anybody waits on, so it rides the
    // drain timer rather than owning a timer of its own.
    if (this.#ticks % 3_600 === 0) {
      void this.#channels.pruneHistory(new Date()).catch(() => undefined);
    }
    this.wake();
  }

  wake(): void {
    if (this.#closed) return;
    if (this.#draining) {
      // The running drain may already have read past an event committed now;
      // without another pass it would wait for the next tick.
      this.#wakeAgain = true;
      return;
    }
    const operation = this.#drainIngress().finally(() => {
      if (this.#draining !== operation) return;
      this.#draining = null;
      if (this.#wakeAgain) {
        this.#wakeAgain = false;
        this.wake();
      }
    });
    this.#draining = operation;
  }

  /**
   * What a person can connect. The catalog is the one description of a
   * provider — a computer never gets to describe one differently — and the
   * relay only answers whether some connected computer can actually carry it.
   */
  dashboard(ownerUserId: UserId): Promise<ChannelDashboard> {
    const providers = channelProviderCatalog.map((provider) =>
      provider.availability === "available" &&
      !this.#relay.supports(provider.provider, provider.defaultTransportKind)
        ? { ...provider, availability: "unavailable" as const }
        : provider,
    );
    return this.#channels.dashboard(ownerUserId, providers, this.#relay.connectedRunnerIds());
  }

  async createConnection(input: {
    readonly accessPolicy: ChannelAccessPolicy;
    readonly credentials: Readonly<Record<string, string>>;
    readonly createdBy: UserId;
    readonly provider: string;
    readonly routingMode: "dedicated" | "shared";
    readonly workspaceId: string;
  }) {
    const provider = ChannelProviderSchema.parse(input.provider);
    const manifest = providerManifest(provider);
    if (!manifest.connectionMethods.includes("bring-your-own")) {
      throw new OpensteerError({
        code: "conflict",
        message: `${provider} is not available for bring-your-own setup`,
      });
    }
    const transportKind = manifest.defaultTransportKind;
    const runnerId = this.#relay.selectRunner(provider, transportKind);
    if (!runnerId) {
      throw new OpensteerError({
        code: "conflict",
        message: `${manifest.label} connection service is still starting. Try again in a moment.`,
        retryable: true,
      });
    }
    const workspaceId = WorkspaceIdSchema.parse(input.workspaceId);
    const credentials = providerCredentials(manifest, input.credentials);
    const inspection = InspectChannelConnectionResponseSchema.parse(
      await this.#relay.request(runnerId, "connection.inspect", {
        credentials,
        provider,
        transportKind,
      }),
    );
    if (!inspection.ready || !inspection.identity) throw inspectionError(inspection);
    const identity = inspection.identity;
    const externalAccountId = boundedExternalId(
      identity.externalAccountId,
      `${manifest.label} account ID`,
    );
    const accessPolicy = ChannelAccessPolicySchema.parse(input.accessPolicy);
    const credential = await this.#credentials.prepare({
      metadata: { externalAccountId },
      name: `${identity.connectionDisplayName} credentials`,
      ownerId: input.createdBy,
      provider: `channel:${provider}`,
      secrets: credentials,
    });
    const created = await this.#channels.createConnection({
      accessPolicy,
      account: {
        displayName: identity.accountDisplayName,
        externalAccountId,
        handle: identity.handle,
        metadata: identity.metadata,
        routingMode: input.routingMode,
      },
      connection: {
        capabilities: inspection.capabilities,
        runnerId,
        connectionMethod: "bring-your-own",
        displayName: identity.connectionDisplayName,
        externalIdentityId: identity.externalIdentityId,
        externalTenantId: externalAccountId,
        provider,
        transportKind,
      },
      createdBy: input.createdBy,
      credential,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
      workspaceId,
    });
    await this.#syncRuntime(runnerId).catch(async (error: unknown) => {
      await this.#channels.setRuntimeConnectionHealth({
        connectionId: created.connection.id,
        detail: safeMessage(error, safeMessageOptions),
        reason: "transport",
        runnerId,
        status: "needs-attention",
      });
    });
    return created;
  }

  /**
   * A channel whose transport runs on one of the creator's own computers:
   * iMessage through that Mac's Messages, read and sent by its helper. It is
   * pinned to that computer, holds no secret, and is a use of the computer's
   * app connection at read and write, so turning that app off or down ends
   * it. The creator's own handles are linked to them now: iMessage says who
   * sent a text, and a stranger must never be the one handed a link code.
   */
  async createComputerConnection(input: {
    readonly createdBy: UserId;
    readonly ownerHandles: readonly string[];
    readonly provider: string;
    readonly runnerId: string;
    readonly workspaceId: string;
  }) {
    const provider = ChannelProviderSchema.parse(input.provider);
    const manifest = providerManifest(provider);
    if (!manifest.transportKinds.includes("computer") || !manifest.computerApp) {
      throw new OpensteerError({
        code: "conflict",
        message: `${manifest.label} is not reached through a computer`,
      });
    }
    const runnerId = RunnerIdSchema.parse(input.runnerId);
    const workspaceId = WorkspaceIdSchema.parse(input.workspaceId);
    const ownerHandles = input.ownerHandles.map(ownerHandle);
    const carries = this.#relay
      .capabilities(runnerId)
      .some(
        (capability) =>
          capability.provider === provider && capability.transportKinds.includes("computer"),
      );
    if (!carries || !this.#relay.isConnected(runnerId)) {
      throw new OpensteerError({
        code: "conflict",
        message: `That computer is not connected with ${manifest.label} yet. Try again once it is online.`,
        retryable: true,
      });
    }
    const sourceConnectionId = await this.#channels.computerAppConnectionId({
      definitionId: manifest.computerApp,
      ownerUserId: input.createdBy,
      runnerId,
    });
    if (!sourceConnectionId) {
      throw new OpensteerError({
        code: "forbidden",
        message: `${manifest.label} needs its app on that computer turned on, allowed to read and send.`,
      });
    }
    const inspection = InspectChannelConnectionResponseSchema.parse(
      await this.#relay.request(runnerId, "connection.inspect", {
        credentials: {},
        provider,
        transportKind: "computer",
      }),
    );
    if (!inspection.ready || !inspection.identity) throw inspectionError(inspection);
    const identity = inspection.identity;
    const externalAccountId = boundedExternalId(
      identity.externalAccountId,
      `${manifest.label} account ID`,
    );
    const created = await this.#channels.createConnection({
      // One-to-one only, from the creator and the people they approve; an
      // unknown sender waits for approval without being told anything.
      accessPolicy: {
        channels: {
          conversationIds: [],
          scope: "off",
          sender: { allowedExternalUserIds: [], mode: "off" },
        },
        directMessages: { allowedExternalUserIds: [], mode: "approved" },
      },
      account: {
        displayName: identity.accountDisplayName,
        externalAccountId,
        handle: identity.handle,
        metadata: identity.metadata,
        routingMode: "dedicated",
      },
      connection: {
        capabilities: inspection.capabilities,
        connectionMethod: "computer",
        displayName: identity.connectionDisplayName,
        externalIdentityId: identity.externalIdentityId,
        externalTenantId: externalAccountId,
        provider,
        runnerId,
        sourceConnectionId,
        transportKind: "computer",
      },
      createdBy: input.createdBy,
      credential: null,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      linkedExternalUserIds: ownerHandles,
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
      workspaceId,
    });
    await this.#syncRuntime(runnerId).catch(async (error: unknown) => {
      await this.#channels.setRuntimeConnectionHealth({
        connectionId: created.connection.id,
        detail: safeMessage(error, safeMessageOptions),
        reason: "transport",
        runnerId,
        status: "needs-attention",
      });
    });
    return created;
  }

  async replaceConnectionCredentials(input: {
    readonly connectionId: string;
    readonly credentials: Readonly<Record<string, string>>;
    readonly ownerUserId: UserId;
  }): Promise<void> {
    const connectionId = IntegrationConnectionIdSchema.parse(input.connectionId);
    const connection = await this.#credentials.channelConnectionForReplacement(
      connectionId,
      input.ownerUserId,
    );
    if (!connection) {
      throw new OpensteerError({
        code: "not_found",
        message: "This channel connection has no credentials to replace.",
      });
    }
    if (!this.#relay.isConnected(connection.runnerId)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Messaging connection service is still starting. Try again in a moment.",
        retryable: true,
      });
    }
    const provider = ChannelProviderSchema.parse(connection.provider.slice("channel:".length));
    const manifest = providerManifest(provider);
    const credentials = providerCredentials(manifest, input.credentials);
    const inspection = InspectChannelConnectionResponseSchema.parse(
      await this.#relay.request(connection.runnerId, "connection.inspect", {
        credentials,
        provider,
        transportKind: connection.transportKind,
      }),
    );
    if (!inspection.ready || !inspection.identity) throw inspectionError(inspection);
    if (inspection.identity.externalAccountId !== connection.externalTenantId) {
      throw new OpensteerError({
        code: "conflict",
        message: `These credentials belong to a different ${manifest.label} account`,
      });
    }
    const runnerId = await this.#credentials.replaceChannelConnection({
      connectionId,
      ownerId: input.ownerUserId,
      secrets: credentials,
    });
    await this.#syncRuntime(runnerId);
  }

  async checkConnection(connectionIdInput: string, ownerUserId: UserId) {
    const connectionId = IntegrationConnectionIdSchema.parse(connectionIdInput);
    const connection = await this.#channels.connectionForCheck(connectionId, ownerUserId);
    if (!connection || !this.#relay.isConnected(connection.runnerId)) {
      throw new OpensteerError({
        code: "conflict",
        message: "Messaging connection service is still starting. Try again in a moment.",
        retryable: true,
      });
    }
    const provider = connection.provider;
    const manifest = providerManifest(provider);
    // A computer transport holds no secret: its computer is its credential.
    const credentials =
      connection.credentialId === null
        ? {}
        : await this.#credentials.materializeForChannelRuntime(
            connection.credentialId,
            ownerUserId,
            { connectionId, purpose: "transport", runnerId: connection.runnerId },
            credentialFieldsForPurpose(manifest, "transport"),
          );
    const inspection = InspectChannelConnectionResponseSchema.parse(
      await this.#relay.request(connection.runnerId, "connection.inspect", {
        credentials,
        provider,
        transportKind: connection.transportKind,
      }),
    );
    const accountMismatch =
      inspection.identity !== null &&
      inspection.identity.externalAccountId !== connection.externalTenantId;
    if (!inspection.ready || accountMismatch) {
      const issue = accountMismatch
        ? {
            code: `${provider}.account_mismatch`,
            kind: "credentials" as const,
            message:
              connection.transportKind === "computer"
                ? `That computer's ${manifest.label} is signed in to a different account than this channel was set up with.`
                : `These credentials belong to a different ${manifest.label} account.`,
            missing: [],
          }
        : inspection.issues[0];
      await this.#channels.setRuntimeConnectionHealth({
        connectionId,
        detail: issue?.message ?? "Provider setup is incomplete",
        reason: issue?.kind ?? "configuration",
        runnerId: connection.runnerId,
        status: "needs-attention",
      });
      return accountMismatch ? { ...inspection, issues: [issue!], ready: false } : inspection;
    }
    await this.#channels.setConnectionStatus(connectionId, ownerUserId, "connected");
    await this.#syncRuntime(connection.runnerId);
    return inspection;
  }

  revokeBinding(bindingId: string, ownerUserId: UserId): Promise<void> {
    return this.#channels.revokeBinding({
      bindingId: ChannelBindingIdSchema.parse(bindingId),
      ownerUserId,
    });
  }

  updateBinding(input: {
    readonly bindingId: string;
    readonly expectedRevision: number;
    readonly accessPolicy: ChannelAccessPolicy;
    readonly ownerUserId: UserId;
  }) {
    return this.#channels.updateBinding({
      ...input,
      bindingId: ChannelBindingIdSchema.parse(input.bindingId),
    });
  }

  reviewAccess(input: {
    readonly bindingId: string;
    readonly externalUserId: string;
    readonly expectedRevision: number;
    readonly decision: "approved" | "declined" | "revoked";
    readonly ownerUserId: UserId;
  }) {
    return this.#channels.reviewAccess({
      ...input,
      bindingId: ChannelBindingIdSchema.parse(input.bindingId),
    });
  }

  createBinding(input: {
    readonly accessPolicy: unknown;
    readonly accountId: string;
    readonly createdBy: UserId;
    readonly executionPolicy: unknown;
    readonly selector: unknown;
    readonly workspaceId: string;
  }) {
    return this.#channels.createBinding({
      accessPolicy: input.accessPolicy,
      accountId: ChannelAccountIdSchema.parse(input.accountId),
      createdBy: input.createdBy,
      executionPolicy: input.executionPolicy,
      selector: input.selector,
      workspaceId: WorkspaceIdSchema.parse(input.workspaceId),
    });
  }

  async setConnectionStatus(
    connectionId: string,
    ownerUserId: UserId,
    status: "connected" | "paused" | "revoked",
  ): Promise<void> {
    await this.#channels.setConnectionStatus(
      IntegrationConnectionIdSchema.parse(connectionId),
      ownerUserId,
      status,
    );
    await this.syncRuntimes();
  }

  /**
   * Tells every connected messaging runtime what it holds now. A computer
   * app's removal revokes the channels that were a use of it, in the same
   * transaction, and this is how the computer carrying them hears.
   */
  async syncRuntimes(): Promise<void> {
    await Promise.allSettled(
      this.#relay.connectedRunnerIds().map((runnerId) => this.#syncRuntime(runnerId)),
    );
  }

  /**
   * Redeem the code the bot handed somebody in their own conversation. The
   * code travels to the person, not from them, so nothing has to reach the
   * Host through a provider's slash-command surface.
   */
  linkIdentity(code: string, userId: UserId) {
    return this.#channels.linkIdentity({ codeHash: digest(normalizeLinkCode(code)), userId });
  }

  async resolveRuntimeConnection(
    runnerIdInput: string,
    input: {
      readonly connectionId: string;
      readonly purpose: ChannelCredentialPurpose;
      readonly provider: string;
    },
  ) {
    const runnerId = RunnerIdSchema.parse(runnerIdInput);
    const provider = ChannelProviderSchema.parse(input.provider);
    const connection = await this.#channels.runtimeConnection({
      connectionId: IntegrationConnectionIdSchema.parse(input.connectionId),
      provider,
      runnerId,
    });
    if (!connection) {
      throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
    }
    // A computer transport holds no secret: its computer is its credential.
    const secrets =
      connection.credentialId === null
        ? {}
        : await this.#credentials.materializeForChannelRuntime(
            connection.credentialId,
            connection.ownerUserId,
            {
              connectionId: IntegrationConnectionIdSchema.parse(input.connectionId),
              purpose: input.purpose,
              runnerId,
            },
            credentialFieldsForPurpose(providerManifest(provider), input.purpose),
          );
    return {
      accountId: connection.accountId,
      externalAccountId: connection.externalAccountId,
      purpose: input.purpose,
      secrets,
    };
  }

  async commitIngress(runnerId: RunnerId, connectionId: string, event: unknown) {
    const parsedConnectionId = IntegrationConnectionIdSchema.parse(connectionId);
    const provider = ChannelProviderSchema.parse((event as { provider?: unknown }).provider);
    if (
      !(await this.#channels.runtimeConnection({
        connectionId: parsedConnectionId,
        provider,
        runnerId,
      }))
    ) {
      throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
    }
    const committed = await this.#channels.commitIngress(parsedConnectionId, event);
    this.wake();
    return committed;
  }

  async claimDelivery(runnerId: RunnerId, leaseSeconds: number) {
    const claim = await this.#channels.claimDelivery(
      runnerId,
      Math.min(120, Math.max(5, leaseSeconds)) * 1_000,
    );
    if (!claim) return null;
    const secrets =
      claim.connection.credentialId === null
        ? {}
        : await this.#credentials.materializeForChannelRuntime(
            claim.connection.credentialId,
            claim.connection.ownerUserId,
            {
              connectionId: claim.connection.connectionId,
              purpose: "delivery",
              runnerId,
            },
            credentialFieldsForPurpose(providerManifest(claim.connection.provider), "delivery"),
          );
    return {
      claimToken: claim.claimToken,
      delivery: claim.delivery,
      destination: claim.destination,
      mayHaveBeenSent: claim.mayHaveBeenSent,
      lease: {
        accountId: claim.delivery.accountId,
        externalAccountId: claim.externalAccountId,
        purpose: "delivery",
        secrets,
      },
      provider: claim.connection.provider,
    };
  }

  startDeliveryAttempt(deliveryId: string, claimToken: string): Promise<void> {
    return this.#channels.startDeliveryAttempt(
      ChannelDeliveryIdSchema.parse(deliveryId),
      claimToken,
    );
  }

  finishDelivery(input: {
    readonly claimToken: string;
    readonly deliveryId: string;
    readonly error?: string;
    readonly outcome: "sent" | "retryable-failed" | "unknown" | "dead";
    readonly receipt?: Readonly<Record<string, unknown>>;
    readonly retryAfterSeconds?: number | null;
  }): Promise<void> {
    return this.#channels.finishDelivery({
      claimToken: input.claimToken,
      deliveryId: ChannelDeliveryIdSchema.parse(input.deliveryId),
      ...(input.error ? { error: input.error } : {}),
      outcome: input.outcome,
      ...(input.receipt ? { receipt: input.receipt } : {}),
      // The wire schema already bounds this to a day, but the Host is the one
      // that parses the frame and the queue is the Host's, so it clamps again
      // rather than trusting a peer's arithmetic with its own backoff.
      ...(input.retryAfterSeconds
        ? { retryAfterMs: Math.min(86_400, Math.max(1, input.retryAfterSeconds)) * 1_000 }
        : {}),
    });
  }

  async runtimeConnected(runnerIdInput: string): Promise<void> {
    const runnerId = RunnerIdSchema.parse(runnerIdInput);
    // Assignment follows what may hold an account, not what is reachable this
    // instant: a computer whose stream blinked keeps its accounts rather than
    // handing them to another machine and back.
    await this.#channels.reassignDisconnectedRuntimeConnections({
      capabilities: this.#relay.capabilities(runnerId),
      connectedRunnerIds: this.#relay.assignableRunnerIds(),
      runnerId,
    });
    await Promise.all(
      this.#relay.connectedRunnerIds().map((connectedId) => this.#syncRuntime(connectedId)),
    );
  }

  async handleRuntimeRequest(runnerIdInput: string, request: RuntimeChannelRequest) {
    const runnerId = RunnerIdSchema.parse(runnerIdInput);
    switch (request.operation) {
      case "credential.resolve":
        return this.resolveRuntimeConnection(runnerId, request.payload);
      case "ingress.commit": {
        const committed = await this.commitIngress(
          runnerId,
          request.payload.connectionId,
          request.payload.event,
        );
        return CommitChannelIngressResultSchema.parse({
          duplicate: committed.duplicate,
          ingressId: committed.ingressId,
        });
      }
      case "delivery.claim":
        return ClaimChannelDeliveryResultSchema.parse({
          claimed: await this.claimDelivery(runnerId, request.payload.leaseSeconds),
        });
      case "delivery.start":
        await this.startDeliveryAttempt(request.payload.deliveryId, request.payload.claimToken);
        return {};
      case "delivery.finish":
        await this.finishDelivery(request.payload);
        return {};
      case "connection.health":
        await this.#channels.setRuntimeConnectionHealth({
          ...request.payload,
          runnerId,
        });
        return {};
    }
  }

  async #syncRuntime(runnerId: RunnerId): Promise<void> {
    const connections = await this.#channels.assignedRuntimeConnections(runnerId);
    await this.#relay.request(runnerId, "connections.sync", { connections });
  }

  async #drainIngress(): Promise<void> {
    // The work locations on offer are a property of the Deployment, not of one
    // message, so they are read once for the whole drain rather than once per
    // claimed event.
    const placementCandidates = await this.#placementCandidates();
    for (let processed = 0; processed < 100 && !this.#closed; processed += 1) {
      const claim = await this.#channels.claimIngress(`host:${process.pid}`);
      if (!claim) return;
      const stale = staleIngress(claim, Date.now());
      if (stale) {
        await this.#channels
          .markIngressIgnored(
            claim.id,
            claim.claimToken,
            stale.reason,
            claim.event.trigger === "conversation-followup"
              ? null
              : { accountId: claim.accountId, text: stale.notice },
          )
          .catch((error: unknown) => {
            if (!isStaleClaim(error)) throw error;
          });
        continue;
      }
      try {
        // Routing and identity come before placement inside adoptIngress, so a
        // person who needs a link code or a route hears about it even while no
        // computer is awake to run anything — and hears about it in the same
        // transaction that decided, so a crash cannot swallow the answer.
        const result = await this.#channels.adoptIngress({
          claimToken: claim.claimToken,
          ingressId: claim.id,
          notices: this.#notices(claim.event.provider),
          placementCandidates,
        });
        if (result.kind === "adopted") {
          this.#store.announceRevokedGrants(result.revokedGrants);
          for (const event of result.events) this.#onWorkspaceEvent(event);
          if (result.dispatchEnvironmentId) {
            this.#onExecutionQueued(result.dispatchEnvironmentId);
          }
        }
      } catch (error) {
        if (isStaleClaim(error)) continue;
        if (error instanceof ChannelIngressDeferredError) {
          await this.#deferIngress(claim, error.message).catch(() => undefined);
          continue;
        }
        await this.#channels
          .releaseIngress(claim.id, claim.claimToken, safeMessage(error, safeMessageOptions))
          .catch(() => undefined);
      }
    }
  }

  /**
   * What the bot says when a message produces no Run. The Host writes these
   * because only it knows the origin a person signs in at and what this
   * provider is called; the store inserts them in the transaction that decided,
   * so there is no window where somebody is refused in silence.
   */
  #notices(provider: ChannelProvider): ChannelIngressNotices {
    const label = providerManifest(provider).label;
    const hostname = new URL(this.#canonicalOrigin).hostname;
    const local = isLoopbackHostname(hostname);
    const verificationLocation = local
      ? "Open Opensteer on the computer running this bot, then open Messaging"
      : `Sign in at ${this.#canonicalOrigin}/settings/apps/messaging`;
    return {
      approvalPending:
        "Your access request was sent to the person who connected this bot. I will let you know when it is approved.",
      linkByDirectMessage: `To link your ${label} account to Opensteer, send me a direct message and I will give you a code.`,
      linkCode: (code) =>
        `Verify this ${label} identity: ${verificationLocation} and enter **${code}**. The code expires in 1 hour. Send your message again after verifying.`,
      noRoute:
        "This conversation is not routed to an Opensteer Workspace. Ask the person who connected this bot to add a route for it.",
      notAMember: "You don't have access to the Workspace this conversation is routed to.",
    };
  }

  /**
   * Nothing can run the message right now. It waits, without spending
   * attempts; once it is too old to answer, the next claim drops it aloud
   * (see `staleIngress`).
   */
  async #deferIngress(claim: ClaimedChannelIngress, reason: string): Promise<void> {
    await this.#channels.releaseIngress(claim.id, claim.claimToken, reason, {
      deferred: true,
    });
  }

  /**
   * A channel message arrives with nobody to choose where it runs, so it lands
   * on a connected work location that can run it.
   *
   * Every location that could take the message is returned, in preference
   * order, because who the message belongs to is not known yet: the channel
   * identity is resolved to a user inside adoptIngress, and only there can a
   * Runner belonging to somebody else be ruled out. The Deployment's own
   * locations come first; a person's desktop-added Mac (`local`) takes the
   * message when it is the one location available to them.
   */
  async #placementCandidates(): Promise<
    readonly {
      readonly environmentId: EnvironmentId;
      readonly harnessInstanceId: HarnessInstanceId;
    }[]
  > {
    const [environments, harnesses] = await Promise.all([
      this.#store.listEnvironments(),
      this.#store.listHarnessInstances(),
    ]);
    const candidates: {
      readonly environmentId: EnvironmentId;
      readonly harnessInstanceId: HarnessInstanceId;
    }[] = [];
    const byPreference = [...environments].sort(
      (left, right) => Number(left.kind === "local") - Number(right.kind === "local"),
    );
    for (const environment of byPreference) {
      if (!this.#runners.isAvailable(environment.id)) continue;
      // Nobody chose an AI engine for a channel message, so it gets the one
      // this exact work location means when nobody names one. No default means
      // no implicit account choice; another location's profile is never a
      // credential this Runner may borrow.
      const harness = harnesses.find(
        (candidate) =>
          candidate.environmentId === environment.id &&
          candidate.enabled &&
          candidate.isDefault &&
          this.#runners.canRunHarness(environment.id, candidate.driverKind),
      );
      if (harness) {
        candidates.push({ environmentId: environment.id, harnessInstanceId: harness.id });
      }
    }
    return candidates;
  }
}

/** Accept what a person retyped: the alphabet excludes I, O, 0 and 1 on purpose. */
function normalizeLinkCode(code: string): string {
  const normalized = code.trim().toUpperCase().replaceAll(/[\s-]/gu, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/u.test(normalized)) {
    throw new OpensteerError({
      code: "not_found",
      message: "That code is invalid or has expired.",
    });
  }
  return normalized;
}

function digest(value: string): string {
  return sha256Base64Url(value);
}

function channelSecret(value: string, label: string): string {
  if (value.length < 8 || value.length > 65_536 || /[\r\n\0]/u.test(value)) {
    throw new OpensteerError({ code: "bad_request", message: `${label} is invalid` });
  }
  return value;
}

function providerCredentials(
  manifest: ChannelProviderManifest,
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const fields = new Map(manifest.credentialFields.map((field) => [field.key, field] as const));
  const unknown = Object.keys(input).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: `${manifest.label} does not accept credential field ${unknown[0]}`,
    });
  }
  return Object.freeze(
    Object.fromEntries(
      [...fields.values()].map((field) => [
        field.key,
        channelSecret(input[field.key] ?? "", field.label),
      ]),
    ),
  );
}

/**
 * The one description of a provider. Computers report what they can carry, not
 * what a provider is, so two connected computers can never disagree about a
 * manifest and the Host never has to decide which of them is right.
 */
function providerManifest(provider: ChannelProvider): ChannelProviderManifest {
  const manifest: ChannelProviderManifest | undefined = channelProviderCatalog.find(
    (candidate) => candidate.provider === provider,
  );
  if (!manifest) {
    throw new OpensteerError({
      code: "conflict",
      message: `${provider} is not a messaging provider this Deployment knows`,
    });
  }
  return manifest;
}

function credentialFieldsForPurpose(
  manifest: ChannelProviderManifest,
  purpose: ChannelCredentialPurpose,
): readonly string[] {
  const fields = manifest.credentialFields
    .filter((field) => field.uses.includes(purpose))
    .map((field) => field.key);
  if (fields.length === 0) {
    throw new OpensteerError({
      code: "conflict",
      message: `${manifest.label} does not support ${purpose} credentials`,
    });
  }
  return fields;
}

function inspectionError(inspection: ChannelConnectionInspection): OpensteerError {
  const issue = inspection.issues[0];
  const missing = issue?.missing.length ? ` Missing: ${issue.missing.join(", ")}.` : "";
  return new OpensteerError({
    code: "bad_request",
    message: `${issue?.message ?? "Messaging provider setup is incomplete."}${missing}`,
  });
}

function boundedExternalId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /\p{Control}/u.test(normalized)) {
    throw new OpensteerError({ code: "bad_request", message: `${label} is invalid` });
  }
  return normalized;
}

const safeMessageOptions = { fallback: "Channel ingress failed" } as const;
/**
 * How old a message may be, counted from when the person sent it, and still
 * be run: a reply to yesterday's question is worse than none.
 */
const ingressAgeLimitMs = 60 * 60 * 1_000;

/**
 * Why a claimed message is too old to run, or undefined when it is not.
 *
 * Age is the sender's time, never the Host's: a transport that was offline —
 * a Mac asleep with its Messages, a socket that missed a window — hands over
 * an old message as if it were new, and a message that waited here for a
 * computer ages the same way.
 */
function staleIngress(
  claim: ClaimedChannelIngress,
  now: number,
): { readonly notice: string; readonly reason: string } | undefined {
  const sentAt = Date.parse(claim.event.occurredAt);
  if (now - sentAt < ingressAgeLimitMs) return undefined;
  return claim.receivedAt.getTime() - sentAt >= ingressAgeLimitMs
    ? {
        notice:
          "This message reached Opensteer more than an hour after it was sent, so it was not run. Send it again if you still need it.",
        reason: "The message reached Opensteer more than an hour after it was sent",
      }
    : {
        notice:
          "No computer was available in time to run this, so it was dropped. Send it again once one is online.",
        reason: "No computer was available within an hour of the message being sent",
      };
}
type ClaimedChannelIngress = NonNullable<Awaited<ReturnType<ChannelStore["claimIngress"]>>>;

function isStaleClaim(error: unknown): boolean {
  return (
    error instanceof OpensteerError &&
    error.code === "conflict" &&
    /claim is stale/u.test(error.message)
  );
}

/**
 * A handle as Messages records who wrote: an email address in lower case, or
 * a phone number as `+` and its digits. A number without its country code
 * could be anybody's, so it is refused rather than guessed at.
 */
function ownerHandle(value: string): string {
  const handle = normalizePersonalAddress(value);
  if (handle) return handle;
  throw new OpensteerError({
    code: "bad_request",
    message: `${value.trim().slice(0, 80)} is not an email address or a phone number with its country code, such as +1 555 123 4567.`,
  });
}
