import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  AutomaticModelConfigSchema,
  HarnessInstanceIdSchema,
  resolveModelCandidates,
} from "@opensteer/core";
import {
  automaticModelChoices,
  automaticRoleEntries,
  editAutomaticRole,
  getAutomaticModels,
  setAutomaticModels,
} from "./automatic-models.js";
import { specialistModels } from "./plugins.js";
it("sends neither read nor write without the capability", async () => {
  const host = new MockHostClient({ automaticModelsAvailable: false });
  try {
    const read = vi.fn();
    const write = vi.fn();
    Object.defineProperty(host.rpc, "automaticModels.get", { value: read, configurable: true });
    Object.defineProperty(host.rpc, "commands.dispatch", { value: write, configurable: true });
    expect(await getAutomaticModels(host)).toBeNull();
    await expect(setAutomaticModels(host, { roles: {}, excludedAccounts: [] })).rejects.toThrow(
      "does not support",
    );
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    host.dispose();
  }
});
it("edits ordered defaults, resets to absent, and binds arbitrary endpoints", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    let view = (await getAutomaticModels(host))!;
    expect(automaticRoleEntries(view, "light")[0]?.label).toContain("haiku");
    const before = automaticRoleEntries(view, "deep");
    await setAutomaticModels(
      host,
      editAutomaticRole(view, "deep", { type: "move", index: 0, offset: 1 }),
    );
    view = (await getAutomaticModels(host))!;
    expect(automaticRoleEntries(view, "deep")[1]?.label).toBe(before[0]?.label);
    const bound = automaticModelChoices(view).find((c) => c.label.includes("OpenRouter"));
    expect(bound?.want.harnessInstanceId).toBeDefined();
    await setAutomaticModels(host, editAutomaticRole(view, "deep", { type: "reset" }));
    expect((await getAutomaticModels(host))!.config.roles.deep).toBeUndefined();
    expect(
      AutomaticModelConfigSchema.safeParse({ roles: { light: [] }, excludedAccounts: [] }).success,
    ).toBe(false);
  } finally {
    host.dispose();
  }
});
it("binds the account a person picks, so a non-default account is the one that runs", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const view = (await getAutomaticModels(host))!;
    const personal = view.accounts.find(
      (a) => a.sourceId !== "openai-compatible" && a.catalog?.status === "ready",
    )!;
    const work = {
      ...personal,
      harnessInstanceId: HarnessInstanceIdSchema.parse("hin_00000000-0000-4000-8000-0000000000f1"),
      accountDisplayName: "Work",
      isDefault: false,
    };
    const accounts = [{ ...personal, isDefault: true }, work];
    const model = personal.catalog!.models.find((m) => !m.unavailableReason)!;
    const choice = automaticModelChoices({ ...view, accounts }).find(
      (c) => c.label === `${model.displayName} · Work`,
    );
    expect(choice?.want).toEqual({
      engine: personal.driverKind,
      model: `${model.providerId}/${model.modelId}`,
      harnessInstanceId: work.harnessInstanceId,
    });
    const { candidates } = resolveModelCandidates({
      wants: [choice!.want],
      accounts: accounts.map((a) => ({
        ...a,
        catalog: {
          ...a.catalog!,
          models: a.catalog!.models.map((m) => ({ ...m, isDefault: false, options: [] })),
        },
        usage: [],
      })),
      excludedAccounts: [],
      canRun: () => ({ ok: true }),
      now: Date.now(),
    });
    expect(candidates.map((c) => c.harnessInstanceId)).toEqual([work.harnessInstanceId]);
  } finally {
    host.dispose();
  }
});
it("keeps a default engine small model when the light list is edited", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const view = (await getAutomaticModels(host))!;
    const config = editAutomaticRole(view, "light", { type: "remove", index: 0 });
    expect(config.roles.light).toEqual(expect.arrayContaining([{ engine: "opencode" }]));
    await setAutomaticModels(host, config);
    expect(automaticRoleEntries((await getAutomaticModels(host))!, "light")).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "opencode · its small model" })]),
    );
  } finally {
    host.dispose();
  }
});
it("renders specialist roles and keeps unknown siblings inert", () => {
  expect(
    specialistModels({
      models: [{ role: "light" }, { unknown: { role: "future" } }, { role: "deep" }],
    }),
  ).toEqual([
    "Quick model · per your settings",
    "Unknown model entry",
    "Strong model · per your settings",
  ]);
});

it("seeds edited, excluded and unusable states without consent or pins", async () => {
  for (const automaticModels of ["seeded", "edited", "excluded", "none"] as const) {
    const host = new MockHostClient({ latencyMs: 0, automaticModels });
    try {
      const view = (await getAutomaticModels(host))!;
      if (automaticModels === "edited") expect(view.config.roles.deep).toHaveLength(1);
      if (automaticModels === "excluded")
        expect(view.accounts.some((a) => !a.eligible && a.reason === "excluded")).toBe(true);
      if (automaticModels === "none") expect(view.deep.candidates).toEqual([]);
    } finally {
      host.dispose();
    }
  }
});
