import { ThreadAccessModeSchema, type ExecutionPreferences } from "@opensteer/core";
import { type ThreadPlacementOption, type ThreadSummary } from "@opensteer/client/host";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  buildThreadModelPicker,
  settingsDisabledReason,
  type ThreadModelPicker,
  type ThreadModelPickerInput,
} from "./settings-controller.js";

const noPreferences: ExecutionPreferences = { accessMode: "approval-required", history: [] };

function model(
  providerId: string,
  modelId: string,
  displayName: string,
  options: HarnessModelDescriptor["options"] = [],
): HarnessModelDescriptor {
  return { displayName, isDefault: false, modelId, options, providerId } as HarnessModelDescriptor;
}

function placement(input: {
  readonly account: string;
  readonly available?: boolean;
  readonly continuationKey?: string;
  readonly driver?: string;
  readonly environment?: string;
  readonly harness: string;
  readonly models: readonly HarnessModelDescriptor[];
  readonly providerAccount?: string;
}): ThreadPlacementOption {
  const available = input.available ?? true;
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: input.account,
    availability: available ? "configured" : "disconnected",
    available,
    continuationIdentity:
      input.continuationKey === undefined
        ? null
        : { continuationKey: input.continuationKey, driverKind: input.driver ?? "codex" },
    defaultAccount: input.harness === "primary",
    detail: available ? "Ready" : "This work location is not connected",
    driverKind: input.driver ?? "codex",
    engineName: input.driver === "claude" ? "Claude Code" : "Codex",
    environmentId: input.environment ?? "main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: input.harness,
    modelSelection: {
      modelId: input.models[0]?.modelId ?? "unavailable",
      options: {},
      providerId: input.models[0]?.providerId ?? "unavailable",
    },
    models: input.models,
    observedConnections:
      input.providerAccount === undefined
        ? []
        : [
            {
              accountLabel: input.providerAccount,
              connectionSlot: "account",
              label: "Account",
              status: "connected",
            },
          ],
    setupAvailable: false,
    setupMethods: [],
    source: null,
    sourceId: "first-party",
    whereLabel: input.environment ?? "Main",
  } as ThreadPlacementOption;
}

function thread(
  current: HarnessModelDescriptor,
  overrides: Readonly<Record<string, unknown>> = {},
): ThreadSummary {
  return {
    accessMode: "approval-required",
    continuationIdentity: null,
    environmentId: "main",
    harnessInstanceId: "primary",
    harnessLabel: "Primary",
    id: "thread-1",
    modelLabel: current.displayName,
    modelSelection: { modelId: current.modelId, options: {}, providerId: current.providerId },
    parentThreadId: null,
    pendingRequests: 0,
    runnerLabel: "Main",
    status: "idle",
    title: "Picker test",
    unread: false,
    updatedAt: "2026-09-16T12:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  } as ThreadSummary;
}

function build(
  placements: readonly ThreadPlacementOption[],
  current: HarnessModelDescriptor,
  overrides: Partial<ThreadModelPickerInput> = {},
): ThreadModelPicker {
  return buildThreadModelPicker({
    placements,
    preferences: noPreferences,
    query: "",
    step: { kind: "engines" },
    subject: {
      kind: "thread",
      thread: thread(current, {
        providerSessionId: "session",
        continuationIdentity: { continuationKey: "current", driverKind: "codex" },
      }),
    },
    ...overrides,
  });
}

describe("Thread model picker", () => {
  const gpt = model("openai", "gpt", "GPT");
  const primary = placement({ account: "Primary", harness: "primary", models: [gpt] });
  const claude = placement({
    account: "Claude",
    harness: "claude",
    driver: "claude",
    models: [gpt],
  });
  it("browses chips without changing the current selection", () => {
    const picker = build([primary, claude], gpt, {
      step: { kind: "engines", driverKind: "claude" },
    });
    expect(picker.menu.browsed?.driverKind).toBe("claude");
    expect(picker.currentRoute?.placement).toBe(primary);
    expect(picker.models.every((row) => !row.selected)).toBe(true);
    expect(picker.options).toEqual([]);
  });
  it("searches all AIs with engine and account details", () => {
    const picker = build([primary, claude], gpt, { query: "GPT" });
    expect(picker.models).toHaveLength(2);
    expect(picker.models[1]?.detail).toContain("Claude");
  });
  it("keeps unavailable choices visible without silently replacing them", () => {
    const offline = { ...primary, available: false, detail: "Offline" };
    const picker = build([offline, claude], gpt);
    expect(picker.unavailableCurrent?.detail).toBe("Offline");
    expect(picker.menu.blocked).toBe(offline);
    expect(picker.models).toEqual([]);
    expect(picker.accounts[0]?.selected).toBe(true);
  });
  it("marks incompatible models as starting fresh", () => {
    const picker = build(
      [
        primary,
        placement({
          account: "Claude",
          harness: "claude",
          driver: "claude",
          continuationKey: "other",
          models: [gpt],
        }),
      ],
      gpt,
      {
        step: {
          kind: "engines",
          driverKind: claude.driverKind as import("@opensteer/core").HarnessId,
        },
      },
    );
    expect(picker.models[0]?.detail).toContain("Starts fresh here");
  });
  it("uses shared ladder and switch settings", () => {
    const configured = model("openai", "gpt", "GPT", [
      {
        type: "select",
        id: "effort",
        label: "Reasoning",
        defaultValue: "auto",
        values: [
          { value: "auto", label: "Default" },
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
      },
      { type: "toggle", id: "fast", label: "Fast", defaultValue: false },
    ]);
    const picker = build([{ ...primary, models: [configured] }], configured);
    expect(picker.options).toMatchObject([
      { kind: "ladder", step: null, automatic: { label: "Default" } },
      { kind: "switch", on: false },
    ]);
  });
  it("disables changes for ownership, activity, archived threads and connectivity", () => {
    expect(
      settingsDisabledReason({
        canRespond: true,
        hasRun: false,
        mutationOwner: "settings",
        kind: "thread",
        thread: thread(gpt),
      }),
    ).toBe("Updating thread settings…");
    expect(
      settingsDisabledReason({
        canRespond: true,
        hasRun: true,
        mutationOwner: null,
        kind: "thread",
        thread: thread(gpt),
      }),
    ).toContain("Finish the current run");
    expect(
      settingsDisabledReason({
        canRespond: true,
        hasRun: false,
        mutationOwner: "message",
        kind: "thread",
        thread: thread(gpt),
      }),
    ).toContain("pending message");
    expect(
      settingsDisabledReason({
        canRespond: true,
        hasRun: false,
        mutationOwner: "request",
        kind: "thread",
        thread: thread(gpt),
      }),
    ).toContain("response");
    expect(
      settingsDisabledReason({
        canRespond: true,
        hasRun: false,
        mutationOwner: null,
        kind: "thread",
        thread: thread(gpt, { status: "archived" }),
      }),
    ).toBe("This thread is archived.");
    expect(settingsDisabledReason({ canRespond: true, kind: "draft" })).toBeNull();
    expect(settingsDisabledReason({ canRespond: false, kind: "draft" })).toBe(
      "Reconnect to choose thread settings.",
    );
  });
});
