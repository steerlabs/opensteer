import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelSelectionSchema,
  WorkspaceIdSchema,
  createId,
  deploymentSupportsSharing,
  type DeploymentDisplayKind,
  type DeploymentShape,
  type EnvironmentId,
  type HostExposure,
} from "@opensteer/core";
import { slackChannelProviderManifest } from "@opensteer/channel-core";
import type { HostConfig } from "@opensteer/config";
import {
  HostDescriptorSchema,
  hostApiVersion,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  HarnessInstanceCatalogSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  SessionExchangeCredentialKindSchema,
  SessionExchangeResponseSchema,
  sessionExchangePath,
  type HostToRunnerMessage,
  type RunnerConnectionFence,
  type RunnerLocalStorageInventory,
  type RunnerOperationalMessage,
  type SessionExchangeCredentialKind,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import type { HTTPMethods } from "fastify";
import { exportJWK } from "jose";
import { sql } from "kysely";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostRuntime, type HostRuntime } from "./runtime.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { fetchWithExplicitHost } from "../access/session-exchange.test-support.js";
import { startPortableFsManagerFake } from "./portablefs-manager.test-support.js";
import { attachLocalWorkspaceDisk } from "../workspace/runner-local-workspace.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const setupEnrollmentToken = "conformance-setup".padEnd(40, "s");
const localOwnerClaimToken = "conformance-owner-claim".padEnd(32, "c");
const accountIssuer = new URL("https://accounts.conformance.opensteer.test");
const accountSigningKeyId = "conformance-account-key";
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

/**
 * Every route whose presence is a structural fact about a Deployment rather
 * than a runtime permission check. Presence is read from the Fastify route
 * table rather than probed over HTTP, because several of these routes answer
 * 404 *while registered* in order not to advertise themselves.
 */
const routeProbes = {
  authSessions: { method: "GET", url: "/v1/rpc/sessions.list" },
  bootstrap: { method: "GET", url: "/v1/rpc/bootstrap.get" },
  discovery: { method: "GET", url: "/.well-known/opensteer" },
  localBootstrap: { method: "GET", url: "/v1/local-bootstrap" },
  mountGrantExchange: { method: "POST", url: "/internal/v1/mount-grants/exchange" },
  personalAccessRoute: { method: "GET", url: "/.well-known/opensteer/personal-access-route" },
  personalPairingCodes: { method: "POST", url: "/v1/personal-remote-access/pairing-codes" },
  personalRemoteAccess: { method: "GET", url: "/v1/personal-remote-access" },
  runnerEnrollments: { method: "POST", url: "/v1/rpc/commands.dispatch" },
  sessionExchange: { method: "POST", url: sessionExchangePath },
  setupClaim: { method: "POST", url: "/v1/rpc/auth.setup.claim" },
  workspaces: { method: "POST", url: "/v1/rpc/commands.dispatch" },
} as const satisfies Record<string, { readonly method: HTTPMethods; readonly url: string }>;

type RouteProbeName = keyof typeof routeProbes;

/** Routes every shipped configuration answers on. */
const universalRoutes = {
  authSessions: true,
  bootstrap: true,
  discovery: true,
  runnerEnrollments: true,
  setupClaim: true,
  workspaces: true,
} as const;

/** Routes that exist only for the Personal loopback remote-access family. */
const personalRemoteAccessRoutes = {
  personalAccessRoute: true,
  personalPairingCodes: true,
  personalRemoteAccess: true,
} as const;

const noPersonalRemoteAccessRoutes = {
  personalAccessRoute: false,
  personalPairingCodes: false,
  personalRemoteAccess: false,
} as const;

interface ConfigurationPlan {
  /** Whether this configuration lets somebody lend it a machine from outside
   * its own network. PortableFS exists for exactly that, and a Personal
   * Deployment is single-user, so the two are never the same answer. */
  readonly acceptsExternalRunners: boolean;
  readonly displayKind: DeploymentDisplayKind;
  readonly exposure: HostExposure;
  readonly routes: Record<RouteProbeName, boolean>;
  readonly sessionExchangeArms: readonly SessionExchangeCredentialKind[];
  readonly shape: DeploymentShape;
  readonly sharingAvailable: boolean;
}

const shippedConfigurations = [
  "personal",
  "dev",
  "self-host-local",
  "self-host-portablefs",
] as const;
type ShippedConfiguration = (typeof shippedConfigurations)[number];

const conformancePlans = {
  personal: {
    acceptsExternalRunners: false,
    displayKind: "personal",
    exposure: "loopback",
    routes: {
      ...universalRoutes,
      ...personalRemoteAccessRoutes,
      localBootstrap: true,
      mountGrantExchange: false,
      sessionExchange: true,
    },
    sessionExchangeArms: ["account-connect-grant", "personal-pairing-code"],
    shape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
    sharingAvailable: false,
  },
  dev: {
    acceptsExternalRunners: false,
    displayKind: "development",
    exposure: "loopback",
    routes: {
      ...universalRoutes,
      ...noPersonalRemoteAccessRoutes,
      localBootstrap: true,
      mountGrantExchange: false,
      sessionExchange: false,
    },
    sessionExchangeArms: [],
    shape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    },
    sharingAvailable: true,
  },
  "self-host-local": {
    acceptsExternalRunners: false,
    displayKind: "self-hosted",
    exposure: "networked",
    routes: {
      ...universalRoutes,
      ...noPersonalRemoteAccessRoutes,
      localBootstrap: false,
      mountGrantExchange: false,
      sessionExchange: false,
    },
    sessionExchangeArms: [],
    shape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    },
    sharingAvailable: true,
  },
  "self-host-portablefs": {
    acceptsExternalRunners: true,
    displayKind: "self-hosted",
    exposure: "networked",
    routes: {
      ...universalRoutes,
      ...noPersonalRemoteAccessRoutes,
      localBootstrap: false,
      mountGrantExchange: true,
      sessionExchange: false,
    },
    sessionExchangeArms: [],
    shape: {
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    },
    sharingAvailable: true,
  },
} as const satisfies Record<ShippedConfiguration, ConfigurationPlan>;

integration("shipped configuration conformance", () => {
  it("keeps one expected answer for every shipped configuration", () => {
    expect(Object.keys(conformancePlans).sort()).toEqual([...shippedConfigurations].sort());
  });

  for (const configuration of shippedConfigurations) {
    describeConfigurationConformance(configuration, conformancePlans[configuration]);
  }
});

/**
 * The Personal stack's fourth supervised process, from the Host's side.
 *
 * The desktop app mints this token, keeps it in its protected store and hands
 * it to the Host on every start (`docs/messaging.md` §7), so the Host enrols a
 * Deployment-owned messaging Runner from it at startup. That Runner is not a
 * computer anybody lent this Deployment: it runs on this same Mac, reaches the
 * Host over loopback, and is admitted whatever remote access says. Both halves
 * are asserted here because both refused it before — startup mints the grant
 * and every reconnect rechecks it.
 */
integration("a Personal Deployment's supervised messaging service", () => {
  const messagingEnrollmentToken = "conformance-messaging".padEnd(48, "m");
  let composition: Awaited<ReturnType<typeof composeHost>> | undefined;
  let owner: OwnerContext | undefined;

  beforeAll(async () => {
    await resetHostDatabase();
    // Composing at all is half the claim: the Host writes this enrollment
    // while it starts, so a Deployment that refuses the grant never listens.
    composition = await composeHost("personal", conformancePlans.personal, {
      messagingEnrollmentToken,
    });
    owner = await establishOwner(composition, conformancePlans.personal);
  }, 60_000);

  afterAll(async () => {
    await composition?.close();
    composition = undefined;
    owner = undefined;
  });

  it("admits it with remote access off, and admits it again when it reconnects", async () => {
    const held = owner;
    if (!held) throw new Error("The Personal Host was not composed.");
    const keys = generateKeyPairSync("ed25519");
    const runnerId = createId("runner");

    const first = await attachMessagingRunner(held.origin, runnerId, {
      keys,
      token: messagingEnrollmentToken,
    });
    expect(first.welcome).toMatchObject({ runnerId, type: "host.welcome" });
    first.socket.close();

    // Remote access is off throughout — `resetHostDatabase` leaves it off and
    // nothing here turns it on — so the reconnect is the reauthentication path
    // that refused this service once it had an identity to present.
    const second = await attachMessagingRunner(held.origin, runnerId, { keys });
    expect(second.welcome).toMatchObject({ runnerId, type: "host.welcome" });

    const machines = await testRpcData(
      held.origin,
      "machines.list",
      {},
      { headers: held.ownerHeaders },
    );
    expect(
      machines.machines.find((machine: { id: string }) => machine.id === runnerId),
    ).toMatchObject({ allowedModules: ["integrations", "messaging", "shell"] });
    second.socket.close();
  });
});

/**
 * Enrols or reauthenticates the messaging service on the primary Runner socket.
 *
 * The first call has no identity key yet and redeems the configured token; a
 * later one proves the key it kept, which is the path a restarted service
 * takes.
 */
async function attachMessagingRunner(
  origin: string,
  runnerId: ReturnType<typeof createId<"runner">>,
  credentials: {
    readonly keys: { readonly privateKey: KeyObject; readonly publicKey: KeyObject };
    readonly token?: string;
  },
): Promise<{ readonly socket: WebSocket; readonly welcome: { readonly type: string } }> {
  const connection = await openRunnerSocket(
    `${origin.replace(/^http/u, "ws")}/internal/v1/runners`,
  );
  const challenge = RunnerChallengeSchema.parse(connection.challenge);
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [],
    modules: {
      messaging: {
        capabilities: [
          {
            manifest: slackChannelProviderManifest,
            provider: "slack",
            transportKinds: ["socket"],
          },
        ],
      },
    },
    name: "Messaging service",
    runnerId,
    runnerKind: "managed",
    runtimeVersion: "conformance",
  });
  if (credentials.token === undefined) {
    connection.socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        descriptor,
        signature: createRunnerAuthenticationSignature(credentials.keys.privateKey, {
          challenge,
          descriptor,
        }),
        proofFormatVersion: 2,
        type: "runner.authenticate",
      }),
    );
  } else {
    const publicKeyPem = credentials.keys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const credential = RunnerEnrollmentCredentialSchema.parse({
      enrollmentToken: credentials.token,
      kind: "host-enrollment-token",
    });
    connection.socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        credential,
        descriptor,
        publicKeyPem,
        signature: createRunnerEnrollmentSignature(credentials.keys.privateKey, {
          challenge,
          credential,
          descriptor,
          publicKeyPem,
        }),
        proofFormatVersion: 2,
        type: "runner.enroll",
      }),
    );
  }
  const welcome = await waitForMessage(
    connection.socket,
    (message) => message.type === "host.welcome",
  );
  announceNoExecutions(connection.socket, welcome);
  return { socket: connection.socket, welcome };
}

/** Everything the owner protocol establishes, before any machine is attached. */
interface OwnerContext {
  /** The public authority this Deployment signs and every client pins. */
  readonly canonicalOrigin: string;
  readonly environmentId: EnvironmentId;
  /** Where this process actually listens behind its canonical origin. */
  readonly origin: string;
  readonly ownerHeaders: Record<string, string>;
  readonly runnerEnrollmentToken: string;
  readonly runnerKind: "local" | "main";
  readonly runtime: HostRuntime;
}

interface ConfigurationContext extends OwnerContext {
  readonly homeWorkspaceId: string;
}

/** The Runner transcript the enrollment conformance claim is made against. */
interface RunnerAttachment {
  readonly challenge: ReturnType<typeof RunnerChallengeSchema.parse>;
  readonly runnerId: string;
  readonly socket: WebSocket;
  readonly welcome: { readonly runnerId?: string; readonly type: string };
}

function describeConfigurationConformance(
  configuration: ShippedConfiguration,
  plan: ConfigurationPlan,
): void {
  const shape = plan.shape;

  describe(configuration, () => {
    let composition: Awaited<ReturnType<typeof composeHost>> | undefined;
    let context: ConfigurationContext | undefined;
    let attachment: RunnerAttachment | undefined;
    let machinelessBootstrap: Awaited<ReturnType<typeof readBootstrap>> | undefined;

    beforeAll(async () => {
      await resetHostDatabase();
      composition = await composeHost(configuration, plan);
      const owner = await establishOwner(composition, plan);
      // Read once with an owner but no machine: what a Deployment can answer
      // before anything attaches is its own conformance claim, asserted below.
      machinelessBootstrap = await readBootstrap(owner);
      // The Main Workspace of a local-directory Deployment lives on the
      // Runner's disk, so the machine attaches before there is anything to
      // read. The transcript it produced is asserted below, where it belongs.
      attachment = await attachConformanceRunner(owner, plan);
      const bootstrap = await readBootstrap(owner);
      if (!bootstrap.homeWorkspace) throw new Error("Main Workspace is missing.");
      context = { ...owner, homeWorkspaceId: bootstrap.homeWorkspace.id };
    }, 60_000);

    afterAll(async () => {
      attachment?.socket.close();
      attachment = undefined;
      await composition?.close();
      composition = undefined;
      context = undefined;
    });

    const held = () => {
      if (!context) throw new Error(`The ${configuration} Host was not composed.`);
      return context;
    };

    const heldRunner = () => {
      if (!attachment) throw new Error(`The ${configuration} Runner was not attached.`);
      return attachment;
    };

    it("holds no AI engine and no machine-held Workspace until a Runner attaches", () => {
      if (!machinelessBootstrap) throw new Error(`The ${configuration} Host was not composed.`);
      // Profiles belong to an execution environment and are seeded from the
      // capabilities of its real Runner, never globally before one connects.
      expect(machinelessBootstrap.harnesses).toEqual([]);
      // A local directory is a fact about one machine's disk, so not even Main
      // can exist before that machine does. PortableFS is Host-managed and is
      // there the moment the owner is.
      expect(machinelessBootstrap.homeWorkspace).toEqual(
        shape.defaultWorkspaceBacking === "local-directory"
          ? null
          : expect.objectContaining({ kind: "main" }),
      );
    });

    it("serves a verifiable discovery document with the required public axes", async () => {
      const { canonicalOrigin, origin } = held();
      const envelope = HostDescriptorSchema.parse(
        await jsonFetch(`${origin}/.well-known/opensteer`),
      ).authority;
      const document = verifyHostDiscoveryEnvelope(envelope);
      expect(document.canonicalOrigin).toBe(canonicalOrigin);
      expect(document.deploymentShape).toEqual(shape);
      expect(document.hostKey.algorithm).toBe("Ed25519");
    });

    it("answers /v1/bootstrap only with a session, in one shape", async () => {
      const { homeWorkspaceId, origin, ownerHeaders } = held();
      const anonymous = await testRpcRequest(origin, "bootstrap.get", {});
      expect(anonymous.status).toBe(401);

      const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: ownerHeaders });
      expect(bootstrap.user.instanceRole).toBe("administrator");
      expect(bootstrap.homeWorkspace).toMatchObject({ id: homeWorkspaceId, kind: "main" });
      // Display projection and signed authority share the same deployment facts.
      expect(bootstrap.identityConfig.deployment.kind).toBe(plan.displayKind);
      expect(bootstrap.identityConfig.exposure).toBe(plan.exposure);
      expect(bootstrap.workspaceSharingAvailable).toBe(plan.sharingAvailable);
      expect(bootstrap.workspaceSharingAvailable).toBe(deploymentSupportsSharing(shape));
    });

    it("lists the established owner session", async () => {
      const { origin, ownerHeaders } = held();
      const anonymous = await testRpcRequest(origin, "sessions.list", {});
      expect(anonymous.status).toBe(401);

      const listed = await testRpcData(origin, "sessions.list", {}, { headers: ownerHeaders });
      expect(Array.isArray(listed.sessions)).toBe(true);
      expect(listed.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it("registers exactly the routes this configuration implies", () => {
      const { runtime } = held();
      const actual = Object.fromEntries(
        Object.entries(routeProbes).map(([name, probe]) => [
          name,
          runtime.app.hasRoute({ method: probe.method, url: probe.url }),
        ]),
      );
      expect(actual).toEqual(plan.routes);
    });

    it("honours exactly this configuration's session-exchange arms", async () => {
      const { origin, runtime } = held();
      const arms = new Set<SessionExchangeCredentialKind>(plan.sessionExchangeArms);
      expect(runtime.app.hasRoute({ method: "POST", url: sessionExchangePath })).toBe(
        arms.size > 0,
      );

      for (const kind of SessionExchangeCredentialKindSchema.options) {
        const response = await fetch(`${origin}${sessionExchangePath}`, {
          body: JSON.stringify({
            credential: wellFormedCredential(kind),
            credentialDelivery: "cookie",
            schemaVersion: 2,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const body = (await response.json()) as {
          error?: { code?: string; message?: string };
          message?: string;
        };
        if (arms.size === 0) {
          // No exchangeable trust root at all: the absence is a routing fact,
          // not a per-credential rejection.
          expect(response.status).toBe(404);
          expect(body.message).toContain("not found");
          continue;
        }
        if (!arms.has(kind)) {
          expect(response.status).toBe(404);
          expect(body.error).toMatchObject({
            code: "not_found",
            message: `This Opensteer does not accept the ${kind} credential`,
          });
          continue;
        }
        // An arm that exists reaches its verifier, which refuses this
        // deliberately invalid proof — never the structural "no such arm".
        expect(response.status).toBe(403);
        expect(body.error?.message).not.toContain("does not accept");
      }
    });

    it("creates a Workspace alongside Main and lists both", async () => {
      const { homeWorkspaceId, origin, ownerHeaders } = held();
      const created = await testRpcData(
        origin,
        "commands.dispatch",
        {
          idempotencyKey: "conformance-workspace-1",
          name: "Conformance workspace",
          type: "workspace.create",
        },
        { headers: ownerHeaders },
      );
      if (created.type !== "workspace.create") throw new Error("Workspace command mismatch.");
      expect(created.workspace).toMatchObject({ kind: "specialized", status: "ready" });

      const replayed = await testRpcData(
        origin,
        "commands.dispatch",
        {
          idempotencyKey: "conformance-workspace-1",
          name: "Conformance workspace",
          type: "workspace.create",
        },
        { headers: ownerHeaders },
      );
      if (replayed.type !== "workspace.create") throw new Error("Workspace command mismatch.");
      expect(replayed.workspace.id).toBe(created.workspace.id);

      const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: ownerHeaders });
      const workspaceIds = bootstrap.workspaces.map((workspace: { id: string }) => workspace.id);
      expect(workspaceIds).toContain(created.workspace.id);
      expect(bootstrap.homeWorkspace?.id).toBe(homeWorkspaceId);
      createdWorkspaceIds.set(configuration, created.workspace.id as string);
    });

    it("enrols a Main Runner through the same challenge, proof, and welcome transcript", async () => {
      const context_ = held();
      const { challenge, runnerId, welcome } = heldRunner();
      expect(challenge).toMatchObject({ type: "host.challenge" });
      expect(challenge.nonce.length).toBeGreaterThan(0);
      expect(welcome).toMatchObject({ runnerId, type: "host.welcome" });

      await expect
        .poll(
          async () => {
            const current = await testRpcData(
              context_.origin,
              "bootstrap.get",
              {},
              {
                headers: context_.ownerHeaders,
              },
            );
            return {
              environments: current.environments as Array<{ connected: boolean; id: string }>,
              harnesses: current.harnesses as Array<{
                driverKind: string;
                environmentId: string;
                name: string;
                stateKind: string;
              }>,
            };
          },
          { timeout: 15_000 },
        )
        .toEqual({
          environments: [expect.objectContaining({ connected: true, id: context_.environmentId })],
          harnesses: [
            expect.objectContaining({
              driverKind: "codex",
              environmentId: context_.environmentId,
              name: "Codex",
              stateKind: "ambient",
            }),
          ],
        });
    });

    it("carries a Run to completion with this configuration's Workspace access plan", async () => {
      const { environmentId, origin, ownerHeaders, runtime } = held();
      const socket = heldRunner().socket;
      const createdId = createdWorkspaceIds.get(configuration);
      if (!createdId) throw new Error("The conformance Workspace was not created.");
      const workspaceId = WorkspaceIdSchema.parse(createdId);
      const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: ownerHeaders });
      const harnessInstanceId = bootstrap.harnesses.find(
        (harness: { driverKind: string; environmentId: string }) =>
          harness.driverKind === "codex" && harness.environmentId === environmentId,
      )?.id as string | undefined;
      if (!harnessInstanceId) throw new Error("The Runner's Codex profile was not seeded.");

      const threadResult = await testRpcData(
        origin,
        "commands.dispatch",
        {
          environmentId,
          harnessInstanceId,
          idempotencyKey: "conformance-thread-1",
          modelSelection: testModelSelection,
          title: "Conformance turn",
          type: "thread.create",
          workspaceId,
        },
        { headers: ownerHeaders },
      );
      if (threadResult.type !== "thread.create") throw new Error("Thread command mismatch.");
      const threadId = threadResult.thread.id as string;

      const execution = waitForRunExecution(socket);
      const turn = await testRpcData(
        origin,
        "commands.dispatch",
        {
          content: [{ text: "Do the conformance work", type: "text" }],
          idempotencyKey: "conformance-message-1",
          threadId,
          type: "thread.sendMessage",
        },
        { headers: ownerHeaders },
      );
      if (turn.type !== "thread.sendMessage" || !turn.run)
        throw new Error("Message command mismatch.");
      expect(turn.run.status).toBe("queued");

      const dispatched = await execution;
      const command = dispatched.command;
      const fence = runnerFence(dispatched);
      expect(command.context.threadId).toBe(threadId);
      expect(command.context.workspaceId).toBe(workspaceId);
      // Workspace access names the backing the Runner must operate.
      expect(command.context.workspaceAccess.kind).toBe(shape.defaultWorkspaceBacking);

      socket.send(
        JSON.stringify({
          ...fence,
          commandId: command.commandId,
          correlationId: command.correlationId,
          type: "runner.command-accepted",
        }),
      );
      const base = {
        bindingGeneration: command.context.bindingGeneration,
        emittedAt: new Date().toISOString(),
        environmentId,
        runId: command.context.runId,
        threadId,
        workspaceId,
      };
      socket.send(
        JSON.stringify({
          ...fence,
          bindingGeneration: command.context.bindingGeneration,
          harnessInstanceId: command.context.harnessInstanceId,
          providerSessionId: command.context.providerSessionId,
          providerSessionReference: "codex:00000000-0000-4000-8000-000000000001",
          runId: command.context.runId,
          threadId,
          type: "runner.session-bound",
        }),
      );
      for (const event of [
        { ...base, data: { status: "running" }, ordinal: 0, type: "run.started" },
        {
          ...base,
          data: {
            content: [{ text: "Finished through the Runner.", type: "text" }],
            messageId: createId("message"),
          },
          ordinal: 1,
          type: "assistant.message",
        },
        { ...base, data: { status: "completed" }, ordinal: 2, type: "run.completed" },
      ]) {
        socket.send(JSON.stringify({ ...fence, event, type: "runner.event" }));
      }

      await expect
        .poll(async () => (await runtime.store.workspaceSnapshot(workspaceId)).threads[0]?.status, {
          timeout: 15_000,
        })
        .toBe("idle");
      const snapshot = await runtime.store.workspaceSnapshot(workspaceId);
      expect(snapshot.messages.at(-1)?.content).toEqual([
        { text: "Finished through the Runner.", type: "text" },
      ]);
    });

    if (plan.sessionExchangeArms.includes("personal-pairing-code")) {
      it("admits a remote session through the real personal-pairing-code arm", async () => {
        const { origin, ownerHeaders } = held();
        const routeOrigin = "https://conformance.tailnet.example";
        const configured = await fetch(`${origin}/v1/personal-remote-access`, {
          body: JSON.stringify({ mode: "private", routeOrigin, schemaVersion: 1 }),
          headers: { ...ownerHeaders, "content-type": "application/json" },
          method: "PUT",
        });
        expect(configured.status).toBe(200);

        const envelope = PersonalHostAccessRouteEnvelopeSchema.parse(
          await jsonFetch(`${origin}/.well-known/opensteer/personal-access-route`),
        );
        const pairing = await jsonFetch(`${origin}/v1/personal-remote-access/pairing-codes`, {
          body: "{}",
          headers: { ...ownerHeaders, "content-type": "application/json" },
          method: "POST",
        });
        const body = JSON.stringify({
          credential: {
            code: pairing.code,
            expectedRoute: envelope.document,
            kind: "personal-pairing-code",
          },
          credentialDelivery: "cookie",
          schemaVersion: 2,
        });
        // The signed route is compared against the authority the request
        // arrived on, which the trusted ingress states, not an Origin header.
        const ingress = {
          "content-type": "application/json",
          host: new URL(routeOrigin).host,
          "x-forwarded-proto": "https",
        };
        const paired = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
          body,
          headers: ingress,
          method: "POST",
        });
        expect(paired.status, await paired.clone().text()).toBe(200);
        expect(
          SessionExchangeResponseSchema.parse(await paired.json()).session.user.instanceRole,
        ).toBe("administrator");

        const replayed = await fetchWithExplicitHost(`${origin}${sessionExchangePath}`, {
          body,
          headers: ingress,
          method: "POST",
        });
        expect(replayed.status).toBe(403);
      });
    }
  });
}

const createdWorkspaceIds = new Map<ShippedConfiguration, string>();

interface HostComposition {
  readonly close: () => Promise<void>;
  readonly config: HostConfig;
  readonly environmentId: EnvironmentId;
  /** The socket this process answers on, behind whatever origin it declares. */
  readonly listenOrigin: string;
  readonly runtime: HostRuntime;
}

/**
 * Builds the single-process approximation of each configuration: the same
 * Host code and fakes only where the
 * Deployment genuinely talks to something outside itself (the PortableFS
 * Manager and the Account issuer's JWKS for Personal Connect).
 */
async function composeHost(
  configuration: ShippedConfiguration,
  plan: ConfigurationPlan,
  /** What a supervisor minted for a service it starts beside this Host. */
  supervised: { readonly messagingEnrollmentToken?: string } = {},
): Promise<HostComposition> {
  const shape = plan.shape;
  const port = await freePort();
  // The native filesystem authority rejects symlinked parents, and macOS
  // exposes `tmpdir()` through a symlink, so canonicalize before use.
  const dataDirectory = await realpath(
    await mkdtemp(join(tmpdir(), `opensteer-conformance-${configuration}-`)),
  );
  const environmentId = createId("environment");
  const portableFs =
    shape.defaultWorkspaceBacking === "portablefs" ? await startPortableFsManagerFake() : undefined;
  const canonicalOrigin =
    plan.exposure === "loopback"
      ? new URL(`http://127.0.0.1:${port}`)
      : new URL(`https://${configuration}.conformance.opensteer.test`);
  // A PortableFS Deployment mints every Runner capability URL from its
  // canonical origin, which is the same rule config parsing enforces.
  const runtimeOrigin =
    shape.defaultWorkspaceBacking === "portablefs"
      ? canonicalOrigin
      : new URL(`http://127.0.0.1:${port}`);
  const personalAccountKeys =
    shape.kind === "personal" ? generateKeyPairSync("ed25519") : undefined;

  const baseConfig: HostConfig = {
    acceptsExternalRunners: plan.acceptsExternalRunners,
    authSecret: `conformance-${configuration}`.padEnd(40, "x"),
    bindAddress: plan.exposure === "loopback" ? "127.0.0.1" : "0.0.0.0",
    canonicalOrigin,
    browserRuntime: { attachKeyId: "host-browser-v1" },
    browserProfileKeyPath: undefined,
    credentialKeyPath: undefined,
    databaseUrl: databaseUrl ?? "postgres://unconfigured",
    dataDirectory,
    exposure: plan.exposure,
    identity: {
      initialOwnerEnrollment:
        plan.exposure === "networked"
          ? { lifetimeSeconds: 3_600, token: setupEnrollmentToken }
          : undefined,
      ...(shape.kind === "personal" ? { localOwnerClaimToken } : {}),
      localPasswordEnabled: shape.kind === "server",
      oidcConfigPath: undefined,
      signupPolicy: "invite-only",
    },
    ...(supervised.messagingEnrollmentToken
      ? { initialMessagingRunnerEnrollmentToken: supervised.messagingEnrollmentToken }
      : {}),
    executionLeaseMs: 90_000,
    maxConcurrentDispatches: 4,
    maxConcurrentTriggerDispatches: 4,
    mode: "development",
    port,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin,
    // A Personal Host that has pinned no Account issuer still registers the
    // Account arm of the session exchange, so pin one: the conformance claim is
    // about arms that can actually be honoured.
    ...(personalAccountKeys ? { personalAccountIssuer: accountIssuer } : {}),
    workspace: {
      deletionRetentionDays: 14,
      shape,
      storage:
        shape.defaultWorkspaceBacking === "local-directory"
          ? {
              kind: "local-directory",
              ownerEnvironmentId: environmentId,
            }
          : {
              archiveAfterDays: 7,
              authorizationDomain: "opensteer-test",
              defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
              defaultInodeLimit: 1_000_000,
              filesServiceUrl: new URL("http://127.0.0.1:4315"),
              kind: "portablefs",
              managerCaPath: undefined,
              managerCertPath: undefined,
              managerKeyPath: undefined,
              managerServerName: undefined,
              managerUrl: portableFs?.url ?? new URL("http://127.0.0.1:9"),
              maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
              maxInodeLimit: 10_000_000,
              productIssuer: "opensteer-test",
              productPrivateKeyPath: undefined,
              serviceId: "conformance-portablefs",
            },
    },
  };

  const runtimeOptions = {
    ...(portableFs ? { portableFsMountManagerEndpoint: portableFs.mountEndpoint } : {}),
    ...(personalAccountKeys
      ? { personalAccountGrantFetch: accountJwksFetch(personalAccountKeys.publicKey) }
      : {}),
  };

  const cleanup = async (runtime: HostRuntime | undefined) => {
    await runtime?.close();
    await portableFs?.close();
    await rm(dataDirectory, { force: true, recursive: true });
  };

  const runtime = await createHostRuntime(baseConfig, runtimeOptions);
  await runtime.listen();
  return {
    close: () => cleanup(runtime),
    config: baseConfig,
    environmentId,
    listenOrigin: `http://127.0.0.1:${port}`,
    runtime,
  };
}

/**
 * Stands in for the Account issuer's JWKS route. The Host's trust root stays
 * real — it verifies a real Ed25519 signature against a real published key —
 * and only the network hop to accounts.opensteer.com is replaced.
 */
function accountJwksFetch(publicKey: KeyObject) {
  return async (): Promise<Response> =>
    Response.json({
      keys: [
        { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: accountSigningKeyId, use: "sig" },
      ],
    });
}

/** Establishes the first owner through the configured protocol. */
async function establishOwner(
  composition: HostComposition,
  plan: ConfigurationPlan,
): Promise<OwnerContext> {
  const origin = composition.listenOrigin;
  const canonicalOrigin = composition.config.canonicalOrigin.origin;
  const owner = await ownerSession(composition, plan);
  // Every client speaks to the canonical authority, whatever socket the
  // Deployment happens to answer on, so that is the Origin the Host must see.
  const ownerHeaders = { cookie: owner.cookies.join("; "), origin: canonicalOrigin };

  const issuedEnrollment = owner.runnerEnrollmentToken
    ? undefined
    : await testRpcData(
        origin,
        "commands.dispatch",
        {
          allowedModules: ["agents"],
          idempotencyKey: "conformance-runner",
          name: "Conformance computer",
          type: "runner.enrollment.createLocal",
        },
        { headers: ownerHeaders },
      );
  if (issuedEnrollment && issuedEnrollment.type !== "runner.enrollment.createLocal") {
    throw new Error("Runner enrollment command mismatch.");
  }
  const runnerEnrollmentToken = owner.runnerEnrollmentToken ?? issuedEnrollment?.token;
  if (!runnerEnrollmentToken) throw new Error("Runner enrollment token is missing.");

  return {
    canonicalOrigin,
    environmentId: composition.environmentId,
    origin,
    ownerHeaders,
    runnerEnrollmentToken,
    runnerKind: owner.runnerEnrollmentToken ? "main" : "local",
    runtime: composition.runtime,
  };
}

async function ownerSession(
  composition: HostComposition,
  plan: ConfigurationPlan,
): Promise<{ readonly cookies: string[]; readonly runnerEnrollmentToken?: string }> {
  const origin = composition.listenOrigin;
  const canonicalOrigin = composition.config.canonicalOrigin.origin;
  if (plan.shape.kind === "personal") {
    const localBootstrap = await jsonFetch(`${origin}/v1/local-bootstrap`, {
      headers: {
        authorization: `Bearer ${localOwnerClaimToken}`,
        origin: canonicalOrigin,
      },
    });
    if (typeof localBootstrap.runnerEnrollmentToken !== "string") {
      throw new Error("Local bootstrap did not provide a Main Runner enrollment token.");
    }
    const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
      body: JSON.stringify({ kind: "local-machine-owner", token: localOwnerClaimToken }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        "content-type": "application/json",
        origin: canonicalOrigin,
      },
      method: "POST",
    });
    if (!claimed.ok) throw new Error(`Local owner claim failed with HTTP ${claimed.status}.`);
    return {
      cookies: responseCookies(claimed),
      runnerEnrollmentToken: localBootstrap.runnerEnrollmentToken,
    };
  }

  const localBootstrap =
    plan.exposure === "networked"
      ? undefined
      : await localBootstrapCredentials(origin, canonicalOrigin);
  const setupToken = localBootstrap?.setupToken ?? setupEnrollmentToken;
  const exchanged = await fetch(`${origin}/v1/rpc/auth.setup.exchange`, {
    body: JSON.stringify({ token: setupToken }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin: canonicalOrigin,
    },
    method: "POST",
  });
  if (!exchanged.ok) throw new Error(`Setup exchange failed with HTTP ${exchanged.status}.`);
  const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({
      email: "owner@conformance.test",
      kind: "password",
      password: "conformance-owner-password",
    }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      cookie: responseCookies(exchanged).join("; "),
      origin: canonicalOrigin,
    },
    method: "POST",
  });
  if (!claimed.ok) {
    throw new Error(`Owner claim failed with HTTP ${claimed.status}: ${await claimed.text()}`);
  }
  return {
    cookies: responseCookies(claimed),
    ...(localBootstrap ? { runnerEnrollmentToken: localBootstrap.runnerEnrollmentToken } : {}),
  };
}

async function localBootstrapCredentials(
  origin: string,
  canonicalOrigin: string,
): Promise<{ readonly runnerEnrollmentToken: string; readonly setupToken: string }> {
  const bootstrap = await jsonFetch(`${origin}/v1/local-bootstrap`, {
    headers: { origin: canonicalOrigin },
  });
  const setupUrl = new URL(bootstrap.setupUrl as string);
  const token = new URLSearchParams(setupUrl.hash.slice(1)).get("token");
  if (!token) throw new Error("Local bootstrap did not provide a setup token.");
  if (typeof bootstrap.runnerEnrollmentToken !== "string") {
    throw new Error("Local bootstrap did not provide a Main Runner enrollment token.");
  }
  return { runnerEnrollmentToken: bootstrap.runnerEnrollmentToken, setupToken: token };
}

/**
 * A schema-valid credential of each kind that no Deployment can honour, so a
 * "this Deployment has no such arm" answer is never confused with a parse
 * failure. The route document is deliberately well formed and untrue.
 */
function wellFormedCredential(kind: SessionExchangeCredentialKind): Record<string, unknown> {
  const grant = `${"e".repeat(40)}.${"y".repeat(40)}.${"s".repeat(40)}`;
  const routeDocument = {
    authority: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
    },
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 1,
      kind: "private",
      origin: "https://conformance-unused.example",
    },
  };
  if (kind === "personal-pairing-code") {
    return { code: `osp_${"P".repeat(43)}`, expectedRoute: routeDocument, kind };
  }
  return {
    expectedRoute: {
      document: routeDocument,
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      schemaVersion: 1,
      signature: "A".repeat(86),
    },
    grant,
    kind,
  };
}

async function resetHostDatabase(): Promise<void> {
  const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
  await migrateToLatest(database);
  await sql`
    truncate table
      personal_remote_session_grant_uses,
      personal_remote_sessions,
      personal_remote_pairing_codes,
      personal_remote_account_link,
      account_directory_provider,
      account_directory_projections,
      auth_rate_limits,
      auth_verifications,
      auth_admissions,
      auth_sso_providers,
      owner_enrollments,
      security_effects,
      security_audit,
      credential_access_audit,
      credential_vault_canaries,
      browser_profile_grants,
      browser_sessions,
      browser_profile_revisions,
      browser_profiles,
      credentials,
      workspace_events,
      commands,
      provider_sessions,
      messages,
      runs,
      threads,
      harness_instances,
      workspaces,
      execution_environments,
      runners,
      deployments,
      users
    restart identity cascade
  `.execute(database);
  await database
    .updateTable("personalRemoteAccess")
    .set({ generation: 0, mode: "off", routeOrigin: null, updatedAt: new Date() })
    .where("singletonKey", "=", "personal")
    .executeTakeFirstOrThrow();
  await sql`
    insert into principals(id, kind, user_id, display_name)
    values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
    on conflict (id) do nothing
  `.execute(database);
  await database.destroy();
}

function readBootstrap(owner: OwnerContext) {
  return testRpcData(owner.origin, "bootstrap.get", {}, { headers: owner.ownerHeaders });
}

/**
 * Attaches this configuration's Runner and keeps the transcript it produced.
 * A local-directory Deployment has no Workspace of any kind until the machine
 * that holds the directories is here, so this runs before the first read.
 */
async function attachConformanceRunner(
  owner: OwnerContext,
  plan: ConfigurationPlan,
): Promise<RunnerAttachment> {
  const connection = await openRunnerSocket(
    `${owner.origin.replace(/^http/u, "ws")}/internal/v1/runners`,
  );
  const challenge = RunnerChallengeSchema.parse(connection.challenge);
  const runnerId = createId("runner");
  respondToHarnessInspections(connection.socket);
  const backing = plan.shape.defaultWorkspaceBacking;
  const welcome = await enrollRunnerSocket(connection.socket, challenge, owner, {
    backing,
    localStorage:
      backing === "local-directory" ? attachLocalWorkspaceDisk(connection.socket).inventory : null,
    runnerId,
  });
  return { challenge, runnerId, socket: connection.socket, welcome };
}

async function enrollRunnerSocket(
  socket: WebSocket,
  challenge: ReturnType<typeof RunnerChallengeSchema.parse>,
  context: OwnerContext,
  runner: {
    readonly backing: "local-directory" | "portablefs";
    readonly localStorage: RunnerLocalStorageInventory | null;
    readonly runnerId: string;
  },
): Promise<{ readonly runnerId?: string; readonly type: string }> {
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    capabilities: [
      "filesystem",
      "native-session-continuation-v1",
      "assignments-v1",
      "steer-answer-v1",
      "browser-page-input-v1",
      "thread-state-v1",
      "requester-time-zone-v1",
      "execution-plane-v2",
    ],
    modules: {
      agents: {
        environmentIds: [context.environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "windows",
                sourceId: "openai",
                stateKinds: ["ambient", "isolated"],
              },
            ],
          },
        ],
        localStorage: runner.localStorage,
        maxConcurrentRuns: 2,
        providerStateModes: ["ambient", "isolated"],
        workspaceBackings: [runner.backing],
        workspaceMounts: [],
      },
    },
    name: "Conformance Main",
    runnerId: runner.runnerId,
    runnerKind: context.runnerKind,
    runtimeVersion: "conformance",
  });
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const credential = RunnerEnrollmentCredentialSchema.parse({
    enrollmentToken: context.runnerEnrollmentToken,
    kind: "host-enrollment-token",
  });
  socket.send(
    JSON.stringify({
      challengeId: challenge.challengeId,
      credential,
      descriptor,
      publicKeyPem,
      signature: createRunnerEnrollmentSignature(pair.privateKey, {
        challenge,
        credential,
        descriptor,
        publicKeyPem,
      }),
      proofFormatVersion: 2,
      type: "runner.enroll",
    }),
  );
  const welcome = await waitForMessage(socket, (message) => message.type === "host.welcome");
  announceNoExecutions(socket, welcome);
  return welcome as { readonly runnerId?: string; readonly type: string };
}

/** A Runner states the Runs it holds before the Host sends it any work. */
function announceNoExecutions(socket: WebSocket, welcome: unknown): void {
  socket.send(
    JSON.stringify({
      ...runnerFence(welcome as RunnerConnectionFence),
      complete: true,
      executions: [],
      type: "runner.executions.attach",
    }),
  );
}

async function openRunnerSocket(
  url: string,
): Promise<{ readonly challenge: unknown; readonly socket: WebSocket }> {
  const socket = new WebSocket(url);
  const challenge = waitForMessage(socket, (message) => message.type === "host.challenge");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { challenge: await challenge, socket };
}

/**
 * The fence the Host stamped on the frame being answered. Every frame in both
 * directions repeats it after authentication, so echoing the one that arrived
 * is exactly what a real Runner does.
 */
function runnerFence(message: RunnerConnectionFence): RunnerConnectionFence {
  return {
    bootId: message.bootId,
    connectionGeneration: message.connectionGeneration,
    connectionId: message.connectionId,
    connectionLeaseId: message.connectionLeaseId,
    runnerId: message.runnerId,
  };
}

function respondToHarnessInspections(socket: WebSocket): void {
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
    if (message.type !== "host.inspect-harnesses" && message.type !== "host.reconcile-harnesses") {
      return;
    }
    socket.send(
      JSON.stringify({
        ...runnerFence(message),
        catalogs: message.harnesses.map((harness) =>
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity: {
              continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
              driverKind: harness.driverKind,
            },
            driverKind: harness.driverKind,
            harnessInstanceId: harness.id,
            models: [
              {
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                modelId: "gpt-5.6-sol",
                options: [
                  {
                    defaultValue: "low",
                    id: "effort",
                    label: "Reasoning effort",
                    type: "select",
                    values: [
                      { label: "Low", value: "low" },
                      { label: "Medium", value: "medium" },
                    ],
                  },
                ],
                providerId: "openai",
              },
            ],
            status: "ready",
          }),
        ) satisfies Extract<
          RunnerOperationalMessage,
          { type: "runner.harness-catalog" }
        >["catalogs"],
        requestId: message.requestId,
        type: "runner.harness-catalog",
      }),
    );
  });
}

function waitForRunExecution(socket: WebSocket): Promise<
  Extract<HostToRunnerMessage, { type: "host.command" }> & {
    readonly command: Extract<
      Extract<HostToRunnerMessage, { type: "host.command" }>["command"],
      { type: "run.execute" }
    >;
  }
> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for run.execute")),
      15_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      if (message.type !== "host.command" || message.command.type !== "run.execute") return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message as Parameters<typeof resolve>[0]);
    };
    socket.on("message", receive);
  });
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: { type: string }) => boolean,
): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket message")),
      15_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as { type: string };
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
