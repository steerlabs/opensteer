import { harnessCatalogEntry } from "@opensteer/core";
import type { EnvironmentSummary, ThreadPlacementOption } from "@opensteer/client/host";
import type { HarnessSetupMethod } from "@opensteer/protocol";

/**
 * A plan a person pays for, named the way they know it, and the engine and
 * source Opensteer runs it through. Setup never asks which engine: the plan
 * decides. API keys, cloud accounts and model servers are not plans and live
 * in Settings → AI.
 */
export interface SetupPlan {
  /**
   * Whether a new Opensteer-made account of this source can take the plan's
   * own sign-in. Claude's subscription signs in only through the person's own
   * Claude Code, whose account Opensteer creates when it finds the CLI.
   */
  readonly addable: boolean;
  readonly driverKind: string;
  readonly featured: boolean;
  readonly id: string;
  readonly name: string;
  /** The lab whose mark the row wears. */
  readonly providerId: string;
  readonly sourceId: string;
}

export const setupPlans: readonly SetupPlan[] = [
  plan("claude", "Claude", "claude", "anthropic", "anthropic", { addable: false, featured: true }),
  plan("chatgpt", "ChatGPT", "codex", "openai", "openai", { featured: true }),
  plan("gemini", "Gemini", "antigravity", "google", "google", { featured: true }),
  plan("grok", "Grok", "grok", "xai", "xai", { featured: true }),
  plan("cursor", "Cursor", "cursor", "cursor", "cursor"),
  plan("copilot", "GitHub Copilot", "pi", "github-copilot", "github"),
  plan("meta", "Meta", "muse", "meta", "meta"),
  plan("kimi", "Kimi", "pi", "kimi-coding", "moonshot"),
];

function plan(
  id: string,
  name: string,
  driverKind: string,
  sourceId: string,
  providerId: string,
  options: { readonly addable?: boolean; readonly featured?: boolean } = {},
): SetupPlan {
  return {
    addable: options.addable ?? true,
    driverKind,
    featured: options.featured ?? false,
    id,
    name,
    providerId,
    sourceId,
  };
}

/** What one plan row offers right now, read from live state. */
export type SetupPlanAction =
  | {
      readonly kind: "sign-in";
      readonly methodId: string | null;
      readonly placement: ThreadPlacementOption;
    }
  | { readonly kind: "add"; readonly environmentId: string }
  | { readonly kind: "get"; readonly installUrl: string }
  | { readonly kind: "working" };

export type SetupAiRow =
  | {
      readonly kind: "ready";
      readonly detail: string | null;
      readonly key: string;
      readonly name: string;
      readonly placement: ThreadPlacementOption;
      readonly providerId: string | null;
    }
  | {
      readonly action: SetupPlanAction;
      readonly kind: "plan";
      readonly key: string;
      readonly plan: SetupPlan;
    };

export interface SetupAiRows {
  /** Plans beyond the featured four, for the "More AI" sheet. */
  readonly more: readonly SetupAiRow[];
  /** What already works on this computer, then the featured plans. */
  readonly rows: readonly SetupAiRow[];
}

/**
 * The rows the AI step shows. Anything that already runs here comes first —
 * a signed-in CLI, a free model, a model server found on this computer — so
 * nothing the person already has is ever hidden behind "More". A plan with
 * no way to be offered here (its engine is not on this platform, or its sign-
 * in is not one this computer can run) is left out rather than shown dead.
 */
export function setupAiRows(
  placements: readonly ThreadPlacementOption[],
  environments: readonly EnvironmentSummary[],
): SetupAiRows {
  const local = placements.filter(
    (placement) => placement.environmentKind === "main" && placement.availability !== "disabled",
  );
  const ready = local.filter((placement) => placement.available);
  const readyRows: SetupAiRow[] = ready.map((placement) => {
    const matched = setupPlans.find((candidate) => matches(candidate, placement));
    return {
      detail: matched
        ? "Signed in"
        : placement.source?.kind === "compatible-endpoint"
          ? "Running on this computer"
          : "Ready",
      key: `ready:${placement.harnessInstanceId}`,
      kind: "ready",
      name: matched?.name ?? placement.accountName,
      placement,
      providerId: matched?.providerId ?? null,
    };
  });
  const main = environments.find((environment) => environment.kind === "main") ?? null;
  const planRow = (candidate: SetupPlan): SetupAiRow | null => {
    if (ready.some((placement) => matches(candidate, placement))) return null;
    const action = planAction(candidate, local, main);
    return action ? { action, key: `plan:${candidate.id}`, kind: "plan", plan: candidate } : null;
  };
  const featured = setupPlans.filter(({ featured }) => featured).map(planRow);
  const more = setupPlans.filter(({ featured }) => !featured).map(planRow);
  return {
    more: more.filter((row): row is SetupAiRow => row !== null),
    rows: [...readyRows, ...featured.filter((row): row is SetupAiRow => row !== null)],
  };
}

function matches(candidate: SetupPlan, placement: ThreadPlacementOption): boolean {
  return candidate.driverKind === placement.driverKind && candidate.sourceId === placement.sourceId;
}

function planAction(
  candidate: SetupPlan,
  local: readonly ThreadPlacementOption[],
  main: EnvironmentSummary | null,
): SetupPlanAction | null {
  const accounts = local.filter((placement) => matches(candidate, placement));
  if (
    accounts.some(
      ({ availability }) => availability === "preparing" || availability === "runtime-check",
    )
  ) {
    return { kind: "working" };
  }
  const signIn = accounts.find(
    (placement) =>
      placement.availability === "authentication-required" &&
      placement.setupAvailable &&
      placement.harnessAuthenticationAllowed &&
      planSignInMethod(placement.setupMethods) !== undefined,
  );
  if (signIn) {
    return {
      kind: "sign-in",
      methodId: planSignInMethod(signIn.setupMethods) ?? null,
      placement: signIn,
    };
  }
  if (!main?.connected) return null;
  const driver = main.harnessDrivers.find(({ driverKind }) => driverKind === candidate.driverKind);
  if (!driver) return null;
  if (driver.readiness === "unavailable") {
    const entry = harnessCatalogEntry(candidate.driverKind);
    const installUrl =
      entry && "installed" in entry && entry.installed
        ? entry.installed.installUrl
        : entry?.runtime.shape === "installed"
          ? entry.runtime.installUrl
          : null;
    return installUrl ? { kind: "get", installUrl } : null;
  }
  // An account of this engine exists already but cannot sign in to the plan
  // from here; Settings → AI explains it. A new account is added only where
  // a person-made account of that source can carry the plan's own sign-in.
  if (accounts.length > 0 || !candidate.addable) return null;
  const source = driver.sources.find(({ sourceId }) => sourceId === candidate.sourceId);
  if (!source || !source.stateKinds.includes("isolated") || source.fields.length > 0) return null;
  if (!main.harnessAuthenticationAllowed || !main.providerStateModes.includes("isolated")) {
    return null;
  }
  return { environmentId: main.id, kind: "add" };
}

/**
 * The plan's own way in: a browser or device sign-in, never a pasted key. An
 * account whose only ways in are keys is not a plan sign-in.
 */
export function planSignInMethod(methods: readonly HarnessSetupMethod[]): string | undefined {
  return methods.find((method) => method.kind !== "secret-input" && method.kind !== "local-import")
    ?.methodId;
}
