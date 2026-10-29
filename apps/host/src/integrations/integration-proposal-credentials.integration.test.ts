/**
 * Real Host/PostgreSQL proposal, review, connection and repair journey.
 * Asserts refusal of unsafe checks and malformed guidance, approval integrity,
 * credential persistence on failed connection/repair, provider-body redaction,
 * server overrides and unchecked-key copy. The repeatable artifact contains
 * only public presentation and redacted observations.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RequestIdSchema, requestAgentProposedDetail } from "@opensteer/core";
import {
  IntegrationDefinitionSchema,
  IntegrationDefinitionSummarySchema,
  type IntegrationInstallationId,
  type IntegrationServerId,
  createIntegrationId,
  integrationDefinitionSummary,
  integrationProposalSummary,
  IntegrationProposalManifestSchema,
} from "@opensteer/integration-core";
import {
  OpenApiAdapterConfigSchema,
  extractOpenApiTools,
  planLegacyOpenApiToolNames,
} from "@opensteer/integration-adapters/openapi";
import { apiKeyDisclosure, integrationInstallReview } from "@opensteer/client/integrations";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { IntegrationInstallStore, createDatabase } from "@opensteer/database";
import { sql } from "kysely";
import { createHostRuntime } from "../runtime/runtime.js";
import { operation, operations, toolText } from "../runtime/computer-apps.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { integrationGateway } from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startMachineAccessHost,
} from "../runtime/machine-access.test-support.js";

// Count real resolutions inside the adapter; a spy on its barrel misses internal imports.
const resolutions = vi.hoisted(() => ({ count: 0 }));
vi.mock(
  "../../../../packages/integration-adapters/src/openapi/parse.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        Pick<
          typeof import("@opensteer/integration-adapters/openapi"),
          "parseOpenApiDocument" | "resolveOpenApiDocument"
        >
      >();
    return {
      ...actual,
      resolveOpenApiDocument(...args: Parameters<typeof actual.resolveOpenApiDocument>) {
        resolutions.count++;
        return actual.resolveOpenApiDocument(...args);
      },
    };
  },
);

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
const mutableCatalogSpecUrl = "https://openapi.vercel.sh/";
const disclosedOrigin = "https://disclosed.example";
const undisclosedOrigin = "https://undisclosed.example";
const origin = "https://api.proposal.example";
const checkOrigin = "https://keys.proposal.example";
const credential = {
  label: "Vapi private API key",
  description:
    "Dashboard → API Keys → Private key, in the organization that owns your phone numbers.",
  setupUrl: "https://dashboard.proposal.example/keys",
};
const check = { operationId: "checkKey", args: { limit: 1 } };
const description = "Voice AI agents that answer and place phone calls.";
const artifactDirectory =
  process.env.OPENSTEER_PROPOSAL_CREDENTIAL_ARTIFACT_DIR ??
  "/tmp/opensteer-proposal-guidance-artifacts";

type Json = Record<string, unknown>;

integration("proposal credential guidance", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl!);
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);

  // A domain hint can miss Gmail. The complete catalog must still be the
  // recovery path, without creating an unsupported installation or request.
  it("recovers an OAuth-only Gmail refusal through the complete catalog", async () => {
    const isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
    const facts: unknown[] = [];
    const closers: (() => Promise<unknown>)[] = [];
    let passed = false;
    try {
      const host = await startMachineAccessHost(isolated.url);
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Gmail caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "gmail-caller",
          name: "Gmail caller",
        }),
      });
      closers.unshift(() => caller.close());
      const run = await dispatchCallerRun(host, caller, {
        key: "gmail-discovery",
        title: "Read Gmail",
      });
      closers.unshift(() => run.complete());
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const definition = integrationDefinitions.find(({ id }) => id === "google-gmail");
      if (!definition) throw new Error("Gmail is in the catalog");
      const search = async (query: string) => {
        const result = await gateway.call("integration_search", {
          query,
          provider: "spotify",
          limit: 1,
        });
        const catalog = result.catalog as {
          definitionId: string;
          installed: boolean;
        }[];
        const gmail = catalog.find(({ definitionId }) => definitionId === "google-gmail");
        expect(result.guidance).toMatchObject({
          catalog: expect.stringContaining("definitionId is the catalog argument"),
        });
        expect(gmail).toBeDefined();
        facts.push({ query, gmail });
        return gmail;
      };
      expect(await search("read email in Gmail")).toMatchObject({
        installed: false,
      });
      const count = async () => ({
        requests: await host.store.database.selectFrom("requests").select("id").execute(),
        installations: await host.store.database
          .selectFrom("integrationInstallations")
          .select("id")
          .execute(),
      });
      const before = await count();
      const refusal = await gateway.callRaw("integration_propose", {
        kind: "openapi",
        description: "Read and manage Gmail messages.",
        reason: "Read my Gmail",
        source: JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Gmail API", version: "1" },
          servers: [{ url: "https://gmail.googleapis.com" }],
          security: [{ oauth: ["mail.read"] }],
          components: {
            securitySchemes: {
              oauth: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
                    tokenUrl: "https://oauth2.googleapis.com/token",
                    scopes: { "mail.read": "Read mail" },
                  },
                },
              },
            },
          },
          paths: {
            "/gmail/v1/users/me/messages": {
              get: {
                operationId: "listMessages",
                responses: { "200": { description: "Messages" } },
              },
            },
          },
        }),
      });
      facts.push({ refusal });
      expect(refusal.structuredContent).toMatchObject({
        status: "unsupported",
        catalogAlternatives: [],
      });
      expect(toolText(refusal)).toContain(
        "No installation was requested. Call integration_search for this service and inspect its complete catalog. catalogAlternatives contains hints, not every supported integration; an empty list does not mean no built-in exists. If a catalog definition fits, call integration_request with its definitionId as catalog and the access this task needs. If none fits, look for a supported API-credential source or explain the limitation to the user.",
      );
      expect(await count()).toEqual(before);
      await search("Gmail");
      const request = await gateway.call("integration_request", {
        catalog: "google-gmail",
        access: "read",
        reason: "Read the requested Gmail messages",
      });
      const detail = await host.store.database
        .selectFrom("integrationRequestDetails")
        .selectAll()
        .where("requestId", "=", RequestIdSchema.parse(request.requestId))
        .executeTakeFirstOrThrow();
      expect(detail.manifest).toMatchObject({
        kind: "catalog",
        definition: { id: "google-gmail" },
      });
      facts.push({ request, manifest: detail.manifest });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.catalog.install",
          input: { definitionId: definition.id, digest: integrationDefinitionDigest(definition) },
          idempotencyKey: "gmail-install",
        },
        { headers: host.ownerHeaders },
      );
      expect(await search("email Gmail")).toMatchObject({ installed: true });
      passed = true;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        `${artifactDirectory}/gmail-catalog-recovery.json`,
        JSON.stringify({ passed, facts }, null, 2),
      );
      try {
        for (const close of closers) await close();
      } finally {
        await isolated.drop();
      }
    }
  }, 120_000);

  it("reviews guidance, refuses unsafe checks, and preserves credentials on failed connect and repair", async () => {
    const facts: { step: string; observed: unknown }[] = [];
    const closers: (() => Promise<unknown>)[] = [];
    let passed = false;
    try {
      const provider = await upstream();
      closers.push(provider.close);
      const host = await startMachineAccessHost(database.url, {
        integrationFetch: provider.fetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Proposal caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "proposal-caller",
          name: "Proposal caller",
        }),
      });
      closers.unshift(() => caller.close());
      const run = await dispatchCallerRun(host, caller, {
        key: "proposal-guidance",
        title: "Set up Vapi",
      });
      closers.unshift(() => run.complete());
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const catalogBefore = integrationDefinitions.map(integrationDefinitionDigest);
      const propose = (overrides: Json = {}, document: Json = spec()) =>
        gateway.call("integration_propose", {
          source: JSON.stringify(document),
          kind: "openapi",
          reason: "Use the provider API",
          description,
          credential,
          check,
          ...overrides,
        });
      const approve = (requestId: string, key: string) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            requestId: RequestIdSchema.parse(requestId),
            response: { kind: "choice", optionId: "installed" },
            type: "request.respond",
          },
          { headers: host.ownerHeaders },
        );

      const refused: string[] = [];
      for (const method of ["post", "put", "patch", "delete"]) {
        await expect(propose({}, spec({ method }))).rejects.toThrow(/GET or HEAD/u);
        refused.push(method);
      }
      for (const [label, document] of [
        ["body", spec({ body: true })],
        ["anonymous", spec({ security: [] })],
        ["anonymous alternative", spec({ security: [{ privateKey: [] }, {}] })],
        ["different credential", spec({ security: [{ otherKey: [] }] })],
        ["duplicate operation", spec({ duplicate: true })],
      ] as const) {
        await expect(propose({}, document)).rejects.toThrow();
        refused.push(label);
      }
      for (const location of ["header", "cookie"] as const) {
        for (const argument of ["query", "path"] as const) {
          await expect(
            propose(
              { check: { ...check, args: { limit: 1, "X-HTTP-Method-Override": "DELETE" } } },
              spec({ collision: { location, argument } }),
            ),
          ).rejects.toThrow(/exclusively/u);
          refused.push(`${argument} argument collides with optional ${location}`);
        }
      }
      for (const [label, overrides] of [
        ["unknown operation", { check: { operationId: "missing" } }],
        ["object arg", { check: { ...check, args: { limit: { nested: 1 } } } }],
        ["nested array arg", { check: { ...check, args: { limit: [[1]] } } }],
        ["header arg", { check: { ...check, args: { limit: 1, "X-Region": "us" } } }],
        ["extra args", { check: { ...check, args: { limit: 1, extra: true } } }],
        ["missing args", { check: { operationId: "checkKey" } }],
        ["overlong args", { check: { ...check, args: { value: "x".repeat(4097) } } }],
        ["HTTP setup URL", { credential: { ...credential, setupUrl: "http://example.com" } }],
        ["malformed setup URL", { credential: { ...credential, setupUrl: "not a URL" } }],
        ["overlong label", { credential: { ...credential, label: "x".repeat(81) } }],
        ["overlong description", { credential: { ...credential, description: "x".repeat(241) } }],
        [
          "overlong URL",
          { credential: { ...credential, setupUrl: `https://example.com/${"x".repeat(2048)}` } },
        ],
        ["overlong operation ID", { check: { operationId: "x".repeat(257) } }],
      ] as const) {
        await expect(propose(overrides)).rejects.toThrow();
        refused.push(label);
      }
      await expect(
        propose({ check: { ...check, args: { limit: "provider-validates-this" } } }),
      ).resolves.toBeDefined();
      await expect(
        propose({ check: { ...check, args: { limit: [1, "two", null, true] } } }),
      ).resolves.toBeDefined();
      await expect(propose({}, spec({ requiredHeader: true }))).rejects.toThrow();
      refused.push("required header cannot be supplied by check args");
      facts.push({
        step: "structural check boundary",
        observed: { refused, providerOwnsValues: true, scalarArraysAccepted: true },
      });

      // The approval path reads the durable detail, not an agent's current call.
      const proposal = await propose();
      const requestId = RequestIdSchema.parse(proposal.requestId);
      const detail = await host.store.database
        .selectFrom("integrationRequestDetails")
        .select("manifest")
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow();
      if (detail.manifest?.kind !== "proposal") throw new Error("Expected proposal manifest");
      const reviewed = detail.manifest;
      expect(reviewed.proposal).toMatchObject({
        credential,
        check,
        apiKey: { check: true, destinations: [origin, checkOrigin].sort() },
      });
      expect(
        integrationInstallReview({
          ...reviewed,
          proposal: integrationProposalSummary(reviewed.proposal),
        }),
      ).toEqual({
        facts: [
          description,
          "Researched from a document the agent supplied.",
          "Your key is stored encrypted by your Opensteer and sent to api.proposal.example, keys.proposal.example when used.",
          "Opensteer checks the key with Vapi fixture before saving it.",
        ],
        name: "Vapi fixture",
        provenance: requestAgentProposedDetail,
      });
      for (const [field, changed] of [
        [
          "credential",
          { ...reviewed.proposal, credential: { ...credential, description: "Altered guidance" } },
        ],
        ["check", { ...reviewed.proposal, check: { ...check, args: { limit: 2 } } }],
        ["name", { ...reviewed.proposal, name: "Vapi — approved by Opensteer" }],
        ["description", { ...reviewed.proposal, description: "Approved by Opensteer." }],
      ] as const) {
        await host.store.database
          .updateTable("integrationRequestDetails")
          .set({
            manifest: { ...reviewed, proposal: IntegrationProposalManifestSchema.parse(changed) },
          })
          .where("requestId", "=", requestId)
          .execute();
        await expect(approve(requestId, `tampered-${field}`)).rejects.toThrow(
          /changed after inspection/u,
        );
      }
      await host.store.database
        .updateTable("integrationRequestDetails")
        .set({
          manifest: {
            ...reviewed,
            proposal: {
              ...reviewed.proposal,
              apiKey: { check: false, destinations: ["https://altered.example"] },
            },
          },
        })
        .where("requestId", "=", requestId)
        .execute();
      await approve(requestId, "approve-original");
      const installation = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("sourceKind", "=", "proposed")
        .executeTakeFirstOrThrow();
      const definition = IntegrationDefinitionSummarySchema.parse(installation.manifest.definition);
      expect(definition.setupUrl).toBe(credential.setupUrl);
      expect(definition.authMethods[0]).toMatchObject({
        label: credential.label,
        inputs: [{ label: credential.label, description: credential.description }],
      });
      expect(definition.apiKey).toEqual({
        check: true,
        destinations: [origin, checkOrigin].sort(),
      });
      expect(installation.manifest.proposal).toMatchObject({ apiKey: definition.apiKey });
      expect(apiKeyDisclosure(definition)?.custody).toContain("keys.proposal.example");
      expect(apiKeyDisclosure(definition)?.check).toContain("before saving");
      expect(installation.adapterSnapshot?.config.healthCheck).toEqual(check);
      expect(resolutions.count).toBeGreaterThan(0);
      const resolutionCount = resolutions.count;
      const fetchCount = provider.fetches.length;
      const dashboard = await testRpcData(
        host.origin,
        "integration.platform.get",
        {},
        { headers: host.ownerHeaders },
      );
      expect(
        dashboard.installations.find(({ installation: item }) => item.id === installation.id)
          ?.installation.manifest.definition,
      ).toMatchObject({ apiKey: definition.apiKey });
      expect(resolutions.count).toBe(resolutionCount);
      expect(provider.fetches.length).toBe(fetchCount);
      facts.push({
        step: "metadata-only dashboard",
        observed: { documentResolutions: 0, fetches: 0 },
      });
      facts.push({
        step: "approved immutable guidance and routing",
        observed: {
          credential,
          check,
          apiKey: definition.apiKey,
          integrityRefusals: 3,
          tamperedDisclosureRecomputed: true,
        },
      });

      const connect = (good: boolean, key: string, connectionId?: string) =>
        testRpcRequest(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            type: "integration.apiKey.connect",
            input: {
              authMethodId: "api-key",
              definitionId: definition.id,
              values: { apiKey: good ? "fixture-private-good" : "fixture-private-bad" },
              ...(connectionId ? { connectionId } : {}),
            },
          },
          { headers: host.ownerHeaders },
        );
      const connections = () =>
        host.store.database
          .selectFrom("integrationConnections")
          .select(["id", "credentialGeneration", "credentialId"])
          .where("integrationDefinitionId", "=", definition.id)
          .execute();
      const credentials = () =>
        host.store.database
          .selectFrom("credentials")
          .select(["id", "encryptedPayload", "encryptionKeyVersion"])
          .orderBy("id")
          .execute();
      const credentialsBefore = await credentials();
      const rejected = await connect(false, "bad-first");
      expect(rejected.ok).toBe(false);
      const rejection = await rejected.text();
      expect(rejection).toContain("Vapi fixture rejected this key.");
      expect(rejection).not.toContain("fixture-private-bad");
      expect(rejection).not.toContain("RAW_PROVIDER_BODY");
      expect(rejection.length).toBeLessThan(1024);
      expect(await connections()).toEqual([]);
      expect(await credentials()).toEqual(credentialsBefore);
      for (const status of [403, 400, 503]) {
        provider.rejectWith(status);
        const failed = await connect(false, `bad-${status}`);
        expect(failed.ok).toBe(false);
        const error = await failed.text();
        expect(error).toContain(
          status === 403
            ? "Vapi fixture rejected this key."
            : `Opensteer couldn’t check the key with Vapi fixture (HTTP ${status})`,
        );
        expect(error).not.toContain("RAW_PROVIDER_BODY");
        expect(error).not.toContain("fixture-private-bad");
        expect(error.length).toBeLessThan(1024);
      }
      provider.rejectWith(401);
      const accepted = await connect(true, "good-first");
      expect(accepted.ok).toBe(true);
      const saved = await connections();
      expect(saved).toHaveLength(1);
      const sealedBeforeRepair = await credentials();
      const reconnect = await connect(false, "bad-reconnect", saved[0]!.id);
      expect(reconnect.ok).toBe(false);
      expect(await connections()).toEqual(saved);
      expect(await credentials()).toEqual(sealedBeforeRepair);
      expect(provider.requests).toEqual([
        ...Array.from({ length: 4 }, () => ({
          origin: checkOrigin,
          method: "GET",
          authorized: false,
        })),
        { origin: checkOrigin, method: "GET", authorized: true },
        { origin: checkOrigin, method: "GET", authorized: false },
      ]);
      facts.push({
        step: "connect and repair",
        observed: {
          rejectedBeforeSave: true,
          connected: true,
          failedRepairPreservedCredential: true,
          credentialGeneration: saved[0]!.credentialGeneration,
          requests: provider.requests,
          safeError: JSON.parse(rejection) as unknown,
        },
      });

      const legacy = await propose({ credential: undefined, check: undefined });
      const legacyRequestId = RequestIdSchema.parse(legacy.requestId);
      const legacyRequest = await host.store.database
        .selectFrom("integrationRequestDetails")
        .select("manifest")
        .where("requestId", "=", legacyRequestId)
        .executeTakeFirstOrThrow();
      if (legacyRequest.manifest?.kind !== "proposal") throw new Error("Expected legacy proposal");
      // As stored before agents described their proposals: the document alone.
      const {
        apiKey: omittedDisclosure,
        description: omittedDescription,
        ...oldProposal
      } = legacyRequest.manifest.proposal;
      void omittedDisclosure;
      expect(omittedDescription).toBe(description);
      const oldDigest = createHash("sha256").update(JSON.stringify(spec())).digest("base64url");
      expect(oldProposal.digest).not.toBe(oldDigest);
      await host.store.database
        .updateTable("integrationRequestDetails")
        .set({
          manifest: { ...legacyRequest.manifest, proposal: { ...oldProposal, digest: oldDigest } },
        })
        .where("requestId", "=", legacyRequestId)
        .execute();
      await approve(String(legacy.requestId), "approve-unchecked");
      const legacyRow = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("sourceKind", "=", "proposed")
        .where("id", "!=", installation.id)
        .executeTakeFirstOrThrow();
      const legacyDefinition = IntegrationDefinitionSummarySchema.parse(
        legacyRow.manifest.definition,
      );
      expect(legacyDefinition.authMethods[0]).toMatchObject({ label: "API credential" });
      expect(legacyDefinition.description).toBe(
        "OpenAPI integration from a document the agent supplied.",
      );
      expect(legacyDefinition.apiKey?.check).toBe(false);
      expect(apiKeyDisclosure(legacyDefinition)?.check).toContain("first time");
      const unchecked = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "unchecked-connect",
          type: "integration.apiKey.connect",
          input: {
            authMethodId: "api-key",
            definitionId: legacyDefinition.id,
            values: { apiKey: "fixture-private-unchecked" },
          },
        },
        { headers: host.ownerHeaders },
      );
      expect(unchecked.ok).toBe(true);
      expect(provider.requests).toHaveLength(6);
      const catalogEntry = dashboard.catalog.find(
        ({ definition }) => definition.id === "vercel-rest",
      )!;
      expect(catalogEntry.installationId).toBeNull();
      expect(catalogEntry.definition.apiKey).toBeNull();
      provider.changeCatalogDestination(undisclosedOrigin);
      const uninstalledFetches = provider.fetches.length;
      const catalogConnected = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "catalog-without-installation",
          type: "integration.apiKey.connect",
          input: {
            authMethodId: "api-key",
            definitionId: "vercel-rest",
            values: { apiKey: "fixture-private-good" },
          },
        },
        { headers: host.ownerHeaders },
      );
      expect(catalogConnected.ok).toBe(false);
      expect(await catalogConnected.json()).toMatchObject({
        ok: false,
        error: {
          code: "conflict",
          message: "Install this integration before connecting an API key.",
        },
      });
      expect(
        await host.store.database
          .selectFrom("integrationConnections")
          .select("id")
          .where("integrationDefinitionId", "=", "vercel-rest")
          .execute(),
      ).toHaveLength(0);
      expect(provider.fetches.length).toBe(uninstalledFetches);
      expect(provider.requests.every(({ origin }) => origin !== undisclosedOrigin)).toBe(true);
      facts.push({
        step: "uninstalled remote-spec catalog Connect is refused before network access",
        observed: {
          connected: false,
          networkRequests: 0,
          undisclosedDestination: undisclosedOrigin,
        },
      });
      provider.changeCatalogDestination(disclosedOrigin);
      const finalResolutionCount = resolutions.count;
      const finalFetchCount = provider.fetches.length;
      await testRpcData(
        host.origin,
        "integration.platform.get",
        {},
        { headers: host.ownerHeaders },
      );
      expect(resolutions.count).toBe(finalResolutionCount);
      expect(provider.fetches.length).toBe(finalFetchCount);
      expect(integrationDefinitions.map(integrationDefinitionDigest)).toEqual(catalogBefore);
      expect(
        OpenApiAdapterConfigSchema.parse({
          inline: spec(),
          healthCheck: { operationId: "checkKey", method: "post" },
        }).healthCheck?.method,
      ).toBe("post");
      facts.push({
        step: "backward compatibility",
        observed: {
          oldPendingManifestApproved: true,
          uncheckedSavedWithoutProviderCall: true,
          genericLabel: "API credential",
          uncheckedCopy: apiKeyDisclosure(legacyDefinition)?.check,
          catalogDigestsUnchanged: true,
          catalogPostCheckStillAccepted: true,
        },
      });
      const mutableDefinition = integrationDefinitions.find(({ id }) => id === "vercel-rest")!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "install-mutable-catalog",
          type: "integration.catalog.install",
          input: {
            definitionId: mutableDefinition.id,
            digest: integrationDefinitionDigest(mutableDefinition),
          },
        },
        { headers: host.ownerHeaders },
      );
      const catalogInstallation = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("name", "=", mutableDefinition.id)
        .executeTakeFirstOrThrow();
      const catalogSummary = IntegrationDefinitionSummarySchema.parse(
        catalogInstallation.manifest.definition,
      );
      expect(catalogSummary.apiKey).toEqual({ check: true, destinations: [disclosedOrigin] });
      provider.changeCatalogDestination(undisclosedOrigin);
      const fetchesBeforeMutation = provider.fetches.length;
      const mutableConnected = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "connect-mutable-catalog",
          type: "integration.apiKey.connect",
          input: {
            authMethodId: "api-key",
            definitionId: mutableDefinition.id,
            values: { apiKey: "fixture-private-good" },
          },
        },
        { headers: host.ownerHeaders },
      );
      expect(mutableConnected).toBeDefined();
      const mutableConnection = await host.store.database
        .selectFrom("integrationConnections")
        .select("id")
        .where("integrationDefinitionId", "=", mutableDefinition.id)
        .executeTakeFirstOrThrow();
      expect(provider.requests.at(-1)).toEqual({
        origin: disclosedOrigin,
        method: "GET",
        authorized: true,
      });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "grant-mutable-catalog",
          type: "integration.grant.create",
          input: {
            access: "read",
            alias: "Vercel REST",
            connectionId: mutableConnection.id,
            installationId: catalogInstallation.id,
            isDefault: true,
            workspaceId: run.workspaceId,
          },
        },
        { headers: host.ownerHeaders },
      );
      const callable = operations(
        await gateway.call("integration_search", { query: "Vercel REST" }),
      )[0];
      if (!callable) throw new Error("Missing catalog snapshot operation");
      const invoked = await gateway.callRaw("integration_call", {
        arguments: {},
        toolRef: callable.toolRef,
      });
      expect(invoked.isError).toBeFalsy();
      expect(provider.fetches.slice(fetchesBeforeMutation)).toEqual([
        `${disclosedOrigin}/me`,
        `${disclosedOrigin}/me`,
      ]);
      expect(provider.requests.every(({ origin }) => origin !== undisclosedOrigin)).toBe(true);
      facts.push({
        step: "installed catalog uses one immutable snapshot after remote spec mutation",
        observed: {
          disclosed: catalogSummary.apiKey,
          connectAndInvokeOrigins: provider.requests.slice(-2),
          remoteSpecFetches: 0,
        },
      });

      await host.store.database
        .updateTable("integrationInstallations")
        .set({ status: "needs-attention" })
        .where("id", "=", catalogInstallation.id)
        .execute();
      const unavailableFetchCount = provider.fetches.length;
      await expect(
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: "unavailable-catalog-refused",
            type: "integration.apiKey.connect",
            input: {
              authMethodId: "api-key",
              definitionId: mutableDefinition.id,
              values: { apiKey: "fixture-private-good" },
            },
          },
          { headers: host.ownerHeaders },
        ),
      ).rejects.toThrow(/Installed integration is unavailable/u);
      expect(provider.fetches.length).toBe(unavailableFetchCount);
      await host.store.database
        .updateTable("integrationInstallations")
        .set({ status: "active" })
        .where("id", "=", catalogInstallation.id)
        .execute();
      facts.push({
        step: "unavailable installation cannot fall through to mutable catalog",
        observed: { refused: true, providerCalls: 0 },
      });

      // Include five healthy inline OpenAPI snapshots, two damaged legacy snapshots,
      // and unrelated rows held by another transaction throughout both startups.
      const template = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("id", "=", legacyRow.id)
        .executeTakeFirstOrThrow();
      const templateServer = await host.store.database
        .selectFrom("integrationServers")
        .selectAll()
        .where("installationId", "=", legacyRow.id)
        .executeTakeFirstOrThrow();
      const damaged: { id: IntegrationInstallationId; defect: string }[] = [];
      const unrelated: IntegrationInstallationId[] = [];
      for (const name of [
        "healthy-one",
        "healthy-two",
        "missing-inline",
        "relative-server",
        "oauth",
        "computer",
        "plugin",
        "already-disclosed",
      ]) {
        const id = createIntegrationId("installation");
        let manifest = { ...template.manifest };
        let adapterSnapshot = template.adapterSnapshot;
        if (name === "oauth" || name === "computer") {
          const definition = integrationDefinitions.find((candidate) =>
            name === "computer"
              ? candidate.adapter === "computer"
              : candidate.authMethods.some(({ kind }) => kind === "oauth"),
          )!;
          manifest = { definition: integrationDefinitionSummary({ ...definition, id: name }) };
          adapterSnapshot = null;
          unrelated.push(id);
        } else if (name === "plugin") {
          manifest = {};
          adapterSnapshot = null;
          unrelated.push(id);
        } else {
          const summary = IntegrationDefinitionSummarySchema.parse(template.manifest.definition);
          manifest = {
            definition: { ...summary, id: name === "missing-inline" ? "resend" : name },
          };
          if (!adapterSnapshot) throw new Error("Missing template snapshot");
          let config = { ...adapterSnapshot.config };
          if (name === "missing-inline") {
            const { inline, ...rest } = config;
            void inline;
            config = { ...rest, specUrl: mutableCatalogSpecUrl };
            damaged.push({ id, defect: name });
          } else if (name === "relative-server") {
            const document = spec();
            config = {
              ...config,
              inline: {
                ...document,
                servers: [{ url: "/relative" }],
                paths: {
                  "/broken": {
                    get: { operationId: "broken", responses: { 200: { description: "OK" } } },
                  },
                },
              },
            };
            damaged.push({ id, defect: name });
          }
          adapterSnapshot = {
            ...adapterSnapshot,
            definitionId: name === "missing-inline" ? "resend" : name,
            config,
          };
        }
        await host.store.database
          .insertInto("integrationInstallations")
          .values({
            ...template,
            id,
            name: name === "missing-inline" ? "resend" : name,
            manifest,
            adapterSnapshot,
            sourceKind:
              name === "plugin"
                ? "agent-plugin"
                : name === "missing-inline"
                  ? "built-in"
                  : "proposed",
            provenance:
              name === "missing-inline"
                ? {
                    definitionId: "resend",
                    definitionDigest: integrationDefinitionDigest(
                      integrationDefinitions.find(({ id }) => id === "resend")!,
                    ),
                  }
                : template.provenance,
            updatedAt: new Date("2025-01-01T00:00:00Z"),
          })
          .execute();
        if (name === "already-disclosed") unrelated.push(id);
        if (damaged.some((row) => row.id === id)) {
          await host.store.database
            .insertInto("integrationServers")
            .values({ ...templateServer, id: createIntegrationId("server"), installationId: id })
            .execute();
        }
      }

      // Emulate installations written before disclosure existed, retaining their resolved snapshots.
      const oldInstallations = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .execute();
      const expectedDisclosures = [];
      for (const row of oldInstallations) {
        if (unrelated.includes(row.id)) continue;
        const parsed = IntegrationDefinitionSummarySchema.safeParse(row.manifest.definition);
        if (!parsed.success || !parsed.data.apiKey || !row.adapterSnapshot) continue;
        const summary = parsed.data;
        if (!damaged.some(({ id }) => id === row.id))
          expectedDisclosures.push({
            id: row.id,
            sourceKind: row.sourceKind,
            revision: row.revision,
            apiKey: summary.apiKey,
          });
        const { apiKey: removed, ...oldSummary } = summary;
        const { credentialDestinations: removedDestinations, ...oldConfig } =
          row.adapterSnapshot.config;
        void removed;
        void removedDestinations;
        await host.store.database
          .updateTable("integrationInstallations")
          .set({
            manifest: { ...row.manifest, definition: oldSummary },
            adapterSnapshot: { ...row.adapterSnapshot, config: oldConfig },
          })
          .where("id", "=", row.id)
          .execute();
      }
      expect(expectedDisclosures).toHaveLength(5);
      expect(expectedDisclosures.some(({ sourceKind }) => sourceKind === "proposed")).toBe(true);
      expect(expectedDisclosures.some(({ sourceKind }) => sourceKind === "built-in")).toBe(true);
      while (closers.length > 2) await closers.shift()!();
      await host.runtime.close();
      let networkAttempts = 0;
      const offlineFetch: typeof fetch = () => {
        networkAttempts++;
        return Promise.reject(new Error("Network disabled for startup backfill"));
      };
      const blocker = createDatabase({ connectionString: database.url, maxConnections: 1 });
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = blocker.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("integrationInstallations")
          .select("id")
          .where("id", "in", unrelated)
          .orderBy("id")
          .forUpdate()
          .execute();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      let firstBootRows: unknown;
      let firstBootServers: unknown;
      try {
        for (let boot = 0; boot < 2; boot++) {
          const restarted = await createHostRuntime(host.config, {
            integrationFetch: offlineFetch,
            logger: false,
          });
          try {
            await restarted.listen();
            const resolutionCountBeforeRead = resolutions.count;
            const recoveredDashboard = await testRpcData(
              host.origin,
              "integration.platform.get",
              {},
              { headers: host.ownerHeaders },
            );
            expect(resolutions.count).toBe(resolutionCountBeforeRead);
            for (const expected of expectedDisclosures) {
              expect(
                recoveredDashboard.installations.find(
                  ({ installation }) => installation.id === expected.id,
                )?.installation.manifest.definition,
              ).toMatchObject({ apiKey: expected.apiKey });
              const actual = await restarted.store.database
                .selectFrom("integrationInstallations")
                .select(["manifest", "revision"])
                .where("id", "=", expected.id)
                .executeTakeFirstOrThrow();
              expect(actual.manifest.definition).toMatchObject({ apiKey: expected.apiKey });
              expect(actual.revision).toBe(expected.revision);
            }
            const repairReason =
              "Opensteer can’t tell where this integration sends its key. Remove it and install it again.";
            for (const broken of damaged) {
              const entry = recoveredDashboard.installations.find(
                ({ installation }) => installation.id === broken.id,
              );
              expect(entry?.installation.status).toBe("needs-attention");
              expect(entry?.servers).toEqual([
                expect.objectContaining({ status: "needs-attention", statusDetail: repairReason }),
              ]);
            }
            const rows = await restarted.store.database
              .selectFrom("integrationInstallations")
              .selectAll()
              .orderBy("id")
              .execute();
            const servers = await restarted.store.database
              .selectFrom("integrationServers")
              .selectAll()
              .orderBy("id")
              .execute();
            expect(
              rows
                .filter(({ id }) => unrelated.includes(id))
                .every(({ updatedAt }) => updatedAt.toISOString() === "2025-01-01T00:00:00.000Z"),
            ).toBe(true);
            if (boot === 0) {
              firstBootRows = rows;
              firstBootServers = servers;
            } else {
              expect(rows).toEqual(firstBootRows);
              expect(servers).toEqual(firstBootServers);
            }
          } finally {
            await restarted.close();
          }
        }
      } finally {
        release.resolve();
        await holding;
        await blocker.destroy();
      }
      expect(networkAttempts).toBe(0);
      facts.push({
        step: "offline startup backfills old catalog and proposed snapshots idempotently",
        observed: {
          installations: expectedDisclosures,
          damaged,
          unrelatedRowsLockedElsewhereAndUnchanged: unrelated,
          secondBootUnchanged: true,
          boots: 2,
          networkAttempts,
        },
      });
      passed = true;
    } finally {
      for (const close of closers) await close();
      await mkdir(artifactDirectory, { recursive: true });
      const path = `${artifactDirectory}/result.json`;
      await writeFile(
        path,
        JSON.stringify(
          {
            passed,
            facts,
            repeat:
              "OPENSTEER_TEST_DATABASE_URL=postgres://opensteer:opensteer@127.0.0.1:54348/opensteer OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL=postgres://opensteer:opensteer@127.0.0.1:54348/opensteer_control_plane pnpm test:integration apps/host/src/integrations/integration-proposal-credentials.integration.test.ts",
          },
          null,
          2,
        ),
      );
      console.info(`Proposal credential E2E artifact: ${path}`);
    }
  }, 120_000);

  // The ways it could fail: the agent's name for the service ignored, so the
  // card, the key form and Settings say the document's title ("tmdb-api"); a
  // proposal accepted without saying what the service does, or described by
  // where it came from, which the card already says; a name or description
  // that is not one plain line accepted, so it can pose as Opensteer's own
  // words; either changed after review and installed anyway; a proposal
  // without a name given a new digest, stranding requests already waiting; an
  // argument refusal that does not say which field.
  it("installs a proposal under the name and description the agent gave it, bound into what was reviewed", async () => {
    const facts: { step: string; observed: unknown }[] = [];
    const named = await createMachineAccessDatabase(baseDatabaseUrl!);
    const closers: (() => Promise<unknown>)[] = [() => named.drop()];
    let passed = false;
    try {
      const provider = await upstream();
      closers.unshift(provider.close);
      const host = await startMachineAccessHost(named.url, {
        integrationFetch: provider.fetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Naming caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "naming-caller",
          name: "Naming caller",
        }),
      });
      closers.unshift(() => caller.close());
      const run = await dispatchCallerRun(host, caller, {
        key: "proposal-name",
        title: "Set up Vapi",
      });
      closers.unshift(() => run.complete());
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const propose = (overrides: Json = {}) =>
        gateway.call("integration_propose", {
          source: JSON.stringify(spec()),
          kind: "openapi",
          reason: "Use the provider API",
          description,
          credential,
          check,
          ...overrides,
        });
      const proposalOf = async (requestId: unknown) => {
        const row = await host.store.database
          .selectFrom("integrationRequestDetails")
          .innerJoin("requests", "requests.id", "integrationRequestDetails.requestId")
          .select(["integrationRequestDetails.manifest", "requests.presentation"])
          .where("integrationRequestDetails.requestId", "=", RequestIdSchema.parse(requestId))
          .executeTakeFirstOrThrow();
        if (row.manifest?.kind !== "proposal") throw new Error("Expected a proposal manifest");
        return { proposal: row.manifest.proposal, title: row.presentation.title };
      };
      const approve = (requestId: unknown, key: string) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            requestId: RequestIdSchema.parse(requestId),
            response: { kind: "choice", optionId: "installed" },
            type: "request.respond",
          },
          { headers: host.ownerHeaders },
        );
      const installedTitle = async (digest: string) => {
        const row = await host.store.database
          .selectFrom("integrationInstallations")
          .select(["manifest", "title"])
          .where("version", "=", digest)
          .executeTakeFirstOrThrow();
        const definition = IntegrationDefinitionSummarySchema.parse(row.manifest.definition);
        return {
          definition: definition.name,
          description: definition.description,
          title: row.title,
        };
      };

      const refusals: string[] = [];
      for (const [field, overrides] of [
        ["credential.description", { credential: { ...credential, description: "x".repeat(241) } }],
        ["name", { name: "Vapi\nApproved by Opensteer" }],
        ["name", { name: "Vapi\u202Eipa" }],
        ["name", { name: "Vapi\u2028Approved by Opensteer" }],
        ["name", { name: "Vapi\u2029Approved by Opensteer" }],
        ["name", { name: "x".repeat(81) }],
        ["name", { name: "   " }],
        ["description", { description: undefined }],
        ["description", { description: "Phone calls\nApproved by Opensteer" }],
        ["description", { description: "Phone calls\u2028Approved by Opensteer" }],
        ["description", { description: "x".repeat(241) }],
        ["description", { description: "   " }],
      ] as const) {
        const refusal = await propose(overrides).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(refusal?.startsWith(`invalid_arguments: ${field}: `)).toBe(true);
        refusals.push(refusal!);
      }
      facts.push({ step: "argument refusals name their field", observed: refusals });

      const bare = await propose();
      const unnamed = await proposalOf(bare.requestId);
      const proposed = await propose({ name: "  Vapi  ", description: `  ${description}  ` });
      const reviewed = await proposalOf(proposed.requestId);
      expect(unnamed.proposal.name).toBeUndefined();
      expect(unnamed.proposal.description).toBe(description);
      expect(reviewed.proposal.description).toBe(description);
      expect(unnamed.title).toBe("Install Vapi fixture?");
      expect(reviewed.proposal.name).toBe("Vapi");
      expect(reviewed.title).toBe("Install Vapi?");
      expect(reviewed.proposal.digest).not.toBe(unnamed.proposal.digest);
      const review = integrationInstallReview({
        kind: "proposal",
        proposal: integrationProposalSummary(reviewed.proposal),
      });
      expect(review?.name).toBe("Vapi");
      expect(review?.facts.slice(0, 2)).toEqual([
        description,
        "Researched from a document the agent supplied.",
      ]);

      await host.store.database
        .updateTable("integrationRequestDetails")
        .set({
          manifest: {
            kind: "proposal",
            proposal: { ...reviewed.proposal, name: "Vapi — approved by Opensteer" },
          },
        })
        .where("requestId", "=", RequestIdSchema.parse(proposed.requestId))
        .execute();
      await expect(approve(proposed.requestId, "renamed-after-review")).rejects.toThrow(
        /changed after inspection/u,
      );
      await host.store.database
        .updateTable("integrationRequestDetails")
        .set({
          manifest: {
            kind: "proposal",
            proposal: { ...reviewed.proposal, description: "Approved by Opensteer." },
          },
        })
        .where("requestId", "=", RequestIdSchema.parse(proposed.requestId))
        .execute();
      await expect(approve(proposed.requestId, "redescribed-after-review")).rejects.toThrow(
        /changed after inspection/u,
      );
      await host.store.database
        .updateTable("integrationRequestDetails")
        .set({ manifest: { kind: "proposal", proposal: reviewed.proposal } })
        .where("requestId", "=", RequestIdSchema.parse(proposed.requestId))
        .execute();
      await approve(proposed.requestId, "approve-named");
      expect(await installedTitle(reviewed.proposal.digest)).toEqual({
        definition: "Vapi",
        description,
        title: "Vapi",
      });
      await approve(bare.requestId, "approve-unnamed");
      expect(await installedTitle(unnamed.proposal.digest)).toEqual({
        definition: "Vapi fixture",
        description,
        title: "Vapi fixture",
      });
      facts.push({
        step: "the agent's name is reviewed, bound and installed",
        observed: {
          named: {
            digest: reviewed.proposal.digest,
            requestTitle: reviewed.title,
            installed: "Vapi",
          },
          unnamed: {
            digest: unnamed.proposal.digest,
            requestTitle: unnamed.title,
            installed: "Vapi fixture",
          },
          description,
          renamedAfterReviewRefused: true,
          redescribedAfterReviewRefused: true,
        },
      });
      passed = true;
    } finally {
      for (const close of closers) await close();
      await mkdir(artifactDirectory, { recursive: true });
      const path = `${artifactDirectory}/name-result.json`;
      await writeFile(path, JSON.stringify({ passed, facts }, null, 2));
      console.info(`Proposal name E2E artifact: ${path}`);
    }
  }, 120_000);

  // The ways it could fail: a call found by a name planned again from the stored
  // document runs another operation, so a read tool's toolRef performs a write
  // under a read-only grant; two operations planned one name, so starting stops
  // on a unique violation; binding a stored tool to the wrong operation, or a
  // renamed operation taking another's row, name or effect; a held toolRef
  // reaching a different operation after a restart; the account or grant
  // changed; starting reaching the network, or changing anything a second time;
  // one integration the Host cannot bind, from a name too long, a path too
  // long or a document that is gone, stopping every other one from starting.
  it("binds every stored OpenAPI tool to its operation once, renaming it in place, and calls nothing else", async () => {
    const facts: { step: string; observed: unknown }[] = [];
    const bound = await createMachineAccessDatabase(baseDatabaseUrl!);
    const closers: (() => Promise<unknown>)[] = [() => bound.drop()];
    const calls: { method: string; url: string }[] = [];
    const integrationFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({ method: request.method, url: request.url });
      return Response.json({ ok: true });
    };
    let passed = false;
    try {
      const host = await startMachineAccessHost(bound.url, {
        integrationFetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Bound caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "bound-caller",
          name: "Bound caller",
        }),
      });
      const run = await dispatchCallerRun(host, caller, { key: "bound", title: "Read accounts" });
      const gateway = await integrationGateway(run.integrationTools);
      const firstBoot = [() => gateway.close(), () => run.complete(), () => caller.close()];
      closers.unshift(...firstBoot);

      // As 0.1.131 stored them: named by its planner, and with no operation recorded.
      const store = new IntegrationInstallStore(host.store.database);
      const installed: Record<
        string,
        { readonly installationId: string; readonly origin: string }
      > = {};
      for (const [key, document] of Object.entries(storedDocuments)) {
        const definition = IntegrationDefinitionSchema.parse({
          adapter: "openapi",
          authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
          config: { inline: document },
          description: `${key} fixture`,
          id: `stored-${key}`,
          name: `Stored ${key}`,
          provider: `stored-${key}`,
        });
        const config = OpenApiAdapterConfigSchema.parse(definition.config);
        const { definitions, tools } = extractOpenApiTools(document, config);
        const legacy = planLegacyOpenApiToolNames(
          tools.map(({ target }) => {
            const { method, path } = target as { method: string; path: string };
            const operation = (document.paths as Json)[path] as Record<string, Json>;
            return { method, operationId: String(operation[method]!.operationId), path };
          }),
        );
        const installationId = createIntegrationId("installation");
        await store.install({
          actorUserId: null,
          adapterSnapshot: {
            adapter: "openapi",
            config: { inline: document },
            definitionId: definition.id,
          },
          installation: {
            description: definition.description,
            id: installationId,
            manifest: { definition: integrationDefinitionSummary(definition) },
            name: definition.id,
            provenance: { artifactDigest: "d".repeat(43), proposalKind: "openapi" },
            sourceKind: "proposed",
            status: "active",
            title: definition.name,
            trust: "administrator-approved",
            version: "d".repeat(43),
          },
          requestId: `install-${key}`,
          servers: [
            {
              catalog: {
                definitions,
                tools: [
                  ...legacy,
                  // A name no operation of the document plans any more, as a call refused it.
                  ...(key === "tmdb" ? ["3.retiredOperation"] : []),
                ].map((name, index) => {
                  const { target: _target, ...tool } = tools[index] ?? tools[0]!;
                  return {
                    ...tool,
                    annotations: tool.annotations ?? {},
                    connectionId: null,
                    id: createIntegrationId("tool"),
                    name,
                    outputSchema: tool.outputSchema ?? null,
                    status: "active" as const,
                    title: name,
                  };
                }),
              },
              connectionRequirement: { kind: "none" },
              id: createIntegrationId("server"),
              name: "default",
              status: "active",
              statusDetail: null,
              transport: { adapter: "openapi", definitionId: definition.id, type: "adapter" },
            },
          ],
        });
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: `grant-${key}`,
            type: "integration.grant.create",
            input: {
              access: "read",
              alias: definition.name,
              connectionId: null,
              installationId,
              isDefault: true,
              workspaceId: run.workspaceId,
            },
          },
          { headers: host.ownerHeaders },
        );
        installed[key] = {
          installationId,
          origin: (document.servers as { url: string }[])[0]!.url,
        };
      }
      // A stored document damaged after its tools were stored.
      await host.store.database
        .updateTable("integrationInstallations")
        .set({
          adapterSnapshot: {
            adapter: "openapi",
            config: { inline: { openapi: "3.1.0", info: { title: "Broken", version: "1" } } },
            definitionId: "stored-broken",
          },
        })
        .where("id", "=", installed.broken!.installationId as IntegrationInstallationId)
        .execute();
      const toolRows = (database: typeof host.store.database) =>
        database
          .selectFrom("integrationTools")
          .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
          .select([
            "integrationServers.installationId",
            "integrationServers.toolGeneration",
            "integrationTools.annotations",
            "integrationTools.id",
            "integrationTools.name",
            "integrationTools.schemaDigest",
            "integrationTools.status",
            "integrationTools.target",
            "integrationTools.updatedAt",
          ])
          .orderBy("integrationTools.id")
          .execute();
      const grantRows = (database: typeof host.store.database) =>
        database.selectFrom("integrationGrants").selectAll().orderBy("id").execute();
      const serverRows = (database: typeof host.store.database) =>
        database
          .selectFrom("integrationServers")
          .innerJoin(
            "integrationInstallations",
            "integrationInstallations.id",
            "integrationServers.installationId",
          )
          .select([
            "integrationInstallations.id as installationId",
            "integrationInstallations.status as installationStatus",
            "integrationServers.status",
            "integrationServers.statusDetail",
            "integrationServers.updatedAt",
          ])
          .orderBy("integrationServers.id")
          .execute();
      const before = await toolRows(host.store.database);
      const grantsBefore = await grantRows(host.store.database);
      expect(before.map(({ name }) => name).sort()).toEqual(
        [
          "3.accountDetails",
          "3.authenticationValidateKey",
          "3.brokenDetail",
          "3.change",
          "3.deepDetail",
          "3.detail",
          "3.longDetail",
          "3.retiredOperation",
          "4.accountDetail",
          "account.change",
          "account.changePost",
          "account.accountAddFavorite",
        ].sort(),
      );
      const find = async (name: string) =>
        operation(await gateway.call("integration_search", { query: name }), name);
      const held = {
        currentAccount: await find("account.changePost"),
        account: await find("account.change"),
        details: await find("3.accountDetails"),
        long: await find("3.longDetail"),
        deep: await find("3.deepDetail"),
      };
      const retiredRef = await find("3.retiredOperation");
      const brokenRef = await find("3.brokenDetail");
      facts.push({
        step: "0.1.131 stored a read GET as account.changePost, a name its POST plans now",
        observed: { names: before.map(({ name }) => name).sort(), held },
      });

      for (const close of firstBoot) await close();
      closers.splice(0, firstBoot.length);
      await host.runtime.close();
      let afterFirstStart: Awaited<ReturnType<typeof toolRows>> = [];
      let serversAfterFirstStart: Awaited<ReturnType<typeof serverRows>> = [];
      for (let start = 0; start < 2; start++) {
        const restarted = await createHostRuntime(host.config, {
          integrationFetch,
          logger: false,
        });
        closers.unshift(() => restarted.close());
        const rows = await toolRows(restarted.store.database);
        expect(await grantRows(restarted.store.database)).toEqual(grantsBefore);
        expect(calls).toEqual([]);
        const servers = await serverRows(restarted.store.database);
        if (start === 0) {
          afterFirstStart = rows;
          serversAfterFirstStart = servers;
          await restarted.close();
          closers.shift();
          continue;
        }
        expect(rows).toEqual(afterFirstStart);
        expect(servers).toEqual(serversAfterFirstStart);
        await restarted.listen();
        const started = { ...host, runtime: restarted, store: restarted.store };
        const nextCaller = await connectCallerMachine(started, {
          name: "Bound caller again",
          token: await enrollmentToken(started, {
            allowedModules: ["agents"],
            idempotencyKey: "bound-caller-again",
            name: "Bound caller again",
          }),
        });
        closers.unshift(() => nextCaller.close());
        const nextRun = await dispatchCallerRun(started, nextCaller, {
          key: "bound-again",
          title: "Read accounts again",
          workspaceId: run.workspaceId,
        });
        closers.unshift(() => nextRun.complete());
        const nextGateway = await integrationGateway(nextRun.integrationTools);
        closers.unshift(() => nextGateway.close());
        for (const [name, ref] of Object.entries(held)) {
          const called = await nextGateway.callRaw("integration_call", {
            arguments: name === "details" ? { account_id: "42" } : {},
            toolRef: ref.toolRef,
          });
          expect(called.isError, toolText(called)).toBeFalsy();
        }
        const retired = await nextGateway.callRaw("integration_call", {
          arguments: { account_id: "42" },
          toolRef: retiredRef.toolRef,
        });
        expect(retired.isError).toBe(true);
        expect(toolText(retired)).toContain("no longer available");
        const broken = await nextGateway.callRaw("integration_call", {
          arguments: {},
          toolRef: brokenRef.toolRef,
        });
        expect(broken.isError).toBe(true);
        expect(
          JSON.stringify(await nextGateway.call("integration_search", { query: "Stored broken" })),
        ).toContain(unboundReason);
        expect(calls).toEqual([
          { method: "GET", url: `${installed.suffix!.origin}/account/current` },
          { method: "GET", url: `${installed.suffix!.origin}/account` },
          { method: "GET", url: `${installed.tmdb!.origin}/3/account/42` },
          { method: "GET", url: `${installed.long!.origin}${longPath}` },
          { method: "GET", url: `${installed.deep!.origin}${deepPath}` },
        ]);
        const write = afterFirstStart.find(({ name }) => name === "account.changePost2")!;
        const grant = grantsBefore.find(
          ({ installationId }) => installationId === installed.suffix!.installationId,
        )!;
        const refused = await nextGateway.callRaw("integration_call", {
          arguments: {},
          toolRef: `${grant.id}.${write.id}.${write.schemaDigest}`,
        });
        expect(refused.isError).toBe(true);
        expect(calls.some(({ method }) => method === "POST")).toBe(false);
        facts.push({
          step: "held toolRefs call the operation they were stored for; a read grant never writes",
          observed: {
            calls: calls.map(({ method, url }) => ({ method, url: url.slice(0, 120) })),
            refusedBroken: toolText(broken),
            refusedRetired: toolText(retired),
            refusedWrite: toolText(refused),
          },
        });
      }
      const byId = new Map(before.map((row) => [row.id, row]));
      const renamed = afterFirstStart.map(({ id, name, status, target, annotations }) => ({
        before: byId.get(id)?.name ?? null,
        name,
        readOnly: annotations.readOnlyHint === true,
        status,
        target,
      }));
      expect(renamed.sort((left, right) => left.name.localeCompare(right.name))).toEqual([
        {
          before: "3.brokenDetail",
          name: "3.brokenDetail",
          readOnly: true,
          status: "active",
          target: null,
        },
        {
          before: "3.retiredOperation",
          name: "3.retiredOperation",
          readOnly: true,
          status: "disabled",
          target: null,
        },
        {
          before: "account.accountAddFavorite",
          name: "account.accountAddFavorite",
          readOnly: false,
          status: "active",
          target: { method: "post", path: "/account/{account_id}/favorite" },
        },
        {
          before: "3.accountDetails",
          name: "account.accountDetails",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/3/account/{account_id}" },
        },
        {
          before: "account.change",
          name: "account.changeGet",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/account" },
        },
        {
          before: "account.changePost",
          name: "account.changePost",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/account/current" },
        },
        {
          before: "3.change",
          name: "account.changePost2",
          readOnly: false,
          status: "active",
          target: { method: "post", path: "/3/account" },
        },
        {
          before: "3.deepDetail",
          name: "account.deepDetail",
          readOnly: true,
          status: "active",
          target: { method: "get", path: deepPath },
        },
        {
          before: "3.detail",
          name: "account.detailGet",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/3/account" },
        },
        {
          before: "4.accountDetail",
          name: "account.detailGet2",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/4/account" },
        },
        {
          before: "3.authenticationValidateKey",
          name: "authentication.authenticationValidateKey",
          readOnly: true,
          status: "active",
          target: { method: "get", path: "/3/authentication" },
        },
        {
          before: "3.longDetail",
          name: `${"x".repeat(240)}.longDetail`,
          readOnly: true,
          status: "active",
          target: { method: "get", path: longPath },
        },
      ]);
      expect(
        serversAfterFirstStart.map(
          ({ installationId, installationStatus, status, statusDetail }) => ({
            broken: installationId === installed.broken!.installationId,
            installationStatus,
            status,
            statusDetail,
          }),
        ),
      ).toEqual(
        serversAfterFirstStart.map(({ installationId }) =>
          installationId === installed.broken!.installationId
            ? {
                broken: true,
                installationStatus: "needs-attention",
                status: "needs-attention",
                statusDetail: unboundReason,
              }
            : { broken: false, installationStatus: "active", status: "active", statusDetail: null },
        ),
      );
      facts.push({
        step: "starting binds each tool by its stored name and renames it in place, once and offline",
        observed: {
          tools: renamed.map((tool) => ({
            ...tool,
            name: tool.name.slice(0, 120),
            target: tool.target && { ...tool.target, path: String(tool.target.path).slice(0, 120) },
          })),
          unavailable: { reason: unboundReason, broken: installed.broken },
          grantsUnchanged: true,
          secondStartUnchanged: true,
        },
      });
      passed = true;
    } finally {
      for (const close of closers) await close();
      await mkdir(artifactDirectory, { recursive: true });
      const path = `${artifactDirectory}/bound-tools-result.json`;
      await writeFile(path, JSON.stringify({ passed, facts }, null, 2));
      console.info(`Bound OpenAPI tools E2E artifact: ${path}`);
    }
  }, 180_000);

  // The ways it could fail: a failure binding one integration, or storing a
  // preset again, stopping the Host, or marking it for good, so a cause that
  // has gone never lets it work again; binding it again clearing another
  // reason the integration is unavailable for; recovery losing its account, its
  // grant or the rows held toolRefs name; the failure left unlogged.
  it("keeps an integration it cannot store unavailable, and stores it on a later start once it can", async () => {
    const facts: { step: string; observed: unknown }[] = [];
    const recovering = await createMachineAccessDatabase(baseDatabaseUrl!);
    const closers: (() => Promise<unknown>)[] = [() => recovering.drop()];
    const stripe = integrationDefinitions.find(({ id }) => id === "stripe-rest")!;
    const calls: { authorization: string | null; method: string; url: string }[] = [];
    const integrationFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === (stripe.config as { specUrl: string }).specUrl)
        return Response.json(recoveringDocument);
      calls.push({
        authorization: request.headers.get("authorization"),
        method: request.method,
        url: request.url,
      });
      return Response.json({ ok: true });
    };
    const warnings = vi.spyOn(console, "warn");
    closers.unshift(async () => warnings.mockRestore());
    let passed = false;
    try {
      const host = await startMachineAccessHost(recovering.url, {
        integrationFetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Recovering caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "recovering-caller",
          name: "Recovering caller",
        }),
      });
      const run = await dispatchCallerRun(host, caller, { key: "recovering", title: "Read" });
      const gateway = await integrationGateway(run.integrationTools);
      const firstBoot = [() => gateway.close(), () => run.complete(), () => caller.close()];
      closers.unshift(...firstBoot);

      const store = new IntegrationInstallStore(host.store.database);
      const apiKey = { check: false, destinations: ["https://stored.example"] };
      const keyMethod = {
        id: "api-key",
        inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
        kind: "api-key",
        label: "API key",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
        ],
      };
      const install = async (input: {
        readonly bound: boolean;
        readonly definition: Parameters<typeof integrationDefinitionSummary>[0];
        readonly document: Json;
        readonly key: string;
      }) => {
        const config = OpenApiAdapterConfigSchema.parse({
          inline: input.document,
          credentialDestinations: apiKey.destinations,
        });
        const { definitions, tools } = extractOpenApiTools(input.document, config);
        const legacy = planLegacyOpenApiToolNames(
          tools.map(({ target }) => {
            const { method, path } = target as { method: string; path: string };
            const item = (input.document.paths as Json)[path] as Record<string, Json>;
            return { method, operationId: String(item[method]!.operationId), path };
          }),
        );
        const builtIn = input.definition.id === stripe.id;
        const installationId = createIntegrationId("installation");
        const serverId = createIntegrationId("server");
        await store.install({
          actorUserId: null,
          adapterSnapshot: { adapter: "openapi", config, definitionId: input.definition.id },
          installation: {
            description: input.definition.description,
            id: installationId,
            manifest: { definition: integrationDefinitionSummary(input.definition, apiKey) },
            name: input.definition.id,
            provenance: builtIn
              ? {
                  definitionDigest: "d".repeat(43),
                  definitionId: stripe.id,
                  maintainedBy: "opensteer",
                }
              : { artifactDigest: "d".repeat(43), proposalKind: "openapi" },
            sourceKind: builtIn ? "built-in" : "proposed",
            status: "active",
            title: input.definition.name,
            trust: builtIn ? "built-in" : "administrator-approved",
            version: "d".repeat(43),
          },
          requestId: `install-${input.key}`,
          servers: [
            {
              catalog: {
                definitions,
                tools: tools.map(({ target, ...tool }, index) => ({
                  ...tool,
                  ...(input.bound ? { target: target! } : {}),
                  annotations: tool.annotations ?? {},
                  connectionId: null,
                  id: createIntegrationId("tool"),
                  name: input.bound ? tool.name : legacy[index]!,
                  outputSchema: tool.outputSchema ?? null,
                  status: "active" as const,
                  title: input.bound ? tool.name : legacy[index]!,
                })),
              },
              connectionRequirement: {
                definitionId: input.definition.id,
                kind: "provider",
                provider: input.definition.provider,
                providerApplicationRequired: false,
              },
              id: serverId,
              name: "default",
              status: "active",
              statusDetail: null,
              transport: { adapter: "openapi", definitionId: input.definition.id, type: "adapter" },
            },
          ],
        });
        return { installationId, serverId };
      };
      const proposed = (key: string) =>
        IntegrationDefinitionSchema.parse({
          adapter: "openapi",
          authMethods: [keyMethod],
          config: { inline: recoveringDocument },
          description: `${key} fixture`,
          id: `stored-${key}`,
          name: `Stored ${key}`,
          provider: `stored-${key}`,
        });
      // As 0.1.131 left them: one to fail while binding, one held unavailable for
      // another reason, and a preset whose catalog changed since it was stored.
      const transient = await install({
        bound: false,
        definition: proposed("transient"),
        document: recoveringDocument,
        key: "transient",
      });
      const elsewhere = await install({
        bound: false,
        definition: proposed("elsewhere"),
        document: recoveringDocument,
        key: "elsewhere",
      });
      const preset = await install({
        bound: true,
        definition: stripe,
        document: recoveringDocument,
        key: "preset",
      });
      const disclosureReason =
        "Opensteer can’t tell where this integration sends its key. Remove it and install it again.";
      await host.store.database
        .updateTable("integrationServers")
        .set({ status: "needs-attention", statusDetail: disclosureReason })
        .where("id", "=", elsewhere.serverId as IntegrationServerId)
        .execute();
      await host.store.database
        .updateTable("integrationInstallations")
        .set({ status: "needs-attention" })
        .where("id", "=", elsewhere.installationId as IntegrationInstallationId)
        .execute();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "recovering-key",
          type: "integration.apiKey.connect",
          input: {
            authMethodId: "api-key",
            definitionId: "stored-transient",
            values: { apiKey: "stored-key" },
          },
        },
        { headers: host.ownerHeaders },
      );
      const connection = await host.store.database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("integrationDefinitionId", "=", "stored-transient")
        .executeTakeFirstOrThrow();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "recovering-grant",
          type: "integration.grant.create",
          input: {
            access: "read",
            alias: "Stored transient",
            connectionId: connection.id,
            installationId: transient.installationId,
            isDefault: true,
            workspaceId: run.workspaceId,
          },
        },
        { headers: host.ownerHeaders },
      );
      const grant = await host.store.database
        .selectFrom("integrationGrants")
        .selectAll()
        .where("installationId", "=", transient.installationId as IntegrationInstallationId)
        .executeTakeFirstOrThrow();
      const held = operation(
        await gateway.call("integration_search", { query: "3.detail" }),
        "3.detail",
      );
      const integration = async (
        database: typeof host.store.database,
        installed: { readonly installationId: string; readonly serverId: string },
      ) => ({
        installation: (
          await database
            .selectFrom("integrationInstallations")
            .select("status")
            .where("id", "=", installed.installationId as IntegrationInstallationId)
            .executeTakeFirstOrThrow()
        ).status,
        server: await database
          .selectFrom("integrationServers")
          .select(["status", "statusDetail"])
          .where("id", "=", installed.serverId as IntegrationServerId)
          .executeTakeFirstOrThrow(),
        tools: await database
          .selectFrom("integrationTools")
          .select(["id", "name", "status", "target"])
          .where("serverId", "=", installed.serverId as IntegrationServerId)
          .orderBy("id")
          .execute(),
      });
      const state = async (database: typeof host.store.database) => ({
        connection: await database
          .selectFrom("integrationConnections")
          .selectAll()
          .where("id", "=", connection.id)
          .executeTakeFirstOrThrow(),
        grant: await database
          .selectFrom("integrationGrants")
          .selectAll()
          .where("id", "=", grant.id)
          .executeTakeFirstOrThrow(),
        integrations: {
          elsewhere: await integration(database, elsewhere),
          preset: await integration(database, preset),
          transient: await integration(database, transient),
        },
      });
      const stored = await state(host.store.database);

      // A failure storing these two servers' tools, as a database refusing a write would be.
      await sql
        .raw(
          `create function public.refuse_tool_writes() returns trigger language plpgsql as $$
          begin
            if old.server_id in ('${transient.serverId}', '${preset.serverId}')
              and old.status = 'active' and new.status = 'disabled' then
              raise exception 'Injected tool-store failure';
            end if;
            return new;
          end $$;
          create trigger refuse_tool_writes before update on public.integration_tools
            for each row execute function public.refuse_tool_writes();`,
        )
        .execute(host.store.database);
      for (const close of firstBoot) await close();
      closers.splice(0, firstBoot.length);
      await host.runtime.close();
      const failing = await createHostRuntime(host.config, { integrationFetch, logger: false });
      const failed = await state(failing.store.database);
      await sql
        .raw(
          `drop trigger refuse_tool_writes on public.integration_tools;
          drop function public.refuse_tool_writes();`,
        )
        .execute(failing.store.database);
      await failing.close();
      expect(failed.connection).toEqual(stored.connection);
      expect(failed.grant).toEqual(stored.grant);
      expect(failed.integrations.transient).toEqual({
        ...stored.integrations.transient,
        installation: "needs-attention",
        server: { status: "needs-attention", statusDetail: unboundReason },
      });
      expect(failed.integrations.preset).toEqual({
        ...stored.integrations.preset,
        installation: "needs-attention",
        server: {
          status: "needs-attention",
          statusDetail: "Opensteer couldn’t update this integration. Reinstall it from its page.",
        },
      });
      expect(failed.integrations.elsewhere.server).toEqual({
        status: "needs-attention",
        statusDetail: disclosureReason,
      });
      expect(failed.integrations.elsewhere.tools.every(({ target }) => target !== null)).toBe(true);
      const logged = warnings.mock.calls.map((call) => call.map(String).join(" "));
      expect(logged.some((line) => line.includes("OpenAPI tools could not be bound"))).toBe(true);
      expect(logged.some((line) => line.includes("could not be stored again"))).toBe(true);
      expect(logged.filter((line) => line.includes("Injected tool-store failure"))).toHaveLength(2);
      facts.push({
        step: "a failure storing one integration leaves it unavailable, logged, and the Host started",
        observed: {
          transient: failed.integrations.transient.server,
          preset: failed.integrations.preset.server,
          elsewhere: failed.integrations.elsewhere.server,
        },
      });

      const restarted = await createHostRuntime(host.config, { integrationFetch, logger: false });
      closers.unshift(() => restarted.close());
      const recovered = await state(restarted.store.database);
      expect(recovered.connection).toEqual(stored.connection);
      expect(recovered.grant).toEqual(stored.grant);
      expect(recovered.integrations.transient).toEqual({
        installation: "active",
        server: { status: "active", statusDetail: null },
        tools: stored.integrations.transient.tools.map(({ id, name }) => ({
          id,
          name: name === "3.detail" ? "account.detail" : "items.listItems",
          status: "active",
          target: {
            method: "get",
            path: name === "3.detail" ? "/3/account" : "/3/items",
          },
        })),
      });
      expect(recovered.integrations.preset).toEqual({
        ...stored.integrations.preset,
        installation: "active",
        server: { status: "active", statusDetail: null },
      });
      expect(recovered.integrations.elsewhere.server).toEqual({
        status: "needs-attention",
        statusDetail: disclosureReason,
      });
      await restarted.listen();
      const started = { ...host, runtime: restarted, store: restarted.store };
      const nextCaller = await connectCallerMachine(started, {
        name: "Recovering caller again",
        token: await enrollmentToken(started, {
          allowedModules: ["agents"],
          idempotencyKey: "recovering-caller-again",
          name: "Recovering caller again",
        }),
      });
      closers.unshift(() => nextCaller.close());
      const nextRun = await dispatchCallerRun(started, nextCaller, {
        key: "recovering-again",
        title: "Read again",
        workspaceId: run.workspaceId,
      });
      closers.unshift(() => nextRun.complete());
      const nextGateway = await integrationGateway(nextRun.integrationTools);
      closers.unshift(() => nextGateway.close());
      const called = await nextGateway.callRaw("integration_call", {
        arguments: {},
        toolRef: held.toolRef,
      });
      expect(called.isError, toolText(called)).toBeFalsy();
      expect(calls).toEqual([
        {
          authorization: "Bearer stored-key",
          method: "GET",
          url: "https://stored.example/3/account",
        },
      ]);
      facts.push({
        step: "once the cause is gone the next start binds it and reinstalls the preset, keeping their rows",
        observed: { recovered: recovered.integrations, calls },
      });
      passed = true;
    } finally {
      for (const close of closers) await close();
      await mkdir(artifactDirectory, { recursive: true });
      const path = `${artifactDirectory}/recovered-tools-result.json`;
      await writeFile(path, JSON.stringify({ passed, facts }, null, 2));
      console.info(`Recovered OpenAPI tools E2E artifact: ${path}`);
    }
  }, 180_000);
});

const accountParameter = {
  in: "path",
  name: "account_id",
  required: true,
  schema: { type: "string" },
} as const;

const unboundReason =
  "Opensteer couldn’t read this integration’s API document after an update and tries again each time it starts. To use it now, uninstall it and add it again.";
// Paths 0.1.131 accepted that plan a name past 512 characters, and a target past 16 KB.
const longPath = `/3/${"x".repeat(510)}`;
const deepPath = `/3/account/${"y".repeat(17_000)}`;

/** An API both stored integrations and the preset's catalog document describe. */
const recoveringDocument: Json = {
  openapi: "3.1.0",
  info: { title: "Stored", version: "1" },
  servers: [{ url: "https://stored.example" }],
  security: [{ apiKey: [] }],
  components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer" } } },
  paths: {
    "/3/account": { get: { operationId: "detail", responses: {} } },
    "/3/items": { get: { operationId: "list-items", responses: {} } },
  },
};

/** Documents whose tools 0.1.131 named differently, each planned by a different rule. */
const storedDocuments: Record<string, Json> = {
  // TMDB's shape: a bare version segment, no tags, hyphenated operation IDs; one
  // path without the version keeps its name.
  tmdb: {
    openapi: "3.1.0",
    info: { title: "tmdb-api", version: "3" },
    servers: [{ url: "https://tmdb.example" }],
    paths: {
      "/3/account/{account_id}": {
        get: { operationId: "account-details", parameters: [accountParameter], responses: {} },
      },
      "/account/{account_id}/favorite": {
        post: {
          operationId: "account-add-favorite",
          parameters: [accountParameter],
          responses: {},
        },
      },
      "/3/authentication": { get: { operationId: "authentication-validate-key", responses: {} } },
    },
  },
  // The POST's method suffix is the name the last GET already had.
  suffix: {
    openapi: "3.1.0",
    info: { title: "Suffix collision", version: "1" },
    servers: [{ url: "https://suffix.example" }],
    paths: {
      "/3/account": { post: { operationId: "change", responses: {} } },
      "/account": { get: { operationId: "account.change", responses: {} } },
      "/account/current": { get: { operationId: "change-post", responses: {} } },
    },
  },
  // Two GETs that once had their own names and now plan one.
  method: {
    openapi: "3.1.0",
    info: { title: "Method collision", version: "1" },
    servers: [{ url: "https://method.example" }],
    paths: {
      "/3/account": { get: { operationId: "detail", responses: {} } },
      "/4/account": { get: { operationId: "account.detail", responses: {} } },
    },
  },
  long: {
    openapi: "3.1.0",
    info: { title: "Long segment", version: "1" },
    servers: [{ url: "https://long.example" }],
    paths: { [longPath]: { get: { operationId: "long-detail", responses: {} } } },
  },
  deep: {
    openapi: "3.1.0",
    info: { title: "Long path", version: "1" },
    servers: [{ url: "https://deep.example" }],
    paths: {
      [deepPath]: {
        get: { description: "Account details", operationId: "deep-detail", responses: {} },
      },
    },
  },
  // Its stored document is replaced by one without paths after its tools are stored.
  broken: {
    openapi: "3.1.0",
    info: { title: "Broken", version: "1" },
    servers: [{ url: "https://broken.example" }],
    paths: { "/3/broken": { get: { operationId: "broken-detail", responses: {} } } },
  },
};

function spec(
  options: {
    readonly method?: string;
    readonly security?: unknown;
    readonly body?: boolean;
    readonly duplicate?: boolean;
    readonly requiredHeader?: boolean;
    readonly collision?: {
      readonly location: "header" | "cookie";
      readonly argument: "query" | "path";
    };
  } = {},
): Json {
  const operation = {
    operationId: "checkKey",
    servers: [{ url: checkOrigin }],
    security: options.security ?? [{ privateKey: [] }],
    parameters: [
      ...(options.collision
        ? [
            {
              in: options.collision.argument,
              name: "X-HTTP-Method-Override",
              required: options.collision.argument === "path",
              schema: { type: "string" },
            },
          ]
        : []),
      {
        in: "header",
        name: "X-Region",
        required: options.requiredHeader ?? false,
        schema: { type: "string" },
      },
      {
        in: "query",
        name: "limit",
        required: true,
        schema: { type: "integer", minimum: 1, maximum: 2 },
      },
    ],
    responses: { 200: { description: "Accepted" } },
    ...(options.body
      ? { requestBody: { content: { "application/json": { schema: { type: "object" } } } } }
      : {}),
  };
  return {
    openapi: "3.1.0",
    info: { title: "Vapi fixture", version: "1" },
    servers: [{ url: origin }],
    components: { securitySchemes: { privateKey: { type: "http", scheme: "bearer" } } },
    security: [{ privateKey: [] }],
    paths: {
      [options.collision?.argument === "path" ? "/key/{X-HTTP-Method-Override}" : "/key"]: {
        ...(options.collision
          ? {
              parameters: [
                {
                  in: options.collision.location,
                  name: "X-HTTP-Method-Override",
                  required: false,
                  schema: { type: "string" },
                },
              ],
            }
          : {}),
        [options.method ?? "get"]: operation,
      },
      "/items": {
        get: {
          operationId: options.duplicate ? "checkKey" : "listItems",
          responses: { 200: { description: "Items" } },
        },
      },
    },
  };
}

async function upstream() {
  const requests: { origin: string; method: string; authorized: boolean }[] = [];
  const fetches: string[] = [];
  let rejectionStatus = 401;
  let catalogDestination = disclosedOrigin;
  const server = createServer((request, response) => {
    const good = request.headers.authorization === "Bearer fixture-private-good";
    response.writeHead(good ? 200 : rejectionStatus, { "content-type": "application/json" });
    response.end(
      good
        ? '{"accepted":true}'
        : JSON.stringify({ message: `RAW_PROVIDER_BODY ${request.headers.authorization}` }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fetchProvider: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    fetches.push(url.href);
    if (url.href === mutableCatalogSpecUrl)
      return Response.json({
        openapi: "3.1.0",
        info: { title: "Vercel", version: "1" },
        servers: [{ url: catalogDestination }],
        paths: {
          "/me": {
            get: { operationId: "getAuthUser", responses: { 200: { description: "User" } } },
          },
        },
      });
    if (![origin, checkOrigin, disclosedOrigin, undisclosedOrigin].includes(url.origin))
      throw new Error("Unexpected provider destination");
    requests.push({
      origin: url.origin,
      method: request.method,
      authorized: request.headers.get("authorization") === "Bearer fixture-private-good",
    });
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      headers: request.headers,
      method: request.method,
      signal: request.signal,
      redirect: "manual",
    });
  };
  return {
    fetch: fetchProvider,
    fetches,
    changeCatalogDestination: (destination: string) => {
      catalogDestination = destination;
    },
    rejectWith: (status: number) => {
      rejectionStatus = status;
    },
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
