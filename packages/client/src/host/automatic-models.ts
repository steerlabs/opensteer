import {
  AutomaticModelConfigSchema,
  type AutomaticModelConfig,
  type AutomaticModelRole,
  type AutomaticModelWant,
} from "@opensteer/core";
import type { AutomaticModelsView } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import { unwrapRpcResult } from "./host-session-client.js";

export async function getAutomaticModels(
  client: Pick<HostClient, "rpc" | "automaticModelsAvailable">,
) {
  if (!client.automaticModelsAvailable?.()) return null;
  return unwrapRpcResult(await client.rpc["automaticModels.get"]({}));
}
export async function setAutomaticModels(
  client: Pick<HostClient, "rpc" | "automaticModelsAvailable">,
  config: AutomaticModelConfig,
) {
  if (!client.automaticModelsAvailable?.())
    throw new Error("This Host does not support automatic models.");
  return unwrapRpcResult(
    await client.rpc["commands.dispatch"]({
      type: "automaticModels.set",
      config: parseAutomaticModelConfig(config),
      idempotencyKey: crypto.randomUUID(),
    }),
  );
}
export const automaticModelsTitle = "Automatic models";
export const automaticModelsExplanation =
  "Automatic work — task names, memory and specialists — can use any AI account available to you here. Turn off any you don't want used.";
export function automaticModelsDismissalKey(deploymentId: string, userId: string) {
  return `automatic-models\n${deploymentId}\n${userId}`;
}
export const automaticRoleTitles = { light: "Task names and quick memory", deep: "Nightly memory" };
export function automaticModelChoices(view: AutomaticModelsView) {
  return view.accounts.flatMap((account) =>
    account.catalog?.status === "ready"
      ? account.catalog.models
          .filter((model) => !model.unavailableReason)
          .map((model) => ({
            label: `${model.displayName} · ${account.accountDisplayName}`,
            want: {
              engine: account.driverKind,
              model: model.modelId,
              ...(account.sourceId === "openai-compatible"
                ? { harnessInstanceId: account.harnessInstanceId }
                : {}),
            } satisfies AutomaticModelWant,
          }))
      : [],
  );
}
export function automaticRoleEntries(
  view: AutomaticModelsView,
  role: AutomaticModelRole,
): { label: string; want: AutomaticModelWant | null }[] {
  const configured = view.config.roles[role];
  if (configured)
    return configured.map((want) =>
      "unknown" in want
        ? { label: "Unknown model entry", want: null }
        : {
            label: `${want.engine} · ${want.model}${want.harnessInstanceId ? ` · ${view.accounts.find((a) => a.harnessInstanceId === want.harnessInstanceId)?.accountDisplayName ?? want.harnessInstanceId}` : ""}`,
            want,
          },
    );
  return view.maintainedDefaults[role].map((entry) =>
    "unknown" in entry
      ? { label: "Unknown model entry", want: null }
      : entry.kind === "catalog-light"
        ? {
            label: `${entry.driverKind} · catalog quick model`,
            want: (() => {
              const account = view.accounts.find(
                (a) =>
                  a.driverKind === entry.driverKind &&
                  a.sourceId !== "openai-compatible" &&
                  a.catalog?.status === "ready" &&
                  a.catalog.lightModel,
              );
              const light =
                account?.catalog?.status === "ready" ? account.catalog.lightModel : null;
              return light
                ? { engine: entry.driverKind, model: light.modelId, options: light.options }
                : null;
            })(),
          }
        : {
            label: `${entry.driverKind} · ${entry.modelId}`,
            want: { engine: entry.driverKind, model: entry.modelId, options: entry.options },
          },
  );
}
export function automaticPreviewLines(view: AutomaticModelsView, role: AutomaticModelRole) {
  return [
    ...view[role].candidates.map(
      (c) =>
        `${c.modelDisplayName} · ${c.accountDisplayName} on ${c.computerDisplayName}${c.usageLimited ? " · near its usage limit" : ""}`,
    ),
    ...view[role].skipped.map(
      (s) =>
        `${s.modelDisplayName ?? "Model"}${s.accountDisplayName ? ` · ${s.accountDisplayName}` : ""}: ${s.reason.replaceAll("-", " ")}${s.detail ? ` — ${s.detail}` : ""}`,
    ),
  ];
}
export function editAutomaticRole(
  view: AutomaticModelsView,
  role: AutomaticModelRole,
  action:
    | { type: "reset" }
    | { type: "add"; want: AutomaticModelWant }
    | { type: "remove"; index: number }
    | { type: "move"; index: number; offset: number },
): AutomaticModelConfig {
  const config = parseAutomaticModelConfig(view.config);
  if (action.type === "reset") {
    delete config.roles[role];
    return config;
  }
  const entries = automaticRoleEntries(view, role);
  if (view.config.roles[role]?.some((entry) => "unknown" in entry))
    throw new Error("Update Opensteer to edit unknown model entries.");

  const edited = [...entries];
  if (action.type === "remove") edited.splice(action.index, 1);
  if (edited.some((e) => !e.want))
    throw new Error(
      "A catalog quick model is unavailable. Connect its account before editing this default list, or replace the list in Advanced.",
    );
  const wants = edited.flatMap((e) => (e.want ? [e.want] : []));
  if (action.type === "add") wants.push(action.want);
  if (action.type === "move") {
    const target = action.index + action.offset;
    if (target >= 0 && target < wants.length) {
      const item = wants.splice(action.index, 1)[0]!;
      wants.splice(target, 0, item);
    }
  }
  config.roles[role] = wants;
  return parseAutomaticModelConfig(config);
}

export function parseAutomaticModelConfig(input: unknown): AutomaticModelConfig {
  const parsed = AutomaticModelConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "Config"}: ${issue.message}`)
        .join("\n"),
    );
  return parsed.data;
}
