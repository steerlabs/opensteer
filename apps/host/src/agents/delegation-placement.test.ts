import { createId, HarnessIdSchema, ModelSelectionSchema, type Thread } from "@opensteer/core";
import type { HarnessInstanceRecord, OpensteerStore } from "@opensteer/database";
import { HarnessInstanceCatalogSchema, type HarnessInstanceCatalog } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { delegationPlacement } from "./delegation-placement.js";

const now = "2026-09-12T12:00:00.000Z";
const environmentId = createId("environment");
const parentHarnessId = createId("harnessInstance");
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

describe("delegationPlacement on another machine", () => {
  it("requires an explicit compatible endpoint even when there is one default candidate", async () => {
    const parent = harness("Parent endpoint", {
      id: parentHarnessId,
      sourceId: "openai-compatible",
    });
    const target = harness("Other endpoint", { sourceId: "openai-compatible", isDefault: true });
    const store = placementStore(
      [target],
      new Map([[target.id, catalog(target.id, modelSelection.modelId)]]),
    );
    store.getHarnessInstance = vi.fn(async () => parent);
    await expect(
      place(store, { id: environmentId, name: "Other Mac" }, thread()),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("harnessInstanceId"),
    });
    await expect(
      place(store, { id: environmentId, name: "Other Mac" }, thread(), target.id),
    ).resolves.toMatchObject({ harnessInstanceId: target.id });
  });

  it("selects the sole compatible profile after filtering older profiles", async () => {
    const incompatible = harness("Older native");
    const compatible = harness("Compatible native");
    const store = placementStore(
      [incompatible, compatible],
      new Map([
        [incompatible.id, catalog(incompatible.id, "gpt-5.6-mini")],
        [compatible.id, catalog(compatible.id, modelSelection.modelId)],
      ]),
    );

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).resolves.toEqual({
      harnessInstanceId: compatible.id,
      modelSelection,
    });
  });

  it("takes the native model id from the target account's catalog, never the parent's", async () => {
    // A native id names what one endpoint answers to. The parent's endpoint
    // spelled the model one way; the target's descriptor is the only authority
    // on what the target's endpoint expects.
    const target = harness("Gateway");
    const store = placementStore(
      [target],
      new Map([[target.id, catalog(target.id, modelSelection.modelId, "openai/gpt-5.6-sol")]]),
    );
    const parent = {
      ...thread(),
      modelSelection: { ...modelSelection, nativeModelId: "parent-spelling" },
    };

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, parent),
    ).resolves.toEqual({
      harnessInstanceId: target.id,
      modelSelection: { ...modelSelection, nativeModelId: "openai/gpt-5.6-sol" },
    });
  });

  it("carries a saved option id the destination no longer lists", async () => {
    const target = harness("First party");
    const store = placementStore(
      [target],
      new Map([[target.id, catalog(target.id, modelSelection.modelId)]]),
    );
    const parent = {
      ...thread(),
      modelSelection: { ...modelSelection, options: { effort: "low", thinking: true } },
    };

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, parent),
    ).resolves.toEqual({
      harnessInstanceId: target.id,
      modelSelection: parent.modelSelection,
    });
  });

  it("refuses a target that offers the model but not the parent's option value", async () => {
    // Options travel with the work like the model does; the target engine's
    // catalog decides whether it still offers them.
    const target = harness("First party");
    const store = placementStore(
      [target],
      new Map([[target.id, catalog(target.id, modelSelection.modelId)]]),
    );
    const parent = {
      ...thread(),
      modelSelection: { ...modelSelection, options: { effort: "high" } },
    };

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, parent),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "First party on Build machine: Model option effort is not available for gpt-5.6-sol; it takes low",
    });
  });

  it("keeps a delegation on the parent's own account when that account qualifies", async () => {
    // The work continues where it started: an account that is already running
    // this Thread beats the pair's default, which is only the answer for a
    // caller that has no account in mind.
    const parent = harness("Parent", { id: parentHarnessId });
    const fallback = harness("Native default", { isDefault: true });
    const store = placementStore(
      [fallback, parent],
      new Map([
        [fallback.id, catalog(fallback.id, modelSelection.modelId)],
        [parent.id, catalog(parent.id, modelSelection.modelId)],
      ]),
    );

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).resolves.toEqual({ harnessInstanceId: parentHarnessId, modelSelection });
  });

  it("falls to the pair's default rather than whichever account was made first", async () => {
    const oldest = harness("Native spare");
    const chosen = harness("Native default", { isDefault: true });
    const store = placementStore(
      [oldest, chosen],
      new Map([
        [oldest.id, catalog(oldest.id, modelSelection.modelId)],
        [chosen.id, catalog(chosen.id, modelSelection.modelId)],
      ]),
    );

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).resolves.toEqual({ harnessInstanceId: chosen.id, modelSelection });
  });

  it("refuses an account of the same engine that talks to another source", async () => {
    // Same engine, same model, somebody else's bill and somebody else's
    // sign-in: not a substitute for the source the work started on.
    const elsewhere = harness("Native via a compatible endpoint", {
      isDefault: true,
      sourceId: "native-compatible",
    });
    const store = placementStore(
      [elsewhere],
      new Map([[elsewhere.id, catalog(elsewhere.id, modelSelection.modelId)]]),
    );

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "Build machine has no enabled native AI engine on native. Name another engine with harnessInstanceId; environment_list names the engines each environment can run.",
    });
  });

  it("names every compatible choice and requires an explicit profile when several qualify", async () => {
    const first = harness("Native primary");
    const second = harness("Native isolated");
    const catalogs = new Map([
      [first.id, catalog(first.id, modelSelection.modelId)],
      [second.id, catalog(second.id, modelSelection.modelId)],
    ]);
    const store = placementStore([first, second], catalogs);

    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining(`Native primary (${first.id})`),
    });
    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread()),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`Native isolated (${second.id})`),
    });
    await expect(
      place(store, { id: environmentId, name: "Build machine" }, thread(), second.id),
    ).resolves.toEqual({ harnessInstanceId: second.id, modelSelection });
  });
});

function place(
  store: Parameters<typeof delegationPlacement>[0],
  environment: { readonly id: ReturnType<typeof createId<"environment">>; readonly name: string },
  parent: Thread,
  harnessInstanceId?: HarnessInstanceRecord["id"],
) {
  return delegationPlacement(store, {
    environment,
    existingThread: null,
    harnessInstanceId,
    parent,
  });
}

function placementStore(
  harnesses: readonly HarnessInstanceRecord[],
  catalogs: ReadonlyMap<HarnessInstanceRecord["id"], HarnessInstanceCatalog>,
): Pick<OpensteerStore, "getHarnessCatalog" | "getHarnessInstance" | "listHarnessInstances"> {
  return {
    getHarnessCatalog: vi.fn(async (_environmentId, harnessInstanceId) => {
      return catalogs.get(harnessInstanceId) ?? null;
    }),
    getHarnessInstance: vi.fn(async (harnessInstanceId) => {
      if (harnessInstanceId === parentHarnessId) {
        return harness("Parent", { id: parentHarnessId, isDefault: true });
      }
      return harnesses.find(({ id }) => id === harnessInstanceId) ?? null;
    }),
    listHarnessInstances: vi.fn(async () => harnesses),
  };
}

function harness(
  name: string,
  options: {
    readonly id?: HarnessInstanceRecord["id"];
    readonly isDefault?: boolean;
    readonly sourceId?: string;
  } = {},
): HarnessInstanceRecord {
  return {
    config: {},
    driverKind: HarnessIdSchema.parse("native"),
    enabled: true,
    environmentId,
    id: options.id ?? createId("harnessInstance"),
    isDefault: options.isDefault ?? false,
    name,
    removedAt: null,
    runtimeRevision: 1,
    sourceId: options.sourceId ?? "native",
    stateKind: "ambient",
  };
}

function catalog(
  harnessInstanceId: HarnessInstanceRecord["id"],
  modelId: string,
  nativeModelId?: string,
) {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "native",
    },
    driverKind: "native",
    harnessInstanceId,
    models: [
      {
        displayName: modelId,
        isDefault: true,
        modelId,
        ...(nativeModelId === undefined ? {} : { nativeModelId }),
        options: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [{ label: "Low", value: "low" }],
          },
        ],
        providerId: "openai",
      },
    ],
    status: "ready",
  });
}

function thread(): Thread {
  const threadId = createId("thread");
  return {
    accessMode: "full-access",
    capabilityProfileId: "main",
    continuationIdentity: null,
    doneAt: null,
    icon: null,
    role: "work",
    createdAt: now,
    createdBy: createId("user"),
    environmentId: createId("environment"),
    harnessInstanceId: parentHarnessId,
    inputQueuePaused: false,
    id: threadId,
    lineageRootThreadId: threadId,
    listed: true,
    modelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    providerSessionId: null,
    status: "idle",
    title: "Parent",
    updatedAt: now,
    workspaceId: createId("workspace"),
  };
}
