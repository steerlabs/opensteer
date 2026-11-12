import { rejectDuplicateCredentialHeaders } from "../identity/request-credential-headers.js";
import { teamOidcStatePrefix, teamOAuthVersionParameter } from "@opensteer/deployment-authority";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type Deployment, type HostKeyFingerprint } from "@opensteer/core";
import {
  HostDescriptorSchema,
  apiNegotiation,
  minimumTeamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  AccountDirectoryStore,
  NotificationPreviewKeyStore,
  TeamAccessStore,
  appendTeamAudit,
  prepareKnowledgeExecutor,
  teamChannelTopics,
  type DatabaseSchema,
  type DeploymentAuthorityLease,
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
import { createIdentityRpcHandlers, registerIdentityRoutes } from "../identity/identity-routes.js";
import { registerHostApi, carryWebSocketVersion } from "../server/host-api-registration.js";
import { normalizeHostError } from "../server/http-errors.js";
import { HostStaticDistribution } from "../server/static-distribution.js";
import {
  RemoteAccountAdoptionGrantVerifier,
  RemoteHostedTeamOwnerCheckVerifier,
} from "../access/account-adoption-grant-verifier.js";
import { AccountDirectoryClient } from "../access/account-directory-client.js";
import { AccountDirectoryPublisher } from "../access/account-directory-publisher.js";
import { HostAuthorityPublisher } from "../access/host-authority-publisher.js";
import { NotificationPreviewService } from "../notifications/notification-preview-service.js";
import { startTeamKnowledge, type TeamKnowledge } from "../knowledge/team-knowledge.js";
import { startTeamServices, assertTeamApiVersion } from "../team/services.js";
import { registerTeamBinaryRoutes } from "../team/binary-routes.js";
import { registerTeamSetupRoutes } from "../team/setup-routes.js";
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
  authorityLease: DeploymentAuthorityLease;
}): Promise<TeamHostRuntime> {
  const { config, options, database, deployment, keys, hostKeyFingerprint, authorityLease } = input;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const stopping = new AbortController();
  const lifetimes = new TeamLinkLifetimes();
  let services: Awaited<ReturnType<typeof startTeamServices>> | undefined;
  let knowledge: TeamKnowledge | undefined;
  let machine: ReturnType<typeof createTeamLinkEndpoint> | undefined;
  let account = config.account;
  let authority: HostAuthorityPublisher | undefined;
  let directory: AccountDirectoryPublisher | undefined;
  let admitted: TeamIdentityAdmission | undefined;
  let stopped = false;
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
      store: new AccountDirectoryStore(database, { kind: "team" }),
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
    const access = new TeamAccessStore(database);
    let credentials: Awaited<ReturnType<typeof prepareKnowledgeExecutor>> | undefined;
    services = await startTeamServices({
      kind: "team",
      database,
      access,
      teamId: deployment.id,
      teamName: config.deploymentName ?? "Team",
      hostKeyFingerprint,
      origin: deployment.canonicalOrigin,
      dataDirectory: config.dataDirectory,
      storageLimitBytes: config.teamStorageLimitBytes,
      topics: teamChannelTopics,
      ensureKnowledge: async () => {
        credentials = await prepareKnowledgeExecutor(database);
      },
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
        isOnline: (ownerUserId) => machine?.endpoint.isOnline(ownerUserId) ?? false,
      },
      registerPreviewKey: (session, command) =>
        preview.register({ userId: session.user.id, authSessionId: session.id, ...command }),
      generalChannelId: async () => (admitted ? admitted.generalChannelId() : null),
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
    if (!credentials) throw new Error("Knowledge executor credentials are missing");
    knowledge = await startTeamKnowledge({
      database,
      databaseUrl: config.databaseUrl,
      credentials,
      access,
      audit: appendTeamAudit,
    });
    const team = services;
    const adapters = createTeamMachineAdapters(team, knowledge);
    machine = createTeamLinkEndpoint({
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
      installAccountBundle: async (bundle) => {
        await persistAccountBundle(config.accountBundlePath, bundle);
        account = {
          provisioningMode: "adoption",
          reachability: "canonical",
          controlApiOrigin: new URL(bundle.controlApiOrigin),
          hostCredential: bundle.hostCredential,
          issuer: new URL(bundle.oidc.issuer),
          oidcClientId: bundle.oidc.clientId,
          oidcClientSecret: bundle.oidcClientSecret,
        };
        await publishDirectory();
      },
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
    const authenticator = new HostAuthenticator({ identity, publicUrl: config.canonicalOrigin });
    app.setErrorHandler((error, _request, reply) => {
      const normalized = normalizeHostError(error);
      void reply.status(normalized.status).send(normalized.error);
    });
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
        request.url.startsWith("/internal/v1/team/") ||
        request.url.startsWith("/.well-known/openid-configuration") ||
        request.url.startsWith("/.well-known/oauth-authorization-server")
      )
        assertTeamApiVersion(toWebHeaders(request.headers));
    });
    app.addHook("onRequest", async (request) => {
      if (!request.url.startsWith("/v1/rpc/")) await rejectDuplicateCredentialHeaders(request);
    });
    await app.register(websocket, { options: { maxPayload: 512 * 1024 } });
    app.get("/healthz", () => ({ ok: true }));
    app.get("/.well-known/opensteer", () =>
      HostDescriptorSchema.parse({
        ...apiNegotiation("team"),
        minimumApiVersion: minimumTeamApiVersion,
        authority: envelope,
        bootstrapMethods: ["oidc"],
        capabilities: [
          ...(config.identity.nativeOAuth ? ["native-oauth"] : []),
          "notification-preview-v1",
          "team-hosted-bootstrap-v1",
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
      accountPortalOrigin: config.portalOrigin?.origin ?? "https://app.opensteer.com",
    });
    registerTeamBinaryRoutes(app, {
      files: team.files,
      access,
      authenticate: (request, mutation) =>
        authenticator.authenticateSession(request.headers, { mutation }),
    });
    await registerTeamLinkRoutes(app, machine.endpoint, machine.binary);
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
              close: (reason) => socket.close(1008, reason),
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
              socket.close(1008, "Team input buffer exceeded");
              return;
            }
            receiving = receiving
              .then(async () => {
                if (socket.readyState !== 1) return;
                const fresh = await authenticator.authenticateSession(request.headers);
                await access.withHumanSession(fresh, () => peer.receive(JSON.parse(frame)));
              })
              .catch(() => socket.close(1008, "Team frame refused"))
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
    await publishDirectory();
    let closing: Promise<void> | undefined;
    return {
      kind: "team",
      app,
      deployment,
      team,
      authorityLost: authorityLease.lost,
      listen: () => app.listen({ host: config.bindAddress, port: config.port }),
      closingStep: () => step,
      close: () =>
        (closing ??= (async () => {
          stopped = true;
          stopping.abort();
          lifetimes.stop();
          const failures: unknown[] = [];
          for (const [name, close] of [
            ["team transports", () => team.close()],
            ["http", () => app.close()],
            ["Account directory", () => directory?.close()],
            ["Account authority", () => authority?.close()],
            ["knowledge", () => knowledge?.close()],
            ["authority lease", () => authorityLease.close()],
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
      services?.close(),
      app.close(),
      directory?.close(),
      authority?.close(),
      knowledge?.close(),
    ]);
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
async function persistAccountBundle(
  path: string,
  bundle: HostAccountAdoptionBundle,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(bundle));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
