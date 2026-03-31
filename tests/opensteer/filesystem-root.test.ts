import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createFilesystemOpensteerRoot } from "../../packages/opensteer/src/index.js";
import { bodyPayloadFromUtf8 } from "../../packages/protocol/src/network.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-phase3-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

async function listTree(rootPath: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries: string[] = [];

  async function visit(directoryPath: string, prefix: string): Promise<void> {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const relativePath = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        entries.push(`${relativePath}/`);
        await visit(path.join(directoryPath, child.name), relativePath);
      } else {
        entries.push(relativePath);
      }
    }
  }

  await visit(rootPath, "");
  return entries.sort((left, right) => left.localeCompare(right));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
});

function requestPlanPayload(urlTemplate: string) {
  return {
    transport: {
      kind: "session-http",
      requiresBrowser: true,
    },
    endpoint: {
      method: "GET",
      urlTemplate,
    },
  } as const;
}

describe("Phase 3 filesystem root", () => {
  test("initializes the root layout idempotently and only creates the expected tree", async () => {
    const rootPath = await createTemporaryRoot();

    const first = await createFilesystemOpensteerRoot({
      rootPath,
      createdAt: 100,
    });
    const second = await createFilesystemOpensteerRoot({
      rootPath,
    });

    expect(second.manifest).toEqual(first.manifest);
    expect(await listTree(rootPath)).toEqual([
      "artifacts/",
      "artifacts/manifests/",
      "artifacts/objects/",
      "artifacts/objects/sha256/",
      "opensteer-root.json",
      "registry/",
      "registry/auth-recipes/",
      "registry/auth-recipes/indexes/",
      "registry/auth-recipes/indexes/by-key/",
      "registry/auth-recipes/records/",
      "registry/descriptors/",
      "registry/descriptors/indexes/",
      "registry/descriptors/indexes/by-key/",
      "registry/descriptors/records/",
      "registry/interaction-traces/",
      "registry/interaction-traces/indexes/",
      "registry/interaction-traces/indexes/by-key/",
      "registry/interaction-traces/records/",
      "registry/request-plans/",
      "registry/request-plans/indexes/",
      "registry/request-plans/indexes/by-key/",
      "registry/request-plans/records/",
      "registry/reverse-cases/",
      "registry/reverse-cases/indexes/",
      "registry/reverse-cases/indexes/by-key/",
      "registry/reverse-cases/records/",
      "registry/reverse-packages/",
      "registry/reverse-packages/indexes/",
      "registry/reverse-packages/indexes/by-key/",
      "registry/reverse-packages/records/",
      "registry/reverse-reports/",
      "registry/reverse-reports/indexes/",
      "registry/reverse-reports/indexes/by-key/",
      "registry/reverse-reports/records/",
      "traces/",
      "traces/runs/",
    ]);
  });

  test("lazily creates saved-network sqlite files on first saved-network use", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });
    const databasePath = path.join(root.registryPath, "saved-network.sqlite");
    const shmPath = `${databasePath}-shm`;
    const walPath = `${databasePath}-wal`;

    await root.registry.savedNetwork.initialize();

    expect(
      await Promise.all([pathExists(databasePath), pathExists(shmPath), pathExists(walPath)]),
    ).toEqual([false, false, false]);

    const savedCount = await root.registry.savedNetwork.save(
      [
        {
          recordId: "record:saved-network-lazy",
          actionId: "action:saved-network-lazy",
          savedAt: 200,
          record: {
            kind: "http",
            requestId: "request:saved-network-lazy",
            sessionRef: "session:saved-network-lazy",
            pageRef: "page:saved-network-lazy",
            method: "GET",
            url: "https://example.com/api/lazy?step=1",
            requestHeaders: [
              {
                name: "accept",
                value: "application/json",
              },
            ],
            responseHeaders: [
              {
                name: "content-type",
                value: "application/json",
              },
            ],
            status: 200,
            statusText: "OK",
            resourceType: "fetch",
            navigationRequest: false,
            captureState: "complete",
            requestBodyState: "skipped",
            responseBodyState: "skipped",
          },
        },
      ],
      {
        tag: "lazy-network-tag",
        bodyWriteMode: "authoritative",
      },
    );

    expect(savedCount).toBe(1);
    expect(await pathExists(databasePath)).toBe(true);

    expect(
      await root.registry.savedNetwork.query({
        tag: "lazy-network-tag",
        path: "/api/lazy",
        limit: 10,
      }),
    ).toMatchObject([
      {
        recordId: "record:saved-network-lazy",
        actionId: "action:saved-network-lazy",
        tags: ["lazy-network-tag"],
        savedAt: 200,
        record: {
          requestId: "request:saved-network-lazy",
          sessionRef: "session:saved-network-lazy",
          pageRef: "page:saved-network-lazy",
          method: "GET",
          url: "https://example.com/api/lazy?step=1",
          status: 200,
          statusText: "OK",
          resourceType: "fetch",
          navigationRequest: false,
          captureState: "complete",
          requestBodyState: "skipped",
          responseBodyState: "skipped",
        },
      },
    ]);
    expect(await root.registry.savedNetwork.clear({ tag: "lazy-network-tag" })).toBe(1);
    expect(await root.registry.savedNetwork.query({ tag: "lazy-network-tag" })).toEqual([]);
  });

  test("preserves persisted bodies during metadata-only upserts", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });
    const responseBody = bodyPayloadFromUtf8("network:live", {
      mimeType: "text/plain",
    });

    await root.registry.savedNetwork.save(
      [
        {
          recordId: "record:body-preserve",
          savedAt: 100,
          record: {
            kind: "http",
            requestId: "request:body-preserve",
            sessionRef: "session:body-preserve",
            pageRef: "page:body-preserve",
            method: "GET",
            url: "https://example.com/api/body-preserve",
            requestHeaders: [],
            responseHeaders: [
              {
                name: "content-type",
                value: "text/plain; charset=utf-8",
              },
            ],
            status: 200,
            statusText: "OK",
            resourceType: "fetch",
            navigationRequest: false,
            captureState: "complete",
            requestBodyState: "skipped",
            responseBodyState: "complete",
            requestBodySkipReason: "not-present",
            responseBody,
          },
        },
      ],
      {
        bodyWriteMode: "authoritative",
      },
    );

    await root.registry.savedNetwork.save(
      [
        {
          recordId: "record:body-preserve-refresh",
          savedAt: 200,
          record: {
            kind: "http",
            requestId: "request:body-preserve",
            sessionRef: "session:body-preserve",
            pageRef: "page:body-preserve",
            method: "GET",
            url: "https://example.com/api/body-preserve",
            requestHeaders: [],
            responseHeaders: [
              {
                name: "content-type",
                value: "text/plain; charset=utf-8",
              },
            ],
            status: 200,
            statusText: "OK",
            resourceType: "fetch",
            navigationRequest: false,
            captureState: "complete",
            requestBodyState: "skipped",
            responseBodyState: "pending",
            requestBodySkipReason: "not-present",
          },
        },
      ],
      {
        bodyWriteMode: "metadata-only",
      },
    );

    await expect(
      root.registry.savedNetwork.query({
        requestId: "request:body-preserve",
        includeBodies: true,
        limit: 1,
      }),
    ).resolves.toMatchObject([
      {
        recordId: "record:body-preserve",
        savedAt: 100,
        record: {
          requestId: "request:body-preserve",
          responseBodyState: "complete",
          responseBody,
        },
      },
    ]);
  });

  test("stores structured and binary artifacts with stable hashes and protocol adapters", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const screenshotBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const screenshotArtifact = await root.artifacts.writeBinary({
      artifactId: "artifact:screenshot-a",
      kind: "screenshot",
      createdAt: 100,
      scope: {
        sessionRef: "session:main",
        pageRef: "page:main",
      },
      mediaType: "image/webp",
      data: screenshotBytes,
    });
    const duplicateBinary = await root.artifacts.writeBinary({
      artifactId: "artifact:screenshot-b",
      kind: "screenshot",
      createdAt: 101,
      scope: {
        sessionRef: "session:main",
      },
      mediaType: "image/webp",
      data: screenshotBytes,
    });
    const domSnapshotArtifact = await root.artifacts.writeStructured({
      artifactId: "artifact:dom-a",
      kind: "dom-snapshot",
      createdAt: 110,
      scope: {
        sessionRef: "session:main",
        pageRef: "page:main",
        frameRef: "frame:main",
        documentRef: "document:main",
        documentEpoch: 0,
      },
      data: {
        pageRef: "page:main",
        frameRef: "frame:main",
        documentRef: "document:main",
        documentEpoch: 0,
        url: "https://example.com",
        capturedAt: 110,
        rootSnapshotNodeId: 1,
        shadowDomMode: "flattened",
        nodes: [],
      },
    });

    expect(duplicateBinary.objectRelativePath).toBe(screenshotArtifact.objectRelativePath);
    expect(screenshotArtifact.objectRelativePath).toMatch(
      /^artifacts\/objects\/sha256\/[0-9a-f]+\.webp$/,
    );
    expect(duplicateBinary.sha256).toBe(screenshotArtifact.sha256);

    const binaryRecord = await root.artifacts.read(screenshotArtifact.artifactId);
    const structuredRecord = await root.artifacts.read(domSnapshotArtifact.artifactId);
    expect(binaryRecord?.payload.payloadType).toBe("binary");
    expect(
      Array.from(
        binaryRecord?.payload.payloadType === "binary"
          ? binaryRecord.payload.data
          : new Uint8Array(),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(structuredRecord).toMatchObject({
      manifest: {
        mediaType: "application/json",
        payloadType: "structured",
      },
      payload: {
        payloadType: "structured",
        data: {
          url: "https://example.com",
          shadowDomMode: "flattened",
        },
      },
    });

    const screenshotProtocolArtifact = await root.artifacts.toProtocolArtifact(
      screenshotArtifact.artifactId,
    );
    const domProtocolArtifact = await root.artifacts.toProtocolArtifact(
      domSnapshotArtifact.artifactId,
      {
        delivery: "inline-if-structured",
      },
    );

    expect(screenshotProtocolArtifact?.payload).toMatchObject({
      delivery: "external",
      uri: expect.stringMatching(/\.webp$/),
      mimeType: "image/webp",
      byteLength: 5,
      sha256: screenshotArtifact.sha256,
    });
    expect(domProtocolArtifact?.payload).toEqual({
      delivery: "inline",
      data: {
        pageRef: "page:main",
        frameRef: "frame:main",
        documentRef: "document:main",
        documentEpoch: 0,
        url: "https://example.com",
        capturedAt: 110,
        rootSnapshotNodeId: 1,
        shadowDomMode: "flattened",
        nodes: [],
      },
    });
  });

  test("records ordered traces and builds protocol-compatible trace bundles", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const screenshotArtifact = await root.artifacts.writeBinary({
      artifactId: "artifact:screenshot",
      kind: "screenshot",
      createdAt: 100,
      scope: {
        sessionRef: "session:main",
        pageRef: "page:main",
      },
      mediaType: "image/webp",
      data: new Uint8Array([9, 8, 7]),
    });
    const domArtifact = await root.artifacts.writeStructured({
      artifactId: "artifact:dom",
      kind: "dom-snapshot",
      createdAt: 101,
      scope: {
        sessionRef: "session:main",
        pageRef: "page:main",
      },
      data: {
        pageRef: "page:main",
        frameRef: "frame:main",
        documentRef: "document:main",
        documentEpoch: 0,
        url: "https://example.com",
        capturedAt: 101,
        rootSnapshotNodeId: 1,
        shadowDomMode: "flattened",
        nodes: [],
      },
    });
    const screenshotReference = await root.artifacts.toProtocolArtifactReference(
      screenshotArtifact.artifactId,
      "result",
    );
    const domReference = await root.artifacts.toProtocolArtifactReference(
      domArtifact.artifactId,
      "capture",
    );
    const run = await root.traces.createRun({
      runId: "run:session-main",
      createdAt: 90,
    });

    const first = await root.traces.append(run.runId, {
      operation: "input.mouse-click",
      outcome: "ok",
      startedAt: 100,
      completedAt: 125,
      context: {
        sessionRef: "session:main",
        pageRef: "page:main",
      },
      events: [
        {
          eventId: "event:1",
          kind: "console",
          timestamp: 110,
          sessionRef: "session:main",
          level: "log",
          text: "clicked",
        },
      ],
      artifacts: [screenshotReference!, domReference!],
      data: {
        clicked: true,
      },
    });
    const second = await root.traces.append(run.runId, {
      operation: "page.navigate",
      outcome: "error",
      startedAt: 130,
      completedAt: 150,
      context: {
        sessionRef: "session:main",
        pageRef: "page:main",
      },
      error: {
        code: "timeout",
        message: "navigation timed out",
        retriable: true,
      },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect((await root.traces.listEntries(run.runId)).map((entry) => entry.traceId)).toEqual([
      first.traceId,
      second.traceId,
    ]);

    const bundle = await root.traces.readProtocolTraceBundle(run.runId, first.traceId, {
      artifactDelivery: "inline-if-structured",
    });

    expect(bundle?.trace).toMatchObject({
      traceId: first.traceId,
      stepId: first.stepId,
      operation: "input.mouse-click",
      outcome: "ok",
      durationMs: 25,
      artifacts: [screenshotReference, domReference],
    });
    expect(bundle?.artifacts).toHaveLength(2);
    expect(bundle?.artifacts?.[0]?.payload).toMatchObject({
      delivery: "external",
      mimeType: "image/webp",
    });
    expect(bundle?.artifacts?.[1]?.payload).toEqual({
      delivery: "inline",
      data: {
        pageRef: "page:main",
        frameRef: "frame:main",
        documentRef: "document:main",
        documentEpoch: 0,
        url: "https://example.com",
        capturedAt: 101,
        rootSnapshotNodeId: 1,
        shadowDomMode: "flattened",
        nodes: [],
      },
    });
  });

  test("fails trace bundle materialization when a referenced artifact is missing", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });
    const run = await root.traces.createRun({
      runId: "run:missing-artifact",
      createdAt: 100,
    });
    const entry = await root.traces.append(run.runId, {
      operation: "artifact.capture-screenshot",
      outcome: "ok",
      startedAt: 100,
      completedAt: 110,
      artifacts: [
        {
          artifactId: "artifact:missing",
          kind: "screenshot",
          relation: "result",
        },
      ],
    });

    await expect(root.traces.readProtocolTraceBundle(run.runId, entry.traceId)).rejects.toThrow(
      /references missing artifact/i,
    );
  });

  test("serializes parallel trace appends without losing entries", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });
    const run = await root.traces.createRun({
      runId: "run:parallel-appends",
      createdAt: 1,
    });

    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        root.traces.append(run.runId, {
          operation: `operation:${String(index)}`,
          outcome: "ok",
          startedAt: 100 + index,
          completedAt: 110 + index,
          data: {
            index,
          },
        }),
      ),
    );

    const storedEntries = await root.traces.listEntries(run.runId);
    const storedRun = await root.traces.getRun(run.runId);

    expect(appended).toHaveLength(20);
    expect(appended.map((entry) => entry.sequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(storedEntries).toHaveLength(20);
    expect(storedEntries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(
      storedEntries
        .map((entry) => entry.operation)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(
      Array.from({ length: 20 }, (_, index) => `operation:${String(index)}`).sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(storedRun).toMatchObject({
      entryCount: 20,
    });
    expect(storedRun?.updatedAt).toBe(Math.max(...storedEntries.map((entry) => entry.completedAt)));
  });

  test("stores descriptor and request-plan registries with deterministic resolution and duplicate rejection", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    await root.registry.descriptors.write({
      id: "descriptor:a",
      key: "dom.extract",
      version: "2026-03-13-a",
      createdAt: 300,
      payload: {
        name: "extract-a",
      },
    });
    await root.registry.descriptors.write({
      id: "descriptor:b",
      key: "dom.extract",
      version: "2026-03-13-b",
      createdAt: 300,
      payload: {
        name: "extract-b",
      },
    });

    expect(
      await root.registry.descriptors.resolve({
        key: "dom.extract",
      }),
    ).toMatchObject({
      id: "descriptor:a",
    });
    expect(
      await root.registry.descriptors.resolve({
        key: "dom.extract",
        version: "2026-03-13-b",
      }),
    ).toMatchObject({
      id: "descriptor:b",
    });
    expect(await root.registry.descriptors.list()).toMatchObject([
      { id: "descriptor:a" },
      { id: "descriptor:b" },
    ]);
    expect(await root.registry.descriptors.list({ key: "dom.extract" })).toMatchObject([
      { id: "descriptor:a" },
      { id: "descriptor:b" },
    ]);
    await expect(
      root.registry.descriptors.write({
        id: "descriptor:a",
        key: "dom.other",
        version: "1.0.0",
        createdAt: 301,
        payload: {
          name: "duplicate-id",
        },
      }),
    ).rejects.toThrow(/already exists/i);

    const initialRequestPlan = await root.registry.requestPlans.write({
      id: "request-plan:v1",
      key: "request.login",
      version: "1.0.0",
      createdAt: 400,
      tags: ["auth", "login"],
      payload: requestPlanPayload("https://example.com/login"),
      freshness: {
        lastValidatedAt: 405,
        staleAt: 500,
      },
    });
    await root.registry.requestPlans.write({
      id: "request-plan:v2",
      key: "request.login",
      version: "2.0.0",
      createdAt: 450,
      payload: requestPlanPayload("https://example.com/login"),
    });
    await root.registry.requestPlans.write({
      id: "request-plan:v3",
      key: "request.login",
      version: "3.0.0",
      createdAt: 500,
      payload: requestPlanPayload("https://example.com/login"),
    });

    expect(await root.registry.requestPlans.getById(initialRequestPlan.id)).toMatchObject({
      freshness: {
        lastValidatedAt: 405,
        staleAt: 500,
      },
      tags: ["auth", "login"],
    });
    expect(
      await root.registry.requestPlans.resolve({
        key: "request.login",
      }),
    ).toMatchObject({
      id: "request-plan:v3",
    });
    expect(
      await root.registry.requestPlans.resolve({
        key: "request.login",
        version: "3.0.0",
      }),
    ).toMatchObject({
      id: "request-plan:v3",
    });
    await expect(
      root.registry.requestPlans.write({
        id: "request-plan:duplicate-version",
        key: "request.login",
        version: "2.0.0",
        createdAt: 451,
        payload: requestPlanPayload("https://example.com/login"),
      }),
    ).rejects.toThrow(/already exists/i);

    const latestAuthRecipe = await root.registry.authRecipes.write({
      id: "auth-recipe:v2",
      key: "auth.refresh",
      version: "2.0.0",
      createdAt: 700,
      payload: {
        steps: [
          {
            kind: "directRequest",
            request: {
              url: "https://example.com/auth/refresh",
              method: "POST",
            },
          },
        ],
        outputs: {
          headers: {
            authorization: "Bearer {{token}}",
          },
        },
      },
    });
    await root.registry.authRecipes.write({
      id: "auth-recipe:v1",
      key: "auth.refresh",
      version: "1.0.0",
      createdAt: 650,
      payload: {
        steps: [
          {
            kind: "readCookie",
            name: "session",
            saveAs: "token",
          },
        ],
      },
    });

    expect(await root.registry.authRecipes.getById(latestAuthRecipe.id)).toMatchObject({
      key: "auth.refresh",
      version: "2.0.0",
    });
    expect(
      await root.registry.authRecipes.resolve({
        key: "auth.refresh",
      }),
    ).toMatchObject({
      id: "auth-recipe:v2",
    });
    expect(await root.registry.authRecipes.list({ key: "auth.refresh" })).toHaveLength(2);
  });

  test("rejects concurrent duplicate request-plan versions", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const writes = await Promise.allSettled([
      root.registry.requestPlans.write({
        id: "request-plan:parallel-a",
        key: "request.parallel",
        version: "1.0.0",
        createdAt: 1,
        payload: requestPlanPayload("https://example.com/parallel"),
      }),
      root.registry.requestPlans.write({
        id: "request-plan:parallel-b",
        key: "request.parallel",
        version: "1.0.0",
        createdAt: 2,
        payload: requestPlanPayload("https://example.com/parallel"),
      }),
    ]);

    const successful = writes.filter((result) => result.status === "fulfilled");
    const failed = writes.filter((result) => result.status === "rejected");
    const resolved = await root.registry.requestPlans.resolve({
      key: "request.parallel",
      version: "1.0.0",
    });

    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(Error);
    expect(String(failed[0]?.reason)).toMatch(/already exists/i);
    expect(resolved?.id).toBe(
      successful[0]?.status === "fulfilled" ? successful[0].value.id : undefined,
    );
  });

  test("lists request plans and updates freshness without changing the content hash", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const plan = await root.registry.requestPlans.write({
      id: "request-plan:list-a",
      key: "request.list",
      version: "1.0.0",
      createdAt: 100,
      payload: requestPlanPayload("https://example.com/list"),
    });
    await root.registry.requestPlans.write({
      id: "request-plan:list-b",
      key: "request.list",
      version: "2.0.0",
      createdAt: 200,
      payload: requestPlanPayload("https://example.com/list"),
    });

    expect(await root.registry.requestPlans.list()).toHaveLength(2);
    expect(await root.registry.requestPlans.list({ key: "request.list" })).toHaveLength(2);
    expect(await root.registry.requestPlans.resolve({ key: "request.list" })).toMatchObject({
      id: "request-plan:list-b",
    });

    const updated = await root.registry.requestPlans.updateFreshness({
      id: plan.id,
      freshness: {
        lastValidatedAt: 250,
        staleAt: 500,
      },
      updatedAt: 260,
    });

    expect(updated.freshness).toEqual({
      lastValidatedAt: 250,
      staleAt: 500,
    });
    expect(updated.contentHash).toBe(plan.contentHash);
    expect(updated.payload).toEqual(plan.payload);
  });

  test("rejects concurrent duplicate artifact ids without overwriting the winner", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const writes = await Promise.allSettled([
      root.artifacts.writeBinary({
        artifactId: "artifact:parallel",
        kind: "screenshot",
        createdAt: 1,
        mediaType: "image/png",
        data: new Uint8Array([1]),
      }),
      root.artifacts.writeBinary({
        artifactId: "artifact:parallel",
        kind: "screenshot",
        createdAt: 2,
        mediaType: "image/png",
        data: new Uint8Array([2]),
      }),
    ]);

    const successful = writes.filter((result) => result.status === "fulfilled");
    const failed = writes.filter((result) => result.status === "rejected");
    const stored = await root.artifacts.read("artifact:parallel");

    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(Error);
    expect(String(failed[0]?.reason)).toMatch(/already exists/i);
    expect(stored?.manifest.sha256).toBe(
      successful[0]?.status === "fulfilled" ? successful[0].value.sha256 : undefined,
    );
    expect(stored?.manifest.createdAt).toBe(
      successful[0]?.status === "fulfilled" ? successful[0].value.createdAt : undefined,
    );
  });

  test("keeps trace, artifact, and registry metadata boundaries separate on disk", async () => {
    const rootPath = await createTemporaryRoot();
    const root = await createFilesystemOpensteerRoot({ rootPath });

    const artifact = await root.artifacts.writeBinary({
      artifactId: "artifact:boundary",
      kind: "screenshot",
      createdAt: 100,
      mediaType: "image/webp",
      data: new Uint8Array([1, 1, 2, 3]),
    });
    const artifactReference = await root.artifacts.toProtocolArtifactReference(
      artifact.artifactId,
      "result",
    );
    const run = await root.traces.createRun({
      runId: "run:boundary",
      createdAt: 99,
    });
    const trace = await root.traces.append(run.runId, {
      operation: "artifact.capture-screenshot",
      outcome: "ok",
      startedAt: 100,
      completedAt: 110,
      artifacts: [artifactReference!],
      data: {
        stored: true,
      },
    });
    const requestPlan = await root.registry.requestPlans.write({
      id: "request-plan:boundary",
      key: "request.boundary",
      version: "1.0.0",
      createdAt: 120,
      payload: requestPlanPayload("https://example.com/boundary"),
      freshness: {
        lastValidatedAt: 121,
      },
    });

    const artifactManifest = JSON.parse(
      await readFile(
        path.join(
          rootPath,
          "artifacts",
          "manifests",
          `${encodeURIComponent(artifact.artifactId)}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const traceEntry = JSON.parse(
      await readFile(
        path.join(
          rootPath,
          "traces",
          "runs",
          encodeURIComponent(run.runId),
          "entries",
          "000000000001.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const requestPlanRecord = JSON.parse(
      await readFile(
        path.join(
          rootPath,
          "registry",
          "request-plans",
          "records",
          `${encodeURIComponent(requestPlan.id)}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(artifactManifest).not.toHaveProperty("relation");
    expect(artifactManifest).not.toHaveProperty("version");
    expect(traceEntry).not.toHaveProperty("freshness");
    expect(traceEntry).not.toHaveProperty("contentHash");
    expect(requestPlanRecord).not.toHaveProperty("events");
    expect(requestPlanRecord).not.toHaveProperty("artifacts");
    expect(requestPlanRecord).not.toHaveProperty("objectRelativePath");
    expect(trace.traceId).toBe("trace:run:boundary:000000000001");
  });
});
