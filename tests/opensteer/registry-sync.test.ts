import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildDomDescriptorKey,
  buildDomDescriptorPayload,
  buildDomDescriptorVersion,
  createFilesystemOpensteerWorkspace,
  hashDomDescriptorDescription,
} from "../../packages/runtime-core/src/index.js";
import {
  REGISTRY_SYNC_MAX_PAYLOAD_BYTES,
  syncLocalRegistryToCloud,
} from "../../packages/opensteer/src/cloud/registry-sync.js";

const temporaryRoots: string[] = [];
type RegistryImportClient = Parameters<typeof syncLocalRegistryToCloud>[0];

afterEach(async () => {
  vi.clearAllMocks();
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

function recipePayload(description = "Run step") {
  return {
    description,
    steps: [
      {
        kind: "directRequest",
        request: {
          url: "https://example.com",
          method: "GET",
        },
      },
    ],
  } as const;
}

async function createWorkspace(workspace = "cloud-workspace") {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "opensteer-registry-sync-"));
  temporaryRoots.push(rootPath);
  return createFilesystemOpensteerWorkspace({
    rootPath,
    workspace,
  });
}

function createMockClient() {
  const client = {
    importSelectorCache: vi.fn(async () => ({
      imported: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    })),
    importRequestPlans: vi.fn(async () => ({
      imported: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    })),
    importRecipes: vi.fn(async () => ({
      imported: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    })),
    importAuthRecipes: vi.fn(async () => ({
      imported: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    })),
  } satisfies RegistryImportClient;

  return {
    client,
    importSelectorCache: client.importSelectorCache,
    importRequestPlans: client.importRequestPlans,
    importRecipes: client.importRecipes,
    importAuthRecipes: client.importAuthRecipes,
  };
}

describe("local-to-cloud registry sync", () => {
  test("syncs DOM descriptors, request plans, recipes, and auth recipes", async () => {
    const workspaceName = "cloud-workspace";
    const workspace = await createWorkspace(workspaceName);
    const pathPayload = {
      resolution: "deterministic",
      context: [],
      nodes: [{ tag: "button" }],
    } as const;
    const domPayload = buildDomDescriptorPayload({
      method: "dom.click",
      description: "Submit",
      path: pathPayload,
      sourceUrl: "https://example.com/login",
    });

    await workspace.registry.descriptors.write({
      id: "descriptor:dom",
      key: buildDomDescriptorKey({
        namespace: workspaceName,
        method: "dom.click",
        description: "Submit",
      }),
      version: buildDomDescriptorVersion(domPayload),
      createdAt: 10,
      updatedAt: 20,
      payload: domPayload,
    });
    await workspace.registry.descriptors.write({
      id: "descriptor:other",
      key: "descriptor:other",
      version: "1.0.0",
      createdAt: 11,
      updatedAt: 21,
      payload: {
        kind: "other",
      },
    });
    await workspace.registry.requestPlans.write({
      id: "request-plan:1",
      key: "request.login",
      version: "1.0.0",
      createdAt: 30,
      updatedAt: 40,
      payload: requestPlanPayload("https://example.com/login"),
      freshness: {
        lastValidatedAt: 41,
        staleAt: 90,
      },
    });
    await workspace.registry.recipes.write({
      id: "recipe:1",
      key: "recipe.login",
      version: "1.0.0",
      createdAt: 50,
      updatedAt: 60,
      payload: recipePayload(),
    });
    await workspace.registry.authRecipes.write({
      id: "auth-recipe:1",
      key: "auth.refresh",
      version: "1.0.0",
      createdAt: 70,
      updatedAt: 80,
      payload: recipePayload("Refresh auth"),
    });

    const client = createMockClient();

    await syncLocalRegistryToCloud(client.client, workspaceName, workspace);

    expect(client.importSelectorCache).toHaveBeenCalledTimes(1);
    expect(client.importSelectorCache).toHaveBeenCalledWith([
      {
        workspace: workspaceName,
        method: "dom.click",
        descriptionHash: hashDomDescriptorDescription("Submit"),
        description: "Submit",
        path: pathPayload,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    expect(client.importSelectorCache.mock.calls[0]?.[0]?.[0]).not.toHaveProperty("schemaHash");

    expect(client.importRequestPlans).toHaveBeenCalledWith([
      expect.objectContaining({
        workspace: workspaceName,
        recordId: "request-plan:1",
        key: "request.login",
        freshness: {
          lastValidatedAt: 41,
          staleAt: 90,
        },
      }),
    ]);
    expect(client.importRecipes).toHaveBeenCalledWith([
      expect.objectContaining({
        workspace: workspaceName,
        recordId: "recipe:1",
        key: "recipe.login",
      }),
    ]);
    expect(client.importAuthRecipes).toHaveBeenCalledWith([
      expect.objectContaining({
        workspace: workspaceName,
        recordId: "auth-recipe:1",
        key: "auth.refresh",
      }),
    ]);
  });

  test("skips import calls when all registries are empty", async () => {
    const workspace = await createWorkspace();
    const client = createMockClient();

    await syncLocalRegistryToCloud(client.client, "cloud-workspace", workspace);

    expect(client.importSelectorCache).not.toHaveBeenCalled();
    expect(client.importRequestPlans).not.toHaveBeenCalled();
    expect(client.importRecipes).not.toHaveBeenCalled();
    expect(client.importAuthRecipes).not.toHaveBeenCalled();
  });

  test("splits request plan imports at the max entries per batch", async () => {
    const workspaceName = "cloud-workspace";
    const workspace = await createWorkspace(workspaceName);

    for (let index = 0; index < 101; index += 1) {
      await workspace.registry.requestPlans.write({
        id: `request-plan:${index}`,
        key: `request.${index}`,
        version: "1.0.0",
        createdAt: index + 1,
        updatedAt: index + 1,
        payload: requestPlanPayload(`https://example.com/${index}`),
      });
    }

    const client = createMockClient();

    await syncLocalRegistryToCloud(client.client, workspaceName, workspace);

    expect(client.importRequestPlans).toHaveBeenCalledTimes(2);
    expect(client.importRequestPlans.mock.calls[0]?.[0]).toHaveLength(100);
    expect(client.importRequestPlans.mock.calls[1]?.[0]).toHaveLength(1);
  });

  test("splits recipe imports to stay under the payload byte budget", async () => {
    const workspaceName = "cloud-workspace";
    const workspace = await createWorkspace(workspaceName);

    for (let index = 0; index < 2; index += 1) {
      await workspace.registry.recipes.write({
        id: `recipe:${index}`,
        key: `recipe.${index}`,
        version: "1.0.0",
        createdAt: index + 1,
        updatedAt: index + 1,
        payload: recipePayload("x".repeat(900_000)),
      });
    }

    const client = createMockClient();

    await syncLocalRegistryToCloud(client.client, workspaceName, workspace);

    expect(client.importRecipes).toHaveBeenCalledTimes(2);
    for (const [entries] of client.importRecipes.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify({ entries }), "utf8")).toBeLessThanOrEqual(
        REGISTRY_SYNC_MAX_PAYLOAD_BYTES,
      );
    }
  });

  test("skips oversized recipe entries and still imports smaller entries", async () => {
    const workspaceName = "cloud-workspace";
    const workspace = await createWorkspace(workspaceName);

    await workspace.registry.recipes.write({
      id: "recipe:oversized",
      key: "recipe.oversized",
      version: "1.0.0",
      createdAt: 1,
      updatedAt: 1,
      payload: recipePayload("x".repeat(1_600_000)),
    });
    await workspace.registry.recipes.write({
      id: "recipe:small",
      key: "recipe.small",
      version: "1.0.0",
      createdAt: 2,
      updatedAt: 2,
      payload: recipePayload("small"),
    });

    const client = createMockClient();

    await syncLocalRegistryToCloud(client.client, workspaceName, workspace);

    expect(client.importRecipes).toHaveBeenCalledTimes(1);
    expect(client.importRecipes).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: "recipe:small",
      }),
    ]);
  });
});
