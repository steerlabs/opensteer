import {
  modelLabLabels,
  type BackgroundModelMode,
  type BackgroundModelRole,
  type ExecutionSelection,
  type ModelSelection,
} from "@opensteer/core";
import type { BackgroundModelsView } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
export function getBackgroundModels(client: Pick<HostClient, "rpc">) {
  return client.rpc["backgroundModels.get"]({});
}
export function setBackgroundModelRole(
  client: Pick<HostClient, "rpc">,
  role: BackgroundModelRole,
  mode: BackgroundModelMode,
) {
  return client.rpc["commands.dispatch"]({
    type: "backgroundModels.role.set",
    role,
    mode,
    idempotencyKey: crypto.randomUUID(),
  });
}
export function setBackgroundProviderConsent(
  client: Pick<HostClient, "rpc">,
  providerId: ModelSelection["providerId"],
  acknowledged: boolean,
) {
  return client.rpc["commands.dispatch"]({
    type: "backgroundModels.consent.set",
    providerId,
    acknowledged,
    idempotencyKey: crypto.randomUUID(),
  });
}

type Candidate = BackgroundModelsView["light"]["candidates"][number];
type ProviderId = ModelSelection["providerId"];

export interface BackgroundModelChoice {
  readonly value: string;
  readonly label: string;
  readonly mode: BackgroundModelMode;
}
export interface BackgroundRoleSettings {
  readonly role: BackgroundModelRole;
  readonly title: string;
  /** What runs this role now, in words. */
  readonly detail: string;
  /** The choice in force, one of `choices`. */
  readonly value: string;
  readonly choices: readonly BackgroundModelChoice[];
}
export interface BackgroundProviderRow {
  readonly providerId: ProviderId;
  readonly name: string;
  readonly allowed: boolean;
}
export interface BackgroundConsentNotice {
  readonly providerId: ProviderId;
  readonly name: string;
  readonly text: string;
}
export interface BackgroundModelsSettings {
  readonly roles: readonly BackgroundRoleSettings[];
  readonly providers: readonly BackgroundProviderRow[];
  readonly notice: BackgroundConsentNotice | null;
}

export const backgroundModelsTitle = "Background models";
export const backgroundModelsLead =
  "Opensteer uses these for small jobs of its own: naming tasks and keeping memory.";
export const backgroundProvidersNote =
  "Providers you allow may run background work. Revoking stops their next job.";
const roleTitles: Readonly<Record<BackgroundModelRole, string>> = {
  light: "Task names and quick memory",
  deep: "Nightly memory",
};
const skipLabels: Readonly<Record<NonNullable<Candidate["skipReason"]>, string>> = {
  "consent-required": "needs your OK",
  offline: "computer offline",
  unsupported: "computer needs an update",
  disabled: "account turned off",
  "catalog-not-ready": "account not ready",
  "model-unavailable": "model not offered",
  "option-unavailable": "setting not offered",
  "usage-limit": "usage limit reached",
};

const automatic: BackgroundModelChoice = {
  value: "automatic",
  label: "Automatic",
  mode: { kind: "automatic" },
};
function selectionKey(selection: ExecutionSelection) {
  const { environmentId, harnessInstanceId, modelSelection } = selection;
  return JSON.stringify([
    environmentId,
    harnessInstanceId,
    modelSelection.providerId,
    modelSelection.modelId,
    Object.entries(modelSelection.options).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
/** The Host copies a native id from its own catalog; a pin never carries one. */
function pinned(candidate: Candidate): BackgroundModelMode {
  const { nativeModelId: _native, ...modelSelection } = candidate.modelSelection;
  return {
    kind: "pinned",
    selection: {
      environmentId: candidate.environmentId,
      harnessInstanceId: candidate.harnessInstanceId,
      modelSelection,
    },
  };
}
function providerName(providerId: string, candidates: readonly Candidate[]) {
  return (
    candidates.find((candidate) => candidate.modelSelection.providerId === providerId)
      ?.providerDisplayName ??
    modelLabLabels[providerId] ??
    providerId
  );
}

/**
 * Settings' account of background models, the same on every surface: each
 * role's state and choices, the providers that may do the work, and the one
 * consent notice worth showing. `dismissed` names providers whose notice the
 * person answered "Not now" on this device, or is null until that is known.
 */
export function backgroundModelsSettings(
  view: BackgroundModelsView,
  dismissed: ReadonlySet<string> | null,
): BackgroundModelsSettings {
  const all = [...view.light.candidates, ...view.deep.candidates];
  const computers = new Set(all.map((candidate) => candidate.environmentId));
  const where = (candidate: Candidate) =>
    computers.size > 1
      ? `${candidate.accountDisplayName} on ${candidate.computerDisplayName}`
      : candidate.accountDisplayName;
  const named = (candidate: Candidate) => `${candidate.modelDisplayName} via ${where(candidate)}`;
  const roles = (["light", "deep"] as const).map((role): BackgroundRoleSettings => {
    const { mode, effectivePick, candidates } = view[role];
    const pin =
      mode.kind === "pinned" ? (candidates.find((c) => c.reason === "pinned") ?? null) : null;
    const choices = [
      automatic,
      ...candidates
        .filter((candidate) => candidate.skipReason === null || candidate === pin)
        .map((candidate) => ({
          value: selectionKey(candidate),
          label: `${candidate.modelDisplayName} · ${where(candidate)}`,
          mode: pinned(candidate),
        })),
    ];
    let value = automatic.value;
    if (mode.kind === "pinned") {
      value = pin ? selectionKey(pin) : selectionKey(mode.selection);
      // A pin whose account is gone stays named, so the person sees what they chose.
      if (!pin)
        choices.push({
          value,
          label: `${mode.selection.modelSelection.modelId} · unavailable`,
          mode,
        });
    }
    const fallback = effectivePick ? ` Using ${named(effectivePick)} meanwhile.` : "";
    const detail =
      mode.kind === "pinned"
        ? pin && pin.skipReason === null
          ? named(pin)
          : `${pin?.modelDisplayName ?? mode.selection.modelSelection.modelId} isn't available (${
              pin?.skipReason ? skipLabels[pin.skipReason] : "account removed"
            }).${fallback}`
        : effectivePick
          ? `Automatic (currently ${named(effectivePick)})`
          : candidates.some((candidate) => candidate.skipReason === "consent-required")
            ? "Automatic. Waiting for you to allow a provider."
            : "Automatic. No model can run this right now.";
    return { role, title: roleTitles[role], detail, value, choices };
  });
  const providerIds = [
    ...new Set([
      ...all
        .filter(
          (candidate) =>
            candidate.skipReason === null || candidate.skipReason === "consent-required",
        )
        .map((candidate) => candidate.modelSelection.providerId),
      ...view.backgroundProviderConsent,
    ]),
  ];
  const providers = providerIds.map((providerId) => ({
    providerId,
    name: providerName(providerId, all),
    allowed: view.backgroundProviderConsent.includes(providerId),
  }));
  // Only a provider ahead of what runs now is worth asking about; nothing is
  // asked until the device's dismissals are known.
  const waiting =
    dismissed === null
      ? undefined
      : (["light", "deep"] as const)
          .map((role) => {
            const { candidates } = view[role];
            const usable = candidates.findIndex((candidate) => candidate.skipReason === null);
            return candidates
              .slice(0, usable === -1 ? candidates.length : usable)
              .find((candidate) => candidate.skipReason === "consent-required");
          })
          .find(
            (candidate) =>
              candidate !== undefined && !dismissed.has(candidate.modelSelection.providerId),
          );
  const notice = waiting
    ? {
        providerId: waiting.modelSelection.providerId,
        name: waiting.providerDisplayName,
        text: `Let ${waiting.providerDisplayName} name your tasks and run memory passes? It sees the first message of each new task (up to 2,000 characters) and your memory files during memory passes.`,
      }
    : null;
  return { roles, providers, notice };
}

/** Where a device remembers "Not now", per Deployment, person and provider. */
export function backgroundConsentDismissalKey(input: {
  readonly deploymentId: string;
  readonly userId: string;
  readonly providerId: string;
}) {
  return `background-consent\n${input.deploymentId}\n${input.userId}\n${input.providerId}`;
}
/** The providers this person dismissed on this device, from a dismissal store's keys. */
export function dismissedBackgroundProviders(
  keys: ReadonlySet<string> | null,
  scope: { readonly deploymentId: string; readonly userId: string },
): ReadonlySet<string> | null {
  if (keys === null) return null;
  const prefix = backgroundConsentDismissalKey({ ...scope, providerId: "" });
  return new Set(
    [...keys].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
  );
}
