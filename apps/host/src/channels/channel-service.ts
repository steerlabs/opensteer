import type { AdministrationCommandIdentity } from "@opensteer/database";
import { safeMessage } from "@opensteer/shared/safeMessage";
import {
  ChannelAccountIdSchema,
  ChannelDeliveryIdSchema,
  ChannelProviderSchema,
  IntegrationConnectionIdSchema,
  channelProviderCatalog,
  type ChannelDashboard,
  type ChannelProvider,
  type ChannelConnectionInspection,
  type ChannelProviderManifest,
} from "@opensteer/channel-core";
import {
  AgentConnectionStore,
  chatPausedMessage,
  ChannelStore,
  declineBridgeIngress,
  decideBridgeIngress,
  recordBridgeIngress,
  isChatWaiting,
  startBridgeOwnerLink,
  wakeChatQueues,
  type OpensteerStore,
} from "@opensteer/database";
import {
  OpensteerError,
  ThreadIdSchema,
  RunnerIdSchema,
  type AgentGrant,
  type RunnerId,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import type {} from "@opensteer/orchestration";
import {
  ClaimChannelDeliveryResultSchema,
  CommitChannelIngressResultSchema,
  InspectChannelConnectionResponseSchema,
  type ChannelCredentialPurpose,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";
import type { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { resolveBridgeCaller } from "./bridge-caller.js";
import type { MessagingRelayHub } from "./messaging-relay-hub.js";
import type { CredentialService } from "../identity/credential-service.js";

interface ChannelServiceOptions {
  readonly onError?: (error: unknown) => void;
  readonly onChanged?: () => void;
  readonly credentials: CredentialService;
  readonly relay: MessagingRelayHub;
  readonly store: OpensteerStore;
  readonly channels: ChannelStore;
  /** The task tools' own entry points, which a bridge calls as itself. */
  readonly bridgeTools: () => Pick<OpensteerMcpService, "callTool">;
  /** A provider account ended: its bridges end with it, through the Disconnect worker. */
  readonly onAccountEnded?: () => void;
}

export class ChannelService {
  readonly #onChanged: () => void;
  readonly #channels: ChannelStore;
  readonly #credentials: CredentialService;
  readonly #relay: MessagingRelayHub;
  readonly #store: OpensteerStore;
  readonly #bridgeTools: () => Pick<OpensteerMcpService, "callTool">;
  readonly #onAccountEnded: () => void;
  #closed = false;
  readonly #drains: DeadlineDrain;
  #nextPruneAt = 0;

  constructor(options: ChannelServiceOptions) {
    this.#onChanged = options.onChanged ?? (() => {});
    this.#channels = options.channels;
    this.#credentials = options.credentials;
    this.#relay = options.relay;
    this.#store = options.store;
    this.#bridgeTools = options.bridgeTools;
    this.#onAccountEnded = options.onAccountEnded ?? (() => {});
    this.#drains = new DeadlineDrain({
      drain: () => this.#drainIngress(),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  start(): void {
    this.#drains.start();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#drains.close();
  }

  wake(): void {
    this.#drains.wake();
  }

  /**
   * A chat account is back: everything its chats held while they waited goes on. Its waiting
   * messages are decided, each task's waiting inputs start in queue order, and its Runs that
   * were held are dispatched. The one wake, for each way a chat comes back: the person resumes
   * it, a check of the account succeeds, or the runtime reports it healthy again.
   */
  async #wakeHeld(connectionId: string): Promise<void> {
    await wakeChatQueues(this.#store.database, connectionId);
    this.wake();
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
    readonly credentials: Readonly<Record<string, string>>;
    readonly createdBy: UserId;
    readonly provider: string;
    readonly routingMode: "dedicated" | "shared";
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
    const credential = await this.#credentials.prepare({
      metadata: { externalAccountId },
      name: `${identity.connectionDisplayName} credentials`,
      ownerId: input.createdBy,
      provider: `channel:${provider}`,
      secrets: credentials,
    });
    const created = await this.#channels.createConnection({
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
   * it. "Me" is linked as on any account: the person sends, from their own
   * phone, the code Opensteer shows them.
   */
  async createComputerConnection(input: {
    readonly createdBy: UserId;
    readonly provider: string;
    readonly runnerId: string;
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
    await this.#wakeHeld(connectionId);
    await this.#syncRuntime(connection.runnerId);
    return inspection;
  }

  async setConnectionStatus(
    connectionId: string,
    ownerUserId: UserId,
    status: "connected" | "paused" | "revoked",
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<void> {
    const parsed = IntegrationConnectionIdSchema.parse(connectionId);
    await this.#channels.setConnectionStatus(parsed, ownerUserId, status, administration);
    if (status === "connected") await this.#wakeHeld(parsed);
    if (status === "revoked") this.#onAccountEnded();
    await this.syncRuntimes();
    this.#onChanged();
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
   * The code the person sends from their own account to the bot, so that account is "me" on
   * it. Opensteer shows it; the chat is never asked for anything.
   */
  startOwnerLink(accountId: string, userId: UserId) {
    return startBridgeOwnerLink(this.#store.database, { accountId, userId });
  }

  /**
   * A chat on one of the person's chat accounts, made on its consent, and returned as it is
   * listed with the connected agents.
   */
  async createChat(input: {
    readonly userId: UserId;
    readonly accountId: string;
    readonly conversation: { readonly id: string; readonly name: string } | null;
    readonly senders: "owner" | "anyone";
    readonly accessMode: ThreadAccessMode;
    readonly grant: AgentGrant;
  }): Promise<AgentConnection> {
    const connections = new AgentConnectionStore(this.#store.database);
    const made = await connections.createBridge({
      userId: input.userId,
      accountId: ChannelAccountIdSchema.parse(input.accountId),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      senders: input.senders,
      accessMode: input.accessMode,
      grant: input.grant,
    });
    this.#onChanged();
    return (
      (await connections.list(input.userId)).find((connection) => connection.id === made.id) ?? made
    );
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
    return this.#channels.commitIngress(parsedConnectionId, event, () => this.wake());
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
      case "connection.health": {
        const { back } = await this.#channels.setRuntimeConnectionHealth({
          ...request.payload,
          runnerId,
        });
        if (back) await this.#wakeHeld(request.payload.connectionId);
        return {};
      }
    }
  }

  async #syncRuntime(runnerId: RunnerId): Promise<void> {
    const connections = await this.#channels.assignedRuntimeConnections(runnerId);
    await this.#relay.request(runnerId, "connections.sync", { connections });
  }

  async #drainIngress(): Promise<Date | null | typeof retryWithBackoff> {
    const now = new Date();
    if (now.getTime() >= this.#nextPruneAt) {
      this.#nextPruneAt = now.getTime() + 60 * 60 * 1_000;
      await this.#channels.pruneHistory(now).catch(() => undefined);
    }
    let claimed = 0;
    for (let processed = 0; processed < 100 && !this.#closed; processed += 1) {
      const claim = await this.#channels.claimIngress(`host:${process.pid}`, now);
      if (!claim) break;
      claimed += 1;
      const stale = staleIngress(claim, now.getTime());
      if (stale) {
        // Nothing runs; a sender who may speak here is told it arrived too late.
        await decideBridgeIngress(this.#store.database, {
          ingressId: claim.id,
          claimToken: claim.claimToken,
          stale: stale.reason,
        }).catch((error: unknown) => {
          if (!isStaleClaim(error)) throw error;
        });
        continue;
      }
      try {
        await this.#handleIngress(claim);
      } catch (error) {
        if (isStaleClaim(error)) continue;
        await this.#channels
          .releaseIngress(claim.id, claim.claimToken, safeMessage(error, safeMessageOptions))
          .catch(() => undefined);
      }
    }
    if (this.#closed) return null;
    // Judged at the time this pass claimed at: work due then that the pass could
    // not claim (another transaction holds it) backs off rather than spinning;
    // after a claim a due one simply runs again.
    const next = await this.#channels.nextIngressDeadline(now);
    return next && next.getTime() <= now.getTime() && claimed === 0 ? retryWithBackoff : next;
  }

  /**
   * One chat message, through the bridge that covers its conversation: decided in one
   * transaction (who may speak, read with the grant), then sent to your own agents through the
   * task tools' own entry points as that bridge, then recorded. A crash between the steps
   * repeats them: the operation key is the message itself, so the tools answer with what they
   * already did.
   */
  async #handleIngress(claim: ClaimedChannelIngress): Promise<void> {
    const decision = await decideBridgeIngress(this.#store.database, {
      ingressId: claim.id,
      claimToken: claim.claimToken,
    });
    if (decision.kind !== "work") return;
    const chat = {
      conversationId: decision.conversationId,
      revision: decision.grantRevision,
      sender: decision.sender,
    };
    const resolve = () =>
      resolveBridgeCaller(this.#store, {
        ownerUserId: decision.ownerUserId,
        bridgeId: decision.bridgeId,
        chat,
      });
    let caller;
    try {
      caller = await resolve();
    } catch (error) {
      if (isChatWaiting(error)) return this.#giveBack(claim);
      if (!(error instanceof OpensteerError)) throw error;
      await this.#channels.markIngressIgnored(claim.id, claim.claimToken, error.message);
      return;
    }
    const tools = this.#bridgeTools();
    const call = (name: string, args: Record<string, unknown>) =>
      tools.callTool("", name, args, {
        caller,
        resolveCaller: resolve,
        operationKey: `ingress:${claim.id}`,
      });
    let taskId = decision.taskId;
    try {
      if (decision.action === "create") {
        const created = (await call("opensteer_task_create", { message: decision.text })) as {
          readonly taskId: string;
        };
        taskId = ThreadIdSchema.parse(created.taskId);
      } else if (decision.action === "send") {
        await call("opensteer_task_send", {
          taskId: decision.taskId,
          message: decision.text,
          delivery: "queue",
        });
      } else {
        await call("opensteer_task_interrupt", { taskId: decision.taskId });
      }
    } catch (error) {
      // Its chat was paused on the way: the message waits for it, and is decided when it is back.
      if (isChatWaiting(error)) return this.#giveBack(claim);
      // Refused for what it is (no longer admitted, not found, not allowed): nothing runs, and
      // nothing is said in the chat. Anything else is retried with the same operation key.
      if (
        error instanceof OpensteerError &&
        ["forbidden", "not_found", "bad_request", "unauthorized"].includes(error.code)
      ) {
        // Its sender may speak here (the decision admitted them): they hear one line, no reason.
        await declineBridgeIngress(this.#store.database, {
          ingressId: claim.id,
          claimToken: claim.claimToken,
          conversationId: decision.conversationId,
          reason: error.message,
        });
        return;
      }
      if (error instanceof OpensteerError && error.retryable) {
        await this.#deferIngress(claim, error.message);
        return;
      }
      throw error;
    }
    await recordBridgeIngress(this.#store.database, {
      ingressId: claim.id,
      claimToken: claim.claimToken,
      conversationId: decision.conversationId,
      taskId: taskId!,
    });
  }

  /**
   * Its chat is paused: the message goes back with its attempt given back, is not claimed while
   * the chat waits, and is decided as soon as it is back. Never dropped for the pause.
   */
  async #giveBack(claim: ClaimedChannelIngress): Promise<void> {
    await this.#channels.releaseIngress(claim.id, claim.claimToken, chatPausedMessage, {
      waiting: true,
    });
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
): { readonly reason: string } | undefined {
  const sentAt = Date.parse(claim.event.occurredAt);
  if (now - sentAt < ingressAgeLimitMs) return undefined;
  return {
    reason:
      claim.receivedAt.getTime() - sentAt >= ingressAgeLimitMs
        ? "The message reached Opensteer more than an hour after it was sent"
        : "No computer was available within an hour of the message being sent",
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
