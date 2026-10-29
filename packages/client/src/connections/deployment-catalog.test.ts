import { createId, type DeploymentId, type HostInstanceId } from "@opensteer/core";
import {
  ControlPlaneAccountIdSchema,
  AccountDeploymentDirectoryEntrySchema,
  type AccountDeploymentDirectoryEntry,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import {
  hostApiVersion,
  hostKeyFingerprint,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
  type TestHostAuthorityKeys,
} from "../test-support/index.js";
import {
  deploymentConnectionFromVerifiedEndpoints,
  DeploymentCatalogStore,
  ConnectionOriginSchema,
  DeploymentCatalogSchema,
  DeploymentConnectionInputSchema,
  DeploymentConnectionSchema,
  emptyDeploymentCatalog,
  maxDeploymentCatalogBytes,
  maxHostDiscoveryDocumentBytes,
  verifyAccessEndpoint,
  type DeploymentConnection,
  type DeploymentConnectionInput,
} from "./deployment-catalog.js";

const catalogPath = "/private/deployment-catalog.json";
const discoveryKeys = testHostAuthorityKeys();
const discoveryFingerprint = hostKeyFingerprint(discoveryKeys.spki);
const accountSource = {
  issuer: "https://accounts.opensteer.example",
  kind: "account" as const,
  subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
};

describe("DeploymentCatalogStore", () => {
  it("starts empty, serializes concurrent mutations, and persists selection state atomically", async () => {
    const files = new MemoryPrivateFilesystem();
    const times = [
      new Date("2026-08-11T10:00:00.000Z"),
      new Date("2026-08-11T10:01:00.000Z"),
      new Date("2026-08-11T10:02:00.000Z"),
      new Date("2026-08-11T10:03:00.000Z"),
    ];
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => times.shift() ?? new Date("2026-08-11T11:00:00.000Z"),
    });
    const local = deploymentInput({ kind: "self-hosted", name: "Studio Mac" });
    const cloud = deploymentInput({
      canonicalOrigin: "https://cloud.opensteer.example",
      kind: "self-hosted",
      name: "Opensteer Cloud",
    });

    await expect(store.load()).resolves.toEqual(emptyDeploymentCatalog());
    await Promise.all([store.upsert(local), store.upsert(cloud)]);

    let catalog = await store.load();
    expect(catalog.revision).toBe(2);
    expect(catalog.deployments.map(({ authority }) => authority.document.deploymentId)).toEqual([
      local.authority.document.deploymentId,
      cloud.authority.document.deploymentId,
    ]);
    expect(catalog.selectedDeploymentId).toBe(local.authority.document.deploymentId);

    catalog = await store.select(
      cloud.authority.document.deploymentId,
      new Date("2026-08-11T12:00:00.000Z"),
    );
    expect(catalog.selectedDeploymentId).toBe(cloud.authority.document.deploymentId);
    expect(
      catalog.deployments.find(
        ({ authority }) =>
          authority.document.deploymentId === cloud.authority.document.deploymentId,
      )?.lastUsedAt,
    ).toBe("2026-08-11T12:00:00.000Z");

    catalog = await store.remove(cloud.authority.document.deploymentId);
    expect(catalog.selectedDeploymentId).toBe(local.authority.document.deploymentId);
    expect(catalog.deployments).toEqual([expect.objectContaining(local)]);
    expect(catalog.revision).toBe(4);

    expect(DeploymentCatalogSchema.parse(JSON.parse(files.text(catalogPath) ?? ""))).toEqual(
      catalog,
    );
  });

  it("updates an existing Deployment without changing catalog order or selection", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const first = deploymentInput({ name: "Home" });
    const second = deploymentInput({ name: "Work" });
    await store.upsert(first);
    await store.upsert(second);
    await store.select(
      second.authority.document.deploymentId,
      new Date("2026-08-11T12:00:00.000Z"),
    );

    const updated = {
      ...first,
      name: "Home server",
    } satisfies DeploymentConnectionInput;
    const catalog = await store.upsert(updated);

    expect(catalog.deployments.map(({ authority }) => authority.document.deploymentId)).toEqual([
      first.authority.document.deploymentId,
      second.authority.document.deploymentId,
    ]);
    expect(catalog.deployments[0]?.name).toBe("Home server");
    expect(catalog.selectedDeploymentId).toBe(second.authority.document.deploymentId);
    expect(catalog.deployments[1]?.lastUsedAt).toBe("2026-08-11T12:00:00.000Z");
  });

  it("allows a manual entry's shape to change without changing Host identity", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const initial = deploymentInput({ name: "Home" });
    await store.upsert(initial);
    await expect(
      store.upsert({
        ...initial,
        kind: "personal" as const,
        authority: signDiscovery({
          ...initial.authority.document,
          deploymentShape: {
            defaultWorkspaceBacking: "local-directory",
            kind: "personal" as const,
          },
        }),
      }),
    ).resolves.toMatchObject({
      deployments: [expect.objectContaining({ kind: "personal" })],
    });
  });

  it("reconciles Account-owned Hosts without removing manual self-host routes", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const manual = deploymentInput({ kind: "self-hosted", name: "Manual" });
    const shared = deploymentInput({ kind: "self-hosted", name: "Shared" });
    const unavailable = deploymentInput({ kind: "self-hosted", name: "Offline" });
    await store.upsert(manual);
    await reconcileAccountDeployments(store, {
      connections: [shared],
      directoryDeployments: [accountDeployment(shared), accountDeployment(unavailable)],
    });

    let catalog = await store.load();
    expect(catalog.deployments.map(({ authority }) => authority.document.deploymentId)).toEqual([
      manual.authority.document.deploymentId,
      shared.authority.document.deploymentId,
    ]);
    const stableRevision = catalog.revision;
    catalog = await reconcileAccountDeployments(store, {
      connections: [shared],
      directoryDeployments: [accountDeployment(shared), accountDeployment(unavailable)],
    });
    expect(catalog.revision).toBe(stableRevision);

    catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [],
    });
    expect(catalog.deployments).toEqual([expect.objectContaining(manual)]);
  });

  it("scopes Account records by issuer and subject on account change and sign-out", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const manual = deploymentInput({ name: "Manual" });
    const first = deploymentInput({ kind: "self-hosted", name: "First Account" });
    const second = deploymentInput({ kind: "self-hosted", name: "Second Account" });
    const secondSource = {
      ...accountSource,
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    };
    await store.upsert(manual);
    await reconcileAccountDeployments(store, {
      connections: [first],
      directoryDeployments: [accountDeployment(first)],
    });

    await store.reconcileAccountDeployments({
      connections: [DeploymentConnectionInputSchema.parse({ ...second, source: secondSource })],
      directoryDeployments: [accountDeployment(second)],
      source: secondSource,
    });
    let catalog = await store.load();
    expect(catalog.deployments.map(({ name }) => name)).toEqual(["Manual", "Second Account"]);

    catalog = await store.removeAccountDeployments(secondSource);
    expect(catalog.deployments).toEqual([expect.objectContaining({ name: "Manual" })]);
  });

  it("keeps a same-machine Personal deployment local across Account Connect reconciliation", async () => {
    const files = new MemoryPrivateFilesystem();
    const local = thisDevicePersonalInput("This computer");
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      localPersonalManifest: { load: async () => manifestFor(local) },
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const route = personalAccessRoute(
      local.authority.document,
      "https://studio.connect.opensteer.example",
    );
    const remote = DeploymentConnectionInputSchema.parse({
      accountAccess: "owner",
      accountLivenessExpiresAt: null,
      authority: local.authority,
      bootstrapMethods: ["connect-grant"],
      endpoints: [
        {
          kind: "direct",
          origin: route.document.route.origin,
          verifiedAt: "2026-08-11T09:30:00.000Z",
        },
      ],
      kind: "personal" as const,
      name: "This computer",
      personalAccessRoute: route,
      preferredEndpointOrigin: route.document.route.origin,
      reachability: "routed",
      source: accountSource,
    });
    await store.upsert(local);

    let catalog = await reconcileAccountDeployments(store, {
      connections: [remote],
      directoryDeployments: [accountDeployment(remote)],
    });

    expect(catalog.deployments).toHaveLength(1);
    expect(catalog.deployments[0]).toMatchObject({
      endpoints: local.endpoints,
      kind: "personal" as const,
      name: "This computer",
      preferredEndpointOrigin: null,
      source: { kind: "manual" },
    });

    // Account silence or an Account lifecycle fence removes remote access on
    // other devices; neither owns the manifest and route on this computer.
    catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [],
    });
    expect(catalog.deployments[0]).toMatchObject({ source: { kind: "manual" } });
    catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [],
    });
    expect(catalog.deployments[0]).toMatchObject({ source: { kind: "manual" } });
  });

  it("does not let Account rewrite the manifest Deployment when its authority differs", async () => {
    const files = new MemoryPrivateFilesystem();
    const local = thisDevicePersonalInput("This computer");
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      localPersonalManifest: { load: async () => manifestFor(local) },
    });
    await store.upsert(local);
    const accountCandidate = DeploymentConnectionInputSchema.parse({
      ...local,
      authority: signDiscovery({
        ...local.authority.document,
        hostInstanceId: createId("hostInstance"),
      }),
      source: accountSource,
    });

    const catalog = await reconcileAccountDeployments(store, {
      connections: [accountCandidate],
      directoryDeployments: [accountDeployment(accountCandidate)],
    });
    expect(catalog.deployments).toEqual([
      expect.objectContaining({ authority: local.authority, source: { kind: "manual" } }),
    ]);
  });

  it("removes a stale Account record from a complete directory response", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const first = deploymentInput({ kind: "self-hosted", name: "First" });
    const second = deploymentInput({ kind: "self-hosted", name: "Second" });
    await reconcileAccountDeployments(store, {
      connections: [first, second],
      directoryDeployments: [accountDeployment(first), accountDeployment(second)],
    });
    await store.select(
      second.authority.document.deploymentId,
      new Date("2026-08-11T11:00:00.000Z"),
    );

    const catalog = await reconcileAccountDeployments(store, {
      connections: [first],
      directoryDeployments: [accountDeployment(first)],
    });
    expect(catalog.selectedDeploymentId).toBe(first.authority.document.deploymentId);
    expect(catalog.deployments.map(({ authority }) => authority.document.deploymentId)).toEqual([
      first.authority.document.deploymentId,
    ]);
  });

  it("still fences the selected Deployment when the directory reports it as gone", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const selected = deploymentInput({ kind: "self-hosted", name: "Selected" });
    await reconcileAccountDeployments(store, {
      connections: [selected],
      directoryDeployments: [accountDeployment(selected)],
    });

    const catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [],
    });
    expect(catalog.deployments).toEqual([]);
    expect(catalog.selectedDeploymentId).toBeNull();
  });

  it("does not advance the revision when the directory reorders the same Deployments", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const first = deploymentInput({ kind: "self-hosted", name: "First" });
    const second = deploymentInput({ kind: "self-hosted", name: "Second" });
    const before = await reconcileAccountDeployments(store, {
      connections: [first, second],
      directoryDeployments: [accountDeployment(first), accountDeployment(second)],
    });

    const after = await reconcileAccountDeployments(store, {
      connections: [second, first],
      directoryDeployments: [accountDeployment(second), accountDeployment(first)],
    });

    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.deployments.map(({ authority }) => authority.document.deploymentId)).toEqual([
      first.authority.document.deploymentId,
      second.authority.document.deploymentId,
    ]);
  });

  it("preserves an explicitly verified direct route across Account directory refreshes", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({
      filePath: catalogPath,
      privateFiles: files,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const accountConnection = deploymentInput({ kind: "self-hosted", name: "Home" });
    const canonicalOnly = DeploymentConnectionInputSchema.parse({
      ...accountConnection,
      endpoints: accountConnection.endpoints.filter(({ kind }) => kind === "canonical"),
    });
    await reconcileAccountDeployments(store, {
      connections: [canonicalOnly],
      directoryDeployments: [accountDeployment(canonicalOnly)],
    });
    await store.addVerifiedDirectEndpoint({
      deploymentId: canonicalOnly.authority.document.deploymentId,
      verified: {
        bootstrapMethods: ["password"],
        capabilities: [],
        discovery: canonicalOnly.authority.document,
        discoveryEnvelope: canonicalOnly.authority,
        endpoint: {
          kind: "direct",
          origin: "https://home.tailnet.example",
          verifiedAt: "2026-08-11T10:01:00.000Z",
        },
      },
    });
    const before = await store.load();

    const after = await reconcileAccountDeployments(store, {
      connections: [canonicalOnly],
      directoryDeployments: [accountDeployment(canonicalOnly)],
    });

    expect(after.revision).toBe(before.revision);
    expect(after.deployments[0]).toMatchObject({
      preferredEndpointOrigin: "https://home.tailnet.example",
      endpoints: [
        expect.objectContaining({ kind: "canonical" }),
        expect.objectContaining({ kind: "direct", origin: "https://home.tailnet.example" }),
      ],
    });
  });

  it("immediately fences a stale Account route during transfer or authority change", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const current = deploymentInput({ kind: "self-hosted", name: "Home" });
    await reconcileAccountDeployments(store, {
      connections: [current],
      directoryDeployments: [accountDeployment(current)],
    });

    let catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [],
    });
    expect(catalog.deployments).toEqual([]);
    expect(catalog.selectedDeploymentId).toBeNull();

    await reconcileAccountDeployments(store, {
      connections: [current],
      directoryDeployments: [accountDeployment(current)],
    });
    const moved = deploymentInput({
      canonicalOrigin: "https://moved.connect.opensteer.example",
      hostInstanceId: createId("hostInstance"),
      id: current.authority.document.deploymentId,
      kind: "self-hosted",
      name: "Home",
    });
    catalog = await reconcileAccountDeployments(store, {
      connections: [],
      directoryDeployments: [accountDeployment(moved)],
    });
    expect(catalog.deployments).toEqual([]);

    catalog = await reconcileAccountDeployments(store, {
      connections: [moved],
      directoryDeployments: [accountDeployment(moved)],
    });
    expect(catalog.deployments).toEqual([expect.objectContaining({ authority: moved.authority })]);
  });

  it("follows a verified Account directory Host key change", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const current = deploymentInput({ kind: "self-hosted", name: "Home" });
    await reconcileAccountDeployments(store, {
      connections: [current],
      directoryDeployments: [accountDeployment(current)],
    });
    const rotatedKeys = testHostAuthorityKeys();
    const attacker = DeploymentConnectionInputSchema.parse({
      ...current,
      authority: signWith(current.authority.document, rotatedKeys),
    });

    const catalog = await reconcileAccountDeployments(store, {
      connections: [attacker],
      directoryDeployments: [accountDeployment(attacker)],
    });
    expect(catalog.deployments).toEqual([
      expect.objectContaining({ authority: attacker.authority, source: accountSource }),
    ]);
  });

  it("pins a manual entry to its Host until the user removes and re-adds it", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const deploymentId = createId("deployment");
    const initial = deploymentInput({ id: deploymentId, name: "Home" });
    await store.upsert(initial);

    await expect(
      store.upsert({
        ...initial,
        authority: signDiscovery({
          ...initial.authority.document,
          hostInstanceId: createId("hostInstance"),
        }),
      }),
    ).rejects.toThrow("must be re-added");

    const transferred = deploymentInput({
      canonicalOrigin: "https://moved.connect.opensteer.example",
      id: deploymentId,
      name: "Home",
    });
    await expect(store.upsert(transferred)).rejects.toThrow("must be re-added");
    await store.remove(deploymentId);
    await expect(store.upsert(transferred)).resolves.toMatchObject({
      deployments: [expect.objectContaining({ authority: transferred.authority })],
    });
  });

  it("rejects selection of an unknown Deployment without replacing a valid catalog", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const saved = await store.upsert(deploymentInput({ name: "Home" }));

    await expect(store.select(createId("deployment"))).rejects.toThrow("not in the catalog");
    await expect(store.remove(createId("deployment"))).resolves.toEqual(saved);
    await expect(store.load()).resolves.toEqual(saved);
  });

  it("refuses an oversized catalog file before parsing it", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    files.put(catalogPath, new Uint8Array(maxDeploymentCatalogBytes + 1));

    await expect(store.load()).rejects.toThrow("size limit");
  });

  it("records the Account relation the directory reports and follows it when it changes", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const owned = deploymentInput({ kind: "self-hosted", name: "Home" });
    const directory = accountDeployment(owned);

    await reconcileAccountDeployments(store, {
      connections: [owned],
      directoryDeployments: [directory],
    });
    await expect(store.load()).resolves.toMatchObject({
      deployments: [expect.objectContaining({ accountAccess: "owner" })],
    });

    // Whether this Account owns the Deployment or merely belongs to it decides
    // what this computer may do with the listing, so the directory owns it.
    await reconcileAccountDeployments(store, {
      connections: [owned],
      directoryDeployments: [
        AccountDeploymentDirectoryEntrySchema.parse({ ...directory, access: "member" }),
      ],
    });
    await expect(store.load()).resolves.toMatchObject({
      deployments: [expect.objectContaining({ accountAccess: "member" })],
    });
  });

  it("loads a catalog written before the Account relation was recorded", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const current = persistedDeployment({ name: "Home" });
    const { accountAccess: _accountAccess, ...withoutRelation } = current;
    files.put(
      catalogPath,
      JSON.stringify({
        deployments: [withoutRelation],
        revision: 1,
        schemaVersion: emptyDeploymentCatalog().schemaVersion,
        selectedDeploymentId: current.authority.document.deploymentId,
        updatedAt: "2026-08-11T10:00:00.000Z",
      }),
    );

    await expect(store.load()).resolves.toMatchObject({
      deployments: [expect.objectContaining({ accountAccess: null })],
    });
  });

  it("loads a schema-four catalog whose signed authority uses the legacy backing name", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const current = persistedDeployment({ name: "Home" });
    const legacy = {
      ...current,
      authority: {
        ...current.authority,
        document: {
          ...current.authority.document,
          deploymentShape: { backing: "local-directory", kind: "personal" },
        },
      },
    };
    const serialized = JSON.stringify({
      deployments: [legacy],
      revision: 1,
      schemaVersion: emptyDeploymentCatalog().schemaVersion,
      selectedDeploymentId: current.authority.document.deploymentId,
      updatedAt: "2026-08-11T10:00:00.000Z",
    });
    files.put(catalogPath, serialized);

    await expect(store.load()).resolves.toMatchObject({
      deployments: [
        { authority: { document: { deploymentShape: { backing: "local-directory" } } } },
      ],
    });
    expect(files.text(catalogPath)).toBe(serialized);
  });

  it("fails closed on a catalog of its own version it cannot read", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const valid = deploymentInput({ name: "Home" });
    await store.upsert(valid);
    const persisted = JSON.parse(files.text(catalogPath) ?? "") as Record<string, unknown>;
    persisted.tunnelToken = "must-never-live-here";
    const corrupted = JSON.stringify(persisted);
    files.put(catalogPath, corrupted);

    // Presenting this as an empty catalog would silently discard every pairing
    // on this computer, so both reading and writing refuse until it is fixed.
    await expect(store.load()).rejects.toThrow("incompatible or corrupt");
    await expect(store.upsert(valid)).rejects.toThrow("incompatible or corrupt");
    expect(files.text(catalogPath)).toBe(corrupted);
  });

  it("fails closed on a catalog that is not JSON at all", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    files.put(catalogPath, "{ not json");

    await expect(store.load()).rejects.toThrow("not valid JSON");
  });

  it("discards another schema version without rewriting it", async () => {
    const files = new MemoryPrivateFilesystem();
    const store = new DeploymentCatalogStore({ filePath: catalogPath, privateFiles: files });
    const current = persistedDeployment({ name: "Home" });
    const oldCatalog = JSON.stringify({
      deployments: [current],
      revision: 1,
      schemaVersion: 6,
      selectedDeploymentId: current.authority.document.deploymentId,
      updatedAt: "2026-08-11T10:00:00.000Z",
    });
    files.put(catalogPath, oldCatalog);

    await expect(store.load()).resolves.toEqual(emptyDeploymentCatalog());
    expect(files.text(catalogPath)).toBe(oldCatalog);
  });
});

describe("Deployment connection schemas", () => {
  it.each([
    "https://connect.opensteer.example",
    "https://host.tailnet.example:8443",
    "http://localhost:4310",
    "http://127.99.0.4:4310",
    "http://[::1]:4310",
  ])("accepts canonical secure or loopback origin %s", (origin) => {
    expect(ConnectionOriginSchema.parse(origin)).toBe(origin);
  });

  it.each([
    "http://192.168.1.20:4310",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/",
    "https://EXAMPLE.com",
    "ftp://example.com",
  ])("rejects unsafe or noncanonical origin %s", (origin) => {
    expect(() => ConnectionOriginSchema.parse(origin)).toThrow();
  });

  it("requires one verified canonical route, unique endpoint origins, and strict fields", () => {
    const valid = persistedDeployment({ name: "Home" });
    expect(DeploymentConnectionSchema.parse(valid)).toEqual(valid);
    expect(DeploymentConnectionInputSchema.parse(deploymentInput({ name: "Home" }))).toBeDefined();

    expect(() =>
      DeploymentConnectionSchema.parse({
        ...valid,
        endpoints: [
          ...valid.endpoints,
          {
            kind: "direct",
            origin: valid.authority.document.canonicalOrigin,
            verifiedAt: "2026-08-11T09:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      DeploymentConnectionSchema.parse({
        ...valid,
        endpoints: valid.endpoints.map((endpoint) => ({ ...endpoint, kind: "direct" })),
      }),
    ).toThrow();
    expect(() => DeploymentConnectionSchema.parse({ ...valid, tunnelToken: "secret" })).toThrow();
    expect(() =>
      DeploymentConnectionInputSchema.parse({
        ...deploymentInput({ name: "Home" }),
        endpoints: valid.endpoints.map((endpoint) => ({ ...endpoint, kind: "direct" })),
      }),
    ).toThrow();
  });

  it("requires a unique stable Deployment ID and a selected record", () => {
    const valid = persistedDeployment({ name: "Home" });
    expect(() =>
      DeploymentCatalogSchema.parse({
        deployments: [valid, valid],
        revision: 1,
        schemaVersion: 1,
        selectedDeploymentId: valid.authority.document.deploymentId,
        updatedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      DeploymentCatalogSchema.parse({
        deployments: [valid],
        revision: 1,
        schemaVersion: 1,
        selectedDeploymentId: null,
        updatedAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      DeploymentConnectionSchema.parse({
        ...valid,
        authority: {
          ...valid.authority,
          document: { ...valid.authority.document, deploymentId: "../../home" },
        },
      }),
    ).toThrow();
  });
});

describe("Host endpoint verification", () => {
  it("fetches the fixed bounded discovery route and builds one connection from matching routes", async () => {
    const input = deploymentInput({ name: "Home" });
    const discovery = input.authority.document;
    const fetchFn = vi.fn(async () => jsonResponse(discovery, { "cache-control": "no-store" }));

    const canonical = await verifyAccessEndpoint({
      expectedDeploymentId: discovery.deploymentId,
      fetch: fetchFn,
      kind: "canonical",
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      origin: discovery.canonicalOrigin,
    });
    const direct = await verifyAccessEndpoint({
      expectedDiscovery: discovery,
      fetch: async () => jsonResponse(discovery),
      kind: "direct",
      now: () => new Date("2026-08-11T10:01:00.000Z"),
      origin: "https://home.tailnet.example",
    });

    expect(fetchFn).toHaveBeenCalledWith(
      `${discovery.canonicalOrigin}/.well-known/opensteer`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [canonical, direct],
        kind: "self-hosted",
        name: "Studio Mac",
        source: { kind: "manual" },
      }),
    ).toEqual({
      accountAccess: null,
      authority: signDiscovery(discovery),
      bootstrapMethods: ["password"],
      capabilities: [],
      endpoints: [canonical.endpoint, direct.endpoint],
      kind: "self-hosted",
      name: "Studio Mac",
      reachability: "canonical",
      source: { kind: "manual" },
    });
  });

  it("rejects a wrong Deployment, a canonical-route mismatch, and mixed Host identities", async () => {
    const first = deploymentInput({ name: "First" }).authority.document;
    const second = deploymentInput({ name: "Second" }).authority.document;

    await expect(
      verifyAccessEndpoint({
        expectedDeploymentId: second.deploymentId,
        fetch: async () => jsonResponse(first),
        kind: "canonical",
        origin: first.canonicalOrigin,
      }),
    ).rejects.toThrow("another Deployment");
    await expect(
      verifyAccessEndpoint({
        fetch: async () => jsonResponse(first),
        kind: "canonical",
        origin: "https://wrong.connect.opensteer.example",
      }),
    ).rejects.toThrow("does not match");

    const endpoint = {
      kind: "canonical" as const,
      origin: first.canonicalOrigin,
      verifiedAt: "2026-08-11T10:00:00.000Z",
    };
    expect(() =>
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [
          {
            bootstrapMethods: ["password"],
            capabilities: [],
            discovery: first,
            discoveryEnvelope: signDiscovery(first),
            endpoint,
          },
          {
            bootstrapMethods: ["password"],
            capabilities: [],
            discovery: second,
            discoveryEnvelope: signDiscovery(second),
            endpoint: {
              kind: "direct",
              origin: "https://home.tailnet.example",
              verifiedAt: "2026-08-11T10:00:00.000Z",
            },
          },
        ],
        kind: "self-hosted",
        name: "Mixed",
        source: { kind: "manual" },
      }),
    ).toThrow("same Deployment Host");
  });

  it("names which side is behind before it verifies identity or carries capabilities", async () => {
    const input = deploymentInput({ name: "Home" });
    const discovery = input.authority.document;
    const descriptorWithout = (epoch: number | undefined) =>
      new Response(
        JSON.stringify({
          ...(epoch === undefined ? {} : { apiVersion: epoch }),
          authority: signDiscovery(discovery),
          bootstrapMethods: ["password"],
          capabilities: ["native-oauth", "invented-later"],
        }),
        { headers: { "content-type": "application/json; charset=utf-8" }, status: 200 },
      );

    await expect(
      verifyAccessEndpoint({
        fetch: async () => descriptorWithout(undefined),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toMatchObject({ code: "host-too-old" });
    await expect(
      verifyAccessEndpoint({
        fetch: async () => descriptorWithout(hostApiVersion + 1),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toMatchObject({ code: "client-too-old" });

    const verified = await verifyAccessEndpoint({
      fetch: async () => descriptorWithout(hostApiVersion),
      kind: "canonical",
      origin: discovery.canonicalOrigin,
    });
    expect(verified.capabilities).toEqual(["native-oauth"]);
  });

  it("answers about the epoch even when the identity would have failed too", async () => {
    const discovery = deploymentInput({ name: "Home" }).authority.document;
    const forged = signTestDiscoveryEnvelope(discovery, testHostAuthorityKeys());

    await expect(
      verifyAccessEndpoint({
        expectedDeploymentId: discovery.deploymentId,
        expectedHostKeyFingerprint: discoveryFingerprint,
        fetch: async () =>
          Response.json({
            apiVersion: hostApiVersion + 1,
            authority: forged,
            bootstrapMethods: [],
            capabilities: [],
          }),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toMatchObject({ classification: "blocked", code: "client-too-old" });
  });

  it("requires proof of possession for the centrally pinned Host key", async () => {
    const legitimateConnection = deploymentInput({ name: "Home" });
    const legitimate = legitimateConnection.authority.document;
    const forged = signTestDiscoveryEnvelope(legitimate, testHostAuthorityKeys());

    await expect(
      verifyAccessEndpoint({
        expectedDeploymentId: legitimate.deploymentId,
        expectedHostKeyFingerprint: discoveryFingerprint,
        fetch: async () => envelopeResponse(forged),
        kind: "canonical",
        origin: legitimate.canonicalOrigin,
      }),
    ).rejects.toThrow("Host key does not match");
  });

  it("rejects non-JSON, declared oversized, and streamed oversized discovery responses", async () => {
    const discovery = deploymentInput({ name: "Home" }).authority.document;
    await expect(
      verifyAccessEndpoint({
        fetch: async () => new Response("not json", { headers: { "content-type": "text/plain" } }),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toThrow("application/json");
    await expect(
      verifyAccessEndpoint({
        fetch: async () =>
          new Response("{}", {
            headers: {
              "content-length": String(maxHostDiscoveryDocumentBytes + 1),
              "content-type": "application/json",
            },
          }),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toThrow("size limit");
    await expect(
      verifyAccessEndpoint({
        fetch: async () =>
          new Response("x".repeat(maxHostDiscoveryDocumentBytes + 1), {
            headers: { "content-type": "application/json" },
          }),
        kind: "canonical",
        origin: discovery.canonicalOrigin,
      }),
    ).rejects.toThrow("size limit");
  });

  it("bounds discovery time and honors caller cancellation", async () => {
    const discovery = deploymentInput({ name: "Home" }).authority.document;
    const pendingFetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing signal"));
        const rejectFromAbort = () => reject(signal.reason);
        if (signal.aborted) rejectFromAbort();
        else signal.addEventListener("abort", rejectFromAbort, { once: true });
      });

    await expect(
      verifyAccessEndpoint({
        fetch: pendingFetch,
        kind: "canonical",
        origin: discovery.canonicalOrigin,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out");

    const controller = new AbortController();
    const cancelled = verifyAccessEndpoint({
      fetch: pendingFetch,
      kind: "canonical",
      origin: discovery.canonicalOrigin,
      signal: controller.signal,
    });
    controller.abort(new Error("user cancelled"));
    await expect(cancelled).rejects.toThrow("user cancelled");
  });
});

function deploymentInput(input: {
  readonly accountAccess?: "owner" | "member" | null;
  readonly canonicalOrigin?: string;
  readonly hostInstanceId?: HostInstanceId;
  readonly id?: DeploymentId;
  readonly kind?: DeploymentConnectionInput["kind"];
  readonly name: string;
}): DeploymentConnectionInput {
  const canonicalOrigin = input.canonicalOrigin ?? "https://home.connect.opensteer.example";
  return DeploymentConnectionInputSchema.parse({
    accountAccess: input.accountAccess ?? null,
    authority: signDiscovery({
      canonicalOrigin,
      deploymentId: input.id ?? createId("deployment"),
      hostInstanceId: input.hostInstanceId ?? createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
    }),
    bootstrapMethods: ["password"],
    endpoints: [
      {
        kind: "canonical",
        origin: canonicalOrigin,
        verifiedAt: "2026-08-11T09:00:00.000Z",
      },
      {
        kind: "direct",
        origin: "https://home.tailnet.example",
        verifiedAt: "2026-08-11T09:00:00.000Z",
      },
    ],
    kind: input.kind ?? "self-hosted",
    name: input.name,
    reachability: "canonical",
    source: { kind: "manual" },
  });
}

function persistedDeployment(input: Parameters<typeof deploymentInput>[0]): DeploymentConnection {
  return DeploymentConnectionSchema.parse({
    ...deploymentInput(input),
    createdAt: "2026-08-11T09:00:00.000Z",
    lastUsedAt: null,
    updatedAt: "2026-08-11T09:00:00.000Z",
  });
}

function accountDeployment(connection: DeploymentConnectionInput): AccountDeploymentDirectoryEntry {
  const reachability = connection.reachability;
  const accessRoute =
    connection.reachability === "routed" ? (connection.personalAccessRoute ?? null) : null;
  const common = {
    access: connection.accountAccess ?? ("owner" as const),
    generation: 1,
    id: connection.authority.document.deploymentId,
    name: connection.name,
    updatedAt: "2026-08-11T09:00:00.000Z",
  };
  return AccountDeploymentDirectoryEntrySchema.parse({
    ...common,
    authorityEnvelope: connection.authority,
    authority: {
      canonicalOrigin: connection.authority.document.canonicalOrigin,
      deploymentId: connection.authority.document.deploymentId,
      hostInstanceId: connection.authority.document.hostInstanceId,
      hostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
    },
    lifecycle: "active",
    ...(reachability === "routed"
      ? {
          accountLink: {
            generation: "a".repeat(43),
            issuer: accountSource.issuer,
            subject: accountSource.subject,
          },
          connectResourceState: accessRoute ? "ready" : "disabled",
          connectRoute: accessRoute,
          lastSeenAt: accessRoute
            ? {
                expiresAt: "2099-08-11T09:32:00.000Z",
                observedAt: "2026-08-11T09:30:00.000Z",
              }
            : null,
          reachability,
        }
      : { canonicalOrigin: connection.authority.document.canonicalOrigin, reachability }),
  });
}

function thisDevicePersonalInput(name: string): DeploymentConnectionInput {
  const base = deploymentInput({ name });
  const canonicalOrigin = "http://127.0.0.1:4310";
  return DeploymentConnectionInputSchema.parse({
    ...base,
    authority: signDiscovery({
      ...base.authority.document,
      canonicalOrigin,
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    }),
    endpoints: [
      {
        kind: "canonical",
        origin: canonicalOrigin,
        verifiedAt: "2026-08-11T09:00:00.000Z",
      },
    ],
    kind: "personal" as const,
    preferredEndpointOrigin: null,
    reachability: "canonical",
    source: { kind: "manual" },
  });
}

function manifestFor(connection: DeploymentConnectionInput) {
  return {
    deploymentId: connection.authority.document.deploymentId,
    hostInstanceId: connection.authority.document.hostInstanceId,
    hostKeyFingerprint: discoveryFingerprint,
    hostPort: Number(new URL(connection.authority.document.canonicalOrigin).port),
  };
}

function personalAccessRoute(
  authority: HostDiscoveryDocument,
  origin: string,
): PersonalHostAccessRouteEnvelope {
  const document = {
    authority,
    documentVersion: 2 as const,
    purpose: "opensteer-personal-access-route" as const,
    route: { generation: 1, kind: "connect" as const, origin },
  };
  return signTestPersonalAccessRoute(document, discoveryKeys);
}

function reconcileAccountDeployments(
  store: DeploymentCatalogStore,
  input: {
    readonly connections: readonly DeploymentConnectionInput[];
    readonly directoryDeployments: readonly AccountDeploymentDirectoryEntry[];
  },
) {
  return store.reconcileAccountDeployments({
    ...input,
    connections: input.connections.map((connection) =>
      DeploymentConnectionInputSchema.parse({
        ...connection,
        // The directory sync builds every Account connection from the entry it
        // verified, so the relation on the connection is the directory's.
        accountAccess:
          input.directoryDeployments.find(
            ({ id }) => id === connection.authority.document.deploymentId,
          )?.access ?? connection.accountAccess,
        source: accountSource,
      }),
    ),
    source: accountSource,
  });
}

function jsonResponse(
  discovery: HostDiscoveryDocument,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return envelopeResponse(signDiscovery(discovery), headers);
}

function signDiscovery(discovery: HostDiscoveryDocument): HostDiscoveryEnvelope {
  return signWith(discovery, discoveryKeys);
}

function signWith(
  discovery: HostDiscoveryDocument,
  keys: TestHostAuthorityKeys,
): HostDiscoveryEnvelope {
  return signTestDiscoveryEnvelope(discovery, keys);
}

function envelopeResponse(
  envelope: HostDiscoveryEnvelope,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify({
      apiVersion: hostApiVersion,
      authority: envelope,
      bootstrapMethods: ["password"],
      capabilities: [],
    }),
    {
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
      status: 200,
    },
  );
}
