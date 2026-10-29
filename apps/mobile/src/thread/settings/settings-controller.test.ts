import {
  ExecutionSelectionSchema,
  ThreadAccessModeSchema,
  type ExecutionPreferences,
} from "@opensteer/core";
import { type ThreadPlacementOption, type ThreadSummary } from "@opensteer/client/host";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  buildThreadModelPicker,
  settingsDisabledReason,
  type AccountRow,
  type ModelRow,
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
    subject: { kind: "thread", thread: thread(current) },
    ...overrides,
  });
}

function rows(picker: ThreadModelPicker) {
  return picker.sections.flatMap((section) => section.rows);
}

function models(picker: ThreadModelPicker): ModelRow[] {
  return rows(picker).filter((row): row is ModelRow => row.kind === "model");
}

function accounts(picker: ThreadModelPicker): AccountRow[] {
  return rows(picker).filter((row): row is AccountRow => row.kind === "account");
}

function account(picker: ThreadModelPicker, harness: string): AccountRow | undefined {
  return accounts(picker).find((row) => row.placement.harnessInstanceId === harness);
}

describe("Thread model picker", () => {
  const gpt = model("openai", "gpt-5", "GPT-5");
  const o3 = model("openai", "o3", "o3");
  const opus = model("anthropic", "opus", "Claude Opus");
  const primary = placement({ account: "Primary", harness: "primary", models: [gpt, o3] });
  const team = placement({ account: "Team key", harness: "team", models: [gpt, opus] });
  const claude = placement({
    account: "Claude",
    driver: "claude",
    harness: "claude",
    models: [gpt],
  });
  const accountStep = { driverKind: "codex", kind: "accounts" } as const;
  const modelStep = {
    environmentId: "main",
    harnessInstanceId: "team",
    kind: "account-models",
    returnTo: "accounts",
  } as const;

  it("starts with engines and statuses, skipping accounts only for one available account", () => {
    const picker = build([primary, team, claude], gpt);
    expect(picker.title).toBe("AI");
    expect(models(picker)).toEqual([]);
    expect(rows(picker)).toMatchObject([
      { kind: "engine", title: "Codex", status: "ready", nextStep: accountStep },
      {
        kind: "engine",
        title: "Claude Code",
        status: "ready",
        nextStep: {
          kind: "account-models",
          harnessInstanceId: "claude",
          returnTo: "engines",
        },
      },
    ]);
    expect(picker.showSearch).toBe(true);
  });

  it("browses only one engine's accounts and only the chosen account's models", () => {
    const picker = build([primary, team, claude], gpt, { step: accountStep });
    expect(accounts(picker).map(({ title, action }) => [title, action.kind])).toEqual([
      ["Primary", "choose-model"],
      ["Team key", "choose-model"],
    ]);
    const offered = build([primary, team, claude], gpt, { step: modelStep });
    expect(offered.sections.map(({ title }) => title)).toEqual(["OpenAI", "Anthropic"]);
    expect(
      models(offered).map(({ title, route }) => [title, route?.placement.harnessInstanceId]),
    ).toEqual([
      ["GPT-5", "team"],
      ["Claude Opus", "team"],
    ]);
    expect(models(offered).every(({ selected }) => !selected)).toBe(true);
    expect(models(offered)[0]).toMatchObject({ suggested: true });
  });

  it("searches flat routes with account words and never deduplicates engines or accounts", () => {
    const placements = [
      primary,
      {
        ...team,
        observedConnections: [
          {
            accountLabel: "team@example.com",
            connectionSlot: "account",
            label: "Account",
            status: "connected" as const,
          },
        ],
      },
      claude,
    ];
    const search = build(placements, gpt, { query: "GPT-5" });
    expect(models(search).map(({ route }) => route?.placement.harnessInstanceId)).toEqual([
      "primary",
      "team",
      "claude",
    ]);
    const narrowed = build(placements, gpt, { query: "team@example GPT" });
    expect(models(narrowed).map(({ route }) => route?.placement.harnessInstanceId)).toEqual([
      "team",
    ]);
    expect(models(narrowed)[0]?.detail).toContain("Team key");
    expect(build(placements, gpt, { query: "no match" }).emptyMessage).toBe("No matches");
  });

  it("lists recent complete choices newest first and keeps unavailable choices named", () => {
    const blocked = {
      ...team,
      available: false,
      detail: "Sign in again",
      availability: "authentication-required" as const,
    };
    const selection = (p: ThreadPlacementOption) =>
      ({
        environmentId: p.environmentId,
        harnessInstanceId: p.harnessInstanceId,
        modelSelection: p.modelSelection,
      }) as ExecutionPreferences["history"][number];
    const picker = build([primary, blocked], gpt, {
      preferences: { ...noPreferences, history: [selection(blocked), selection(primary)] },
    });
    expect(picker.sections.find(({ id }) => id === "recent")).toMatchObject({
      title: "Recent",
      rows: [
        {
          kind: "unavailable",
          title: "Codex · gpt-5",
          detail: expect.stringContaining("Team key"),
        },
        {
          kind: "model",
          title: "Codex · GPT-5",
          route: { placement: { harnessInstanceId: "primary" } },
        },
      ],
    });
    expect(picker.sections.find(({ id }) => id === "recent")?.rows[0]?.detail).toContain(
      "Sign in again",
    );
  });

  it("keeps unavailable accounts with reasons and Check again, even when skipping the account step", () => {
    const blocked = {
      ...team,
      available: false,
      detail: "Sign in to use Codex",
      availability: "authentication-required" as const,
    };
    const picker = build([primary, blocked], gpt, { step: accountStep });
    expect(account(picker, "team")).toMatchObject({
      action: { kind: "refresh", reason: "Sign in to use Codex" },
      status: "attention",
    });
    const engine = rows(build([primary, blocked], gpt))[0];
    expect(engine).toMatchObject({
      nextStep: { kind: "account-models", harnessInstanceId: "primary", returnTo: "engines" },
    });
    if (engine?.kind !== "engine") throw new Error("Expected an engine");
    expect(
      account(build([primary, blocked], gpt, { step: engine.nextStep }), "team")?.action.kind,
    ).toBe("refresh");
    expect(
      rows(build([{ ...blocked, availability: "disconnected" }], gpt)).find(
        ({ kind }) => kind === "engine",
      ),
    ).toMatchObject({ status: "idle" });
  });

  it("suggests the current model, otherwise the account's last model, otherwise its default", () => {
    const other = placement({
      account: "Other",
      harness: "team",
      models: [opus, { ...o3, isDefault: true }],
    });
    const remembered = {
      environmentId: "main",
      harnessInstanceId: "team",
      modelSelection: { providerId: "anthropic", modelId: "opus", options: {} },
    } as ExecutionPreferences["history"][number];
    const preferred = (p: ThreadPlacementOption, history: ExecutionPreferences["history"]) =>
      models(
        build([primary, p], gpt, { step: modelStep, preferences: { ...noPreferences, history } }),
      ).find(({ suggested }) => suggested)?.route?.model.modelId;
    expect(preferred(team, [remembered])).toBe("gpt-5");
    expect(preferred(other, [remembered])).toBe("opus");
    expect(preferred(other, [])).toBe("o3");
  });

  it("marks continuation-identity incompatible account switches as fresh starts", () => {
    const current = placement({
      account: "Primary",
      harness: "primary",
      models: [gpt],
      continuationKey: "primary:v1",
    });
    const other = placement({
      account: "Team key",
      harness: "team",
      models: [gpt],
      continuationKey: "team:v1",
    });
    const subject = {
      kind: "thread",
      thread: thread(gpt, { continuationIdentity: current.continuationIdentity }),
    } as const;
    expect(
      account(build([current, other], gpt, { step: accountStep, subject }), "team")?.detail,
    ).toContain("Starts fresh here");
    expect(models(build([current, other], gpt, { step: modelStep, subject }))[0]?.detail).toContain(
      "Starts fresh here",
    );
  });

  it("keeps a blocked selection visible and never marks another account's model selected", () => {
    const blocked = {
      ...primary,
      available: false,
      models: [],
      detail: "This work location is not connected",
    };
    const picker = build([blocked, team], gpt);
    expect(rows(picker)[0]).toMatchObject({
      kind: "unavailable",
      title: "Codex · GPT-5",
      detail: expect.stringContaining("This work location is not connected"),
    });
    expect(picker.currentRoute).toBeNull();
    expect(picker.options).toEqual([]);
    const missing = build([team], gpt);
    expect(rows(missing)[0]?.detail).toContain("no longer here");
    const dropped = build([{ ...primary, models: [o3] }, team], gpt);
    expect(rows(dropped)[0]?.detail).toContain("no longer offers this model");
  });

  it("abandons browsing a removed engine or unavailable account without choosing a replacement", () => {
    expect(
      build([primary], gpt, { step: { kind: "accounts", driverKind: "claude" } }),
    ).toMatchObject({ step: { kind: "engines" }, lostStep: expect.stringContaining("no longer") });
    expect(build([primary], gpt, { step: modelStep })).toMatchObject({
      step: { kind: "engines" },
      lostStep: expect.stringContaining("no longer available"),
    });
  });

  it("shows current model options with chosen and clamped values", () => {
    const configurable = model("openai", "gpt-options", "GPT Options", [
      {
        defaultValue: "medium",
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        values: ["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
          label: value.toUpperCase(),
          value,
        })),
      },
      { defaultValue: false, id: "fast", label: "Fast", type: "toggle" },
    ]);
    const placements = [{ ...primary, models: [configurable] }];
    const chosen = build(placements, configurable, {
      subject: {
        kind: "thread",
        thread: thread(configurable, {
          modelSelection: {
            modelId: "gpt-options",
            options: { fast: true, reasoning: "xhigh" },
            providerId: "openai",
          },
        }),
      },
    });
    expect(chosen).toMatchObject({
      showSearch: true,
      title: "AI",
      currentRoute: { model: { modelId: "gpt-options" } },
    });
    expect(chosen.options).toEqual([
      expect.objectContaining({
        value: "xhigh",
        valueLabel: "XHIGH",
        values: expect.arrayContaining([{ label: "MAX", value: "max" }]),
      }),
      { id: "fast", kind: "toggle", label: "Fast", value: true },
    ]);
    const stale = build(placements, configurable, {
      subject: {
        kind: "thread",
        thread: thread(configurable, {
          modelSelection: {
            modelId: "gpt-options",
            options: { reasoning: "gone" },
            providerId: "openai",
          },
        }),
      },
    });
    expect(stale.options).toEqual([
      expect.objectContaining({ value: "medium", valueLabel: "MEDIUM" }),
      expect.objectContaining({ value: false }),
    ]);
  });

  it("names work locations only when accounts span several and offers drafts without continuation checks", () => {
    const remote = placement({
      account: "Team key",
      harness: "team",
      models: [gpt],
      environment: "Laptop",
      continuationKey: "remote",
    });
    const picker = build([primary, remote], gpt, {
      step: accountStep,
      subject: { kind: "draft", selection: null },
    });
    expect(account(picker, "team")?.detail).toContain("Laptop");
    expect(account(picker, "team")?.detail).not.toContain("Starts fresh");
    expect(account(build([team], gpt, { step: accountStep }), "team")?.detail).toBeNull();
  });

  it("keeps blocked draft decisions visible", () => {
    const blocked = { ...primary, available: false, detail: "This work location is not connected" };
    const selection = ExecutionSelectionSchema.parse({
      environmentId: "env_0192f4a1-1111-4000-8000-000000000001",
      harnessInstanceId: "hin_0192f4a1-1111-4000-8000-000000000001",
      modelSelection: primary.modelSelection,
    });
    const picker = build([{ ...blocked, ...selection }], gpt, {
      subject: { kind: "draft", selection },
    });
    expect(rows(picker)[0]).toMatchObject({
      kind: "unavailable",
      title: "Codex · GPT-5",
      detail: expect.stringContaining("This work location is not connected"),
    });
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
