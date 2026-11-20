import { TeamPartners } from "../team-partners/service.js";
import { createTeamPartnerOfferVault } from "../team-partners/offer-vault.js";
import { GcsTeamFileStore } from "../team/file-store.js";
import { TeamInstallationStore } from "@opensteer/database/team-installation";
import { TeamPartnerStore } from "../team-partners/store.js";
import { registerTeamPartnerRoutes } from "../team-partners/routes.js";
import {
  teamPartnerCapability,
  teamShareCapability,
  teamSharedAgentsCapability,
  teamPartnerSocketPath,
} from "@opensteer/protocol";
import { teamOidcStatePrefix, teamOAuthVersionParameter } from "@opensteer/deployment-authority";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  OpensteerError,
  deploymentPolicy,
  type Deployment,
  type HostKeyFingerprint,
} from "@opensteer/core";
import {
  TeamHostDescriptorSchema,
  apiNegotiation,
  minimumTeamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  AccountDirectoryStore,
  NotificationPreviewKeyStore,
  TeamAccessStore,
  TeamBus,
  appendTeamAudit,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  IdentityService,
  TeamIdentityAdmission,
  type OidcProviderConfiguration,
} from "@opensteer/identity";
import {
  personalWebBuildId,
  teamIdentityRpcNames,
  type HostApiHandlers,
} from "@opensteer/protocol";
import {
  officialOpensteerAccountProviderId,
  type HostAccountAdoptionBundle,
} from "@opensteer/control-plane-protocol";
import type { HostConfig } from "@opensteer/config";
import type { Kysely } from "kysely";
import type { HostRuntimeOptions, TeamHostRuntime } from "./runtime.js";
import { signHostDiscovery, type HostKeyPair } from "../identity/host-keys.js";
import { HostAuthenticator, toWebHeaders } from "../identity/auth.js";
import { installClientAddress } from "../identity/anonymous-client-address.js";
import { createIdentityRpcHandlers, registerIdentityRoutes } from "../identity/identity-routes.js";
import { registerHostApi, carryWebSocketVersion } from "../server/host-api-registration.js";
import { installHostHttpBoundary } from "../server/host-http-boundary.js";
import { HostStaticDistribution } from "../server/static-distribution.js";
import {
  RemoteAccountAdoptionGrantVerifier,
  RemoteHostedTeamOwnerCheckVerifier,
} from "../access/account-adoption-grant-verifier.js";
import { RemoteTeamIdentityAssertionVerifier } from "../access/team-identity-assertion-verifier.js";
import { AccountDirectoryClient } from "../access/account-directory-client.js";
import { RemotePersonProfileReceiptVerifier } from "../access/person-profile-receipt-verifier.js";
import { AccountDirectoryPublisher } from "../access/account-directory-publisher.js";
import { HostAuthorityPublisher } from "../access/host-authority-publisher.js";
import { NotificationPreviewService } from "../notifications/notification-preview-service.js";
import { startTeamKnowledge, type TeamKnowledge } from "../knowledge/team-knowledge.js";
import { startTeamServices, assertTeamApiVersion } from "../team/services.js";
import { registerTeamBinaryRoutes } from "../team/binary-routes.js";
import { registerTeamSetupRoutes } from "../team/setup-routes.js";
import { registerTeamSessionExchangeRoute } from "../team/session-exchange-routes.js";
import { createTeamInviteVerifierVault } from "../team/invite-verifier-vault.js";
import { createTeamMachineAdapters } from "../team/machine-adapters.js";
import { createTeamPushPublisher } from "../team/push.js";
import {
  createTeamLinkEndpoint,
  TeamLinkLifetimes,
  registerTeamLinkRoutes,
} from "../team-link-endpoint/index.js";

export async function createTeamHostRuntime(input: {
  config: HostConfig;
  options: HostRuntimeOptions;
  database: Kysely<DatabaseSchema>;
  deployment: Deployment;
  keys: HostKeyPair;
  hostKeyFingerprint: HostKeyFingerprint;
}): Promise<TeamHostRuntime> {
  const { config, options, database, deployment, keys, hostKeyFingerprint } = input;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  installClientAddress(app);
  const stopping = new AbortController();
  const lifetimes = new TeamLinkLifetimes();
  let services: Awaited<ReturnType<typeof startTeamServices>> | undefined;
  let knowledge: TeamKnowledge | undefined;
  let partners: TeamPartners | undefined;
  let machine: ReturnType<typeof createTeamLinkEndpoint> | undefined;
  let account = config.account;
  let authority: HostAuthorityPublisher | undefined;
  let directory: AccountDirectoryPublisher | undefined;
  let admitted: TeamIdentityAdmission | undefined;
  let stopped = false;
  let ready = false;
  // One process among the copies serving this team's database.
  const processId = randomUUID();
  const bus = new TeamBus(database, { onError: () => report("team-bus") });
  const installation = new TeamInstallationStore(config.authSecret, deployment.id);
  let draining = false;
  let step: string | undefined;
  const report = (area: string) => app.log.error({ area }, "Team background service failed");
  const envelope = signHostDiscovery(keys, {
    canonicalOrigin: deployment.canonicalOrigin,
    deploymentId: deployment.id,
    hostInstanceId: deployment.activeHostInstanceId,
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "team" },
  });
  const issuer = config.account?.issuer ?? new URL("https://accounts.opensteer.com");
  const preview = new NotificationPreviewService({
    store: new NotificationPreviewKeyStore(database),
    issuer: issuer.origin,
    vault: new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(
        new Map([
          [1, createHash("sha256").update("team-preview-v1\0").update(config.authSecret).digest()],
        ]),
        1,
      ),
    ),
    onError: report,
  });
  async function publishDirectory() {
    await directory?.close();
    await authority?.close();
    if (!account || stopped) return;
    const client = new AccountDirectoryClient({
      authorityEnvelope: envelope,
      controlApiOrigin: account.controlApiOrigin,
      hostCredential: account.hostCredential,
      deployment,
      ...(options.accountDirectoryFetch ? { fetch: options.accountDirectoryFetch } : {}),
    });
    directory = new AccountDirectoryPublisher({
      store: new AccountDirectoryStore(database, deploymentPolicy({ kind: "team" })),
      publish: (projection) => client.publish(projection),
      onError: () => report("team-directory"),
      ...(options.accountDirectoryIntervalMs
        ? { intervalMs: options.accountDirectoryIntervalMs }
        : {}),
    });
    const publishing = new HostAuthorityPublisher({
      publish: () => client.publishAuthority(),
      onError: () => report("team-authority"),
    });
    authority = publishing;
    const publishingDirectory = directory;
    void publishing.ready().then(() => {
      if (!stopped && authority === publishing) publishingDirectory.start();
    });
    publishing.start();
  }
  try {
    // Adoption may have happened on another copy; the sealed bundle is the source of truth.
    const adopted = await installation.load(database);
    if (adopted) account = accountFromBundle(adopted);
    const access = new TeamAccessStore(database);
    partners = new TeamPartners({
      bus,
      processId,
      offerVault: createTeamPartnerOfferVault(config.authSecret, deployment.id),
      store: new TeamPartnerStore(access, envelope),
      ...(options.teamPartnerNetwork ? { network: options.teamPartnerNetwork } : {}),
      keys,
      teamName: config.deploymentName ?? "Team",
      publicOnly: async () => (await admitted?.hostedTeam()) != null,
      onError: () => report("team-partners"),
    });
    services = await startTeamServices({
      bus,
      processId,
      ...(config.teamFileStore?.kind === "gcs"
        ? {
            fileStore: new GcsTeamFileStore(
              config.teamFileStore.bucket,
              config.teamFileStore.prefix,
            ),
          }
        : {}),
      profileReceipts: new RemotePersonProfileReceiptVerifier({
        issuer,
        ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
      }),
      partners,
      kind: "team",
      database,
      access,
      teamId: deployment.id,
      teamName: config.deploymentName ?? "Team",
      hostKeyFingerprint,
      origin: deployment.canonicalOrigin,
      inviteVerifiers: createTeamInviteVerifierVault(config.authSecret, deployment.id),
      dataDirectory: config.dataDirectory,
      storageLimitBytes: config.teamStorageLimitBytes,
      knowledge: {
        read: (actor, name, raw) => {
          if (!knowledge) throw new Error("Knowledge is not ready");
          return knowledge.read(actor, name, raw);
        },
        command: (actor, command) => {
          if (!knowledge) throw new Error("Knowledge is not ready");
          return knowledge.command(actor, command);
        },
      },
      machine: {
        deliver: async (linkId) => {
          await machine?.endpoint.deliver(linkId);
        },
        cancel: (linkId, requestId) => machine?.endpoint.cancel(linkId, requestId),
        close: (effects) => lifetimes.close(effects),
        isOnline: async (ownerUserId) => (await machine?.endpoint.isOnline(ownerUserId)) ?? false,
        resync: async () => {
          await machine?.endpoint.resync();
        },
        closeAll: (code) => machine?.endpoint.closeAll(code),
        relocate: () => machine?.endpoint.relocate(),
      },
      registerPreviewKey: (session, command) =>
        preview.register({ userId: session.user.id, authSessionId: session.id, ...command }),
      hostedTeam: async () => (admitted ? admitted.hostedTeam() : null),
      publishPush: createTeamPushPublisher({
        teamId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
        origin: deployment.canonicalOrigin,
        target: async () => {
          if (!account) throw new Error("Account adoption is incomplete");
          return account;
        },
        keys: (userId, accounts) => preview.keys(userId, accounts),
        signal: stopping.signal,
        ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
      }),
      backgroundError: report,
    });
    knowledge = await startTeamKnowledge({ database, access, audit: appendTeamAudit });
    const team = services;
    const adapters = createTeamMachineAdapters(team, knowledge);
    machine = createTeamLinkEndpoint({
      bus,
      processId,
      teamName: config.deploymentName ?? "Team",
      database,
      requests: team.requests,
      access,
      resolver: access,
      lifetimes,
      ...adapters,
      onPresence: (ownerUserId, online) => {
        void team.realtime
          .linkPresenceChanged(ownerUserId, online)
          .catch(() => report("team-presence"));
      },
    });
    const admission = new TeamIdentityAdmission({
      access,
      invites: team.invites,
      applyProfile: (userId, receipt) => team.applyProfile(userId, receipt),
      authority: {
        canonicalOrigin: deployment.canonicalOrigin,
        deploymentId: deployment.id,
        hostInstanceId: deployment.activeHostInstanceId,
        hostKeyFingerprint,
      },
      grantVerifier: new RemoteAccountAdoptionGrantVerifier({
        audience: deployment.canonicalOrigin,
        issuer,
        ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
      }),
      hosted: {
        createGeneralChannel: (transaction, ownerUserId) =>
          team.chat.createGeneral(transaction, ownerUserId),
        verifyOwnerCheck: (() => {
          const verifier = new RemoteHostedTeamOwnerCheckVerifier({
            audience: deployment.canonicalOrigin,
            issuer,
            ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
          });
          return (assertion: unknown) => verifier.verify(assertion);
        })(),
      },
      identityVerifier: new RemoteTeamIdentityAssertionVerifier({
        audience: deployment.canonicalOrigin,
        issuer,
        ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
      }),
      // Every copy, this one included, picks the bundle up from the `account` event.
      installAccountBundle: (bundle, transaction) => installation.install(transaction, bundle),
    });
    admitted = admission;
    const identity = new IdentityService(database, {
      team: admission,
      deployment: { kind: "team", name: config.deploymentName ?? null },
      hostKeyFingerprint,
      publicOrigin: config.canonicalOrigin,
      secret: config.authSecret,
      exposure: config.exposure,
      localPasswordEnabled: false,
      signupPolicy: "invite-only",
      oidcProviders: account ? [accountProvider(account)] : [],
      ...(config.identity.nativeOAuth ? { nativeOAuth: config.identity.nativeOAuth } : {}),
      ...(config.portalOrigin ? { portalOrigin: config.portalOrigin } : {}),
      ...(config.identity.initialOwnerEnrollment
        ? {
            initialOwnerEnrollment: {
              tokenDigest: config.identity.initialOwnerEnrollment.tokenDigest,
              expiresAt: new Date(
                Date.now() + config.identity.initialOwnerEnrollment.lifetimeSeconds * 1000,
              ),
            },
          }
        : {}),
    });
    await identity.initialize();
    const reloadAccount = async () => {
      const bundle = await installation.load(database);
      if (!bundle || stopped) return;
      account = accountFromBundle(bundle);
      await identity.reloadAccountProvider(accountProvider(account));
      await publishDirectory();
    };
    const detachAccount = bus.on((event) => {
      if (event.kind === "account") void reloadAccount().catch(() => report("team-account"));
    });
    const detachAccountResync = bus.onResync(reloadAccount);
    const authenticator = new HostAuthenticator({ identity, publicUrl: config.canonicalOrigin });
    app.addHook("onRequest", async (request) => {
      carryWebSocketVersion(request, "team");
      // A system browser carries negotiation in the OAuth round trip; it cannot set upgrade headers.
      if (request.method === "GET") {
        const url = new URL(request.url, config.canonicalOrigin),
          values = url.searchParams.getAll(teamOAuthVersionParameter);
        if (url.pathname === "/v1/auth/oidc/callback") {
          const states = url.searchParams.getAll("state"),
            state = states.length === 1 ? states[0] : undefined;
          if (state?.startsWith(teamOidcStatePrefix)) {
            const version = state.slice(teamOidcStatePrefix.length).split(".", 1)[0];
            if (version) {
              const held = request.headers[teamApiVersionHeader];
              request.headers[teamApiVersionHeader] =
                held === undefined || held === version ? version : "invalid";
            }
          }
        } else if (
          ["/v1/auth/native/oauth2/authorize", "/v1/auth/native/oauth2/end-session"].includes(
            url.pathname,
          ) &&
          values.length > 0
        ) {
          const held = request.headers[teamApiVersionHeader];
          request.headers[teamApiVersionHeader] =
            values.length === 1 && (held === undefined || held === values[0])
              ? values[0]
              : "invalid";
        }
      }

      if (
        (request.url.startsWith("/v1/") && !request.url.startsWith("/v1/rpc/")) ||
        request.url.startsWith("/rpc/") ||
        (request.url.startsWith("/internal/v1/team/") && request.url !== teamPartnerSocketPath) ||
        request.url.startsWith("/.well-known/openid-configuration") ||
        request.url.startsWith("/.well-known/oauth-authorization-server")
      )
        assertTeamApiVersion(toWebHeaders(request.headers));
    });
    installHostHttpBoundary(app);
    // While draining, every response retires its connection so a proxy's pooled connections to
    // this process end, and new sockets are refused so clients reconnect to another copy.
    app.addHook("onRequest", async (request, reply) => {
      if (draining && request.headers.upgrade?.toLowerCase() === "websocket")
        await reply.code(503).header("connection", "close").send({ ok: false });
    });
    app.addHook("onSend", async (_request, reply) => {
      if (draining) reply.header("connection", "close");
    });
    await app.register(websocket, { options: { maxPayload: 512 * 1024 } });
    app.get("/healthz", () => ({ ok: true }));
    app.get("/readyz", async (_request, reply) =>
      ready && !draining && bus.healthy ? { ok: true } : reply.code(503).send({ ok: false }),
    );
    app.get("/.well-known/opensteer", () =>
      TeamHostDescriptorSchema.parse({
        ...apiNegotiation("team"),
        minimumApiVersion: minimumTeamApiVersion,
        authority: envelope,
        bootstrapMethods: ["oidc"],
        capabilities: [
          teamPartnerCapability,
          teamShareCapability,
          teamSharedAgentsCapability,
          ...(config.identity.nativeOAuth
            ? ["native-oauth", "team-session-exchange-v1", "team-native-browser-return-v1"]
            : []),
          "notification-preview-v1",
          "team-hosted-bootstrap-v1",
          "team-reusable-invites-v1",
          "team-invite-native-continuation-v1",
        ],
      }),
    );
    const identityHandlers = createIdentityRpcHandlers(authenticator);
    const handlers: Partial<HostApiHandlers> = Object.fromEntries(
      Object.entries(identityHandlers).filter(([name]) =>
        (teamIdentityRpcNames as readonly string[]).includes(name),
      ),
    );
    registerHostApi(app, authenticator, handlers, {
      kind: "team",
      dispatch: async (name, raw, request) =>
        team.rpc(toWebHeaders(request.headers), name, raw, () =>
          authenticator.authenticateSession(request.headers, {
            mutation: name === "commands.dispatch",
          }),
        ),
    });
    registerIdentityRoutes(app, authenticator, {
      assertOwner: async (userId) => {
        await database.transaction().execute((t) => access.admin(t, { kind: "human", userId }));
      },
    });
    registerTeamSetupRoutes(app, {
      identity,
      hosted: admission,
      invites: team.invites,
      teamName: config.deploymentName ?? "Team",
      accountPortalOrigin: config.portalOrigin?.origin ?? "https://app.opensteer.com",
    });
    if (config.identity.nativeOAuth)
      registerTeamSessionExchangeRoute(app, { identity, members: team.members });
    registerTeamBinaryRoutes(app, {
      files: team.files,
      access,
      authenticate: (request, mutation) =>
        authenticator.authenticateSession(request.headers, { mutation }),
    });
    await registerTeamLinkRoutes(app, machine.endpoint, machine.binary);
    registerTeamPartnerRoutes(app, partners);
    app.get(
      "/v1/realtime",
      {
        websocket: true,
        preValidation: async (request) => {
          await authenticator.authenticateSession(request.headers);
        },
      },
      (socket, request) => {
        socket.pause();
        void (async () => {
          const session = await authenticator.authenticateSession(request.headers);
          const peer = team.realtime.connect(
            { kind: "human", userId: session.user.id },
            {
              send: (frame) => {
                if (socket.readyState !== 1 || socket.bufferedAmount > 1024 * 1024) return false;
                socket.send(JSON.stringify(frame));
                return true;
              },
              close: (code, reason) => socket.close(code, reason),
            },
          );
          const expiration = setTimeout(
            () => socket.close(1008, "Session expired"),
            Math.max(0, Date.parse(session.expiresAt) - Date.now()),
          );
          expiration.unref();
          let receiving = Promise.resolve(),
            queuedBytes = 0,
            queuedFrames = 0;
          socket.on("message", (raw) => {
            const frame = raw.toString(),
              bytes = Buffer.byteLength(frame);
            if (++queuedFrames > 64 || (queuedBytes += bytes) > 1024 * 1024) {
              socket.close(1012, "Team input buffer exceeded");
              return;
            }
            receiving = receiving
              .then(async () => {
                if (socket.readyState !== 1) return;
                const fresh = await authenticator.authenticateSession(request.headers);
                await access.withHumanSession(fresh, () => peer.receive(JSON.parse(frame)));
              })
              .catch((error: unknown) =>
                socket.close(
                  1008,
                  error instanceof OpensteerError && error.reason === "api-version-mismatch"
                    ? "Update Opensteer for shared channels"
                    : "Team frame refused",
                ),
              )
              .finally(() => {
                queuedFrames--;
                queuedBytes -= bytes;
              });
          });
          socket.once("close", () => {
            clearTimeout(expiration);
            peer.close();
          });
          socket.resume();
        })().catch(() => socket.close(1008, "Team session refused"));
      },
    );
    if (config.webDistribution)
      (
        await HostStaticDistribution.load({
          ...config.webDistribution,
          expectedBuildId: personalWebBuildId,
        })
      ).register(app);
    await app.ready();
    await bus.start();
    await partners.start();
    await publishDirectory();
    ready = true;
    let closing: Promise<void> | undefined;
    const drainDelayMs = options.teamDrainDelayMs ?? 5_000;
    const drainDeadlineMs = options.teamDrainDeadlineMs ?? 60_000;
    return {
      kind: "team",
      app,
      deployment,
      team,
      listen: () => app.listen({ host: config.bindAddress, port: config.port }),
      closingStep: () => step,
      drain: async () => {
        if (draining) return;
        step = "draining";
        draining = true;
        app.server.closeIdleConnections();
        await delay(drainDelayMs);
        // Clients move to another copy; 1012 tells them it's a restart, not a refusal.
        team.relocate(1012);
      },
      close: () =>
        (closing ??= (async () => {
          draining = true;
          stopped = true;
          stopping.abort();
          const failures: unknown[] = [];
          const http = async () => {
            const deadline = setTimeout(() => app.server.closeAllConnections(), drainDeadlineMs);
            deadline.unref();
            try {
              await app.close();
            } finally {
              clearTimeout(deadline);
            }
          };
          detachAccount();
          detachAccountResync();
          // HTTP first: admitted uploads and downloads finish before their services close.
          for (const [name, close] of [
            ["http", http],
            ["link lifetimes", () => lifetimes.stop()],
            ["partner transports", () => partners?.close()],
            ["team transports", () => team.close()],
            ["link endpoint", () => machine?.endpoint.close()],
            ["Account directory", () => directory?.close()],
            ["Account authority", () => authority?.close()],
            ["team bus", () => bus.close()],
            ["database", () => database.destroy()],
          ] as const) {
            step = name;
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, "Team Host shutdown failed");
          step = undefined;
        })()),
    };
  } catch (error) {
    stopped = true;
    stopping.abort();
    lifetimes.stop();
    await Promise.allSettled([
      partners?.close(),
      services?.close(),
      machine?.endpoint.close(),
      app.close(),
      directory?.close(),
      authority?.close(),
    ]);
    await bus.close();
    throw error;
  }
}
function accountProvider(account: NonNullable<HostConfig["account"]>): OidcProviderConfiguration {
  return {
    providerId: officialOpensteerAccountProviderId,
    label: "Opensteer",
    issuer: account.issuer.origin,
    clientId: account.oidcClientId,
    clientSecret: account.oidcClientSecret,
    allowPrivateNetwork: false,
    trustedOrigins: [],
  };
}
function accountFromBundle(bundle: HostAccountAdoptionBundle): NonNullable<HostConfig["account"]> {
  return {
    provisioningMode: "adoption",
    reachability: "canonical",
    controlApiOrigin: new URL(bundle.controlApiOrigin),
    hostCredential: bundle.hostCredential,
    issuer: new URL(bundle.oidc.issuer),
    oidcClientId: bundle.oidc.clientId,
    oidcClientSecret: bundle.oidcClientSecret,
  };
}
