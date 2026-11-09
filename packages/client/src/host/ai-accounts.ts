import { harnessCatalogEntry, harnessDisplayRank, harnessDriverLabel } from "@opensteer/core";
import type {
  HarnessInstallation,
  HarnessObservedConnection,
  HarnessSourceDescriptor,
  HarnessSourceField,
  HostApiCommandInput,
} from "@opensteer/protocol";
import { accountDisplayName, nextAccountName } from "./account-name.js";
import type { EnvironmentSummary, HarnessSummary } from "./client.js";
import { describeConnectionUsage, observedAccountConnection } from "./connection-usage.js";
import { mutationIdempotencyKey } from "./host-session-client.js";
import {
  isModelServerSource,
  normalizeServerAddress,
  serverAccountName,
  serverAddressProblem,
} from "./model-servers.js";

type HarnessCatalog = EnvironmentSummary["harnessCatalogs"][number];

export interface AiEngineAction {
  readonly danger?: boolean;
  readonly id:
    | "add-connection"
    | "make-default"
    | "models"
    | "refresh-models"
    | "remove"
    | "rename"
    | "sign-in"
    | "sign-out"
    | "toggle-enabled";
  readonly label: string;
}

/**
 * Which controls one account row offers: at most one primary button, with
 * everything else behind the row's overflow menu so a row never becomes a
 * toolbar.
 */
export function aiEngineActions({
  catalog,
  environment,
  profile,
  setupOpenable,
  source = null,
}: {
  readonly catalog: HarnessCatalog | undefined;
  readonly environment: EnvironmentSummary;
  readonly profile: HarnessSummary;
  /** Whether this surface can open the sign-in dialog for this profile. */
  readonly setupOpenable: boolean;
  readonly source?: HarnessSourceDescriptor | null;
}): { readonly menu: readonly AiEngineAction[]; readonly primary: AiEngineAction | null } {
  const allowed = environment.harnessAuthenticationAllowed;
  const setupReady =
    profile.enabled &&
    allowed &&
    setupOpenable &&
    catalog !== undefined &&
    catalog.setupMethods.length > 0;
  const live = allowed && profile.enabled && environment.connected;
  // A server that is stopped or unreachable reports an error, and signing in
  // again cannot start it: the way forward is to check it and try again.
  const retry =
    live && (catalog?.status === "error" || catalog?.status === "unavailable")
      ? ({ id: "refresh-models", label: "Try again" } as const)
      : null;
  const configurable = live && source?.modelSettings === true && catalog?.status === "ready";
  // Setup leads only when typing a context size would make a model usable; one
  // that can't be fixed from here (not loaded, no tools) is the server's to fix.
  const stuck = configurable && catalog.models.some((model) => model.needsContextWindow);
  // Saved limits stay in view while the server is re-read or its computer is
  // offline, though nothing can be changed or chosen until it answers.
  const saved = Object.keys(profile.modelSettings ?? {}).length > 0;
  const checkAgain =
    live && catalog?.status === "authentication-required" && catalog.setupMethods.length === 0
      ? ({ id: "refresh-models", label: "Check again" } as const)
      : null;
  const menu: AiEngineAction[] = [];
  if (live && retry === null && checkAgain === null) {
    menu.push({ id: "refresh-models", label: "Refresh models" });
  }
  if ((configurable || saved) && !stuck) {
    menu.push({ id: "models", label: "Models" });
  }
  if (allowed && profile.enabled && !profile.isDefault) {
    menu.push({ id: "make-default", label: "Make default" });
  }
  // "Add connection" is an offer to add a second account beside the ones the
  // Runner already reports. It exists only where the catalog advertises a
  // setup method for a connection slot nothing is sitting in yet; an engine
  // that reports one account and no spare slot has nothing to add.
  const hasEmptyConnectionSlot =
    catalog !== undefined &&
    catalog.setupMethods.some(
      (method) =>
        method.connectionSlot !== undefined &&
        !catalog.connections.some(
          (connection) => connection.connectionSlot === method.connectionSlot,
        ),
    );
  if (setupReady && catalog.status !== "authentication-required" && hasEmptyConnectionSlot) {
    menu.push({ id: "add-connection", label: "Add connection" });
  }
  if (
    profile.enabled &&
    allowed &&
    environment.connected &&
    catalog?.connections.some(
      (connection) => connection.status === "connected" && connection.logoutSupported,
    )
  ) {
    menu.push({ id: "sign-out", label: "Sign out" });
  }
  if (allowed) {
    menu.push({ id: "rename", label: "Rename" });
    menu.push({ id: "toggle-enabled", label: profile.enabled ? "Turn off" : "Turn on" });
    if (environment.connected) {
      menu.push({ danger: true, id: "remove", label: "Remove" });
    }
  }
  return {
    menu,
    primary:
      setupReady && catalog.status === "authentication-required"
        ? { id: "sign-in", label: "Sign in" }
        : stuck
          ? { id: "models", label: "Set up models" }
          : (retry ?? checkAgain),
  };
}

/** One engine on one work location, with every account of it. */
export interface EngineGroup {
  readonly addable: boolean;
  readonly driverKind: string;
  readonly engineName: string;
  readonly installation: HarnessInstallation | null;
  readonly profiles: readonly HarnessSummary[];
  /** The sources a new, private account here may be added for. */
  readonly sources: readonly HarnessSourceDescriptor[];
  /**
   * Why this work location cannot run this engine, in the Runner's own words —
   * an engine the product does not ship that the person has not installed, for
   * instance. Null when the Runner advertises the engine as usable.
   */
  readonly unavailableReason: string | null;
}

/**
 * The engines a work location offers, whether or not an account exists for
 * them yet: every product engine the Runner advertises, plus any driver an
 * existing account still names. A product engine the Runner cannot run, such
 * as one whose CLI is not installed, stays listed with the Runner's reason, so
 * the person learns how to make it runnable. An unavailable driver the
 * product no longer names is skipped unless an account of it still exists.
 */
export function engineGroups(
  environment: EnvironmentSummary,
  profiles: readonly HarnessSummary[],
): EngineGroup[] {
  const kinds = new Set<string>();
  for (const driver of environment.harnessDrivers) {
    if (
      driver.readiness !== "unavailable" ||
      driver.installation ||
      harnessCatalogEntry(driver.driverKind)
    )
      kinds.add(driver.driverKind);
  }
  for (const profile of profiles) kinds.add(profile.driverKind);
  const canAddAccounts =
    environment.harnessAuthenticationAllowed &&
    environment.connected &&
    (environment.providerStateModes.includes("isolated") || environment.kind === "managed");
  return [...kinds]
    .sort((left, right) => harnessDisplayRank(left) - harnessDisplayRank(right))
    .map((driverKind) => {
      const advertised = environment.harnessDrivers.find(
        (driver) => driver.driverKind === driverKind,
      );
      // A new account is always a private one, so only sources that allow a
      // private sign-in are on offer; an ambient-only source is the CLI's own.
      // A model server is added under Model servers, where it is found.
      const sources =
        advertised && advertised.readiness !== "unavailable"
          ? advertised.sources.filter(
              (source) => source.stateKinds.includes("isolated") && !isModelServerSource(source),
            )
          : [];
      return {
        addable: canAddAccounts && sources.length > 0,
        driverKind,
        engineName: harnessDriverLabel(driverKind),
        installation: advertised?.installation ?? null,
        sources,
        // The default first, as the picker lists it; the rest keep the Host's
        // creation order so a rename never moves an account.
        profiles: profiles
          .filter((profile) => profile.driverKind === driverKind)
          .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)),
        unavailableReason: advertised?.readiness === "unavailable" ? advertised.reason : null,
      };
    });
}

/**
 * The name a new account of a model server starts with: what the server is
 * when it runs on the account's own computer, otherwise its address.
 */
export function endpointAccountName(
  source: HarnessSourceDescriptor,
  fields: Readonly<Record<string, string>>,
): string | null {
  const runtime = source.fields.find((field) => field.kind === "select");
  for (const field of source.fields) {
    const value = fields[field.id];
    if (field.kind !== "url" || value === undefined) continue;
    const name = serverAccountName(runtime ? fields[runtime.id] : undefined, value);
    if (name) return name;
  }
  return null;
}

/**
 * The source pressing Add account starts with, with nothing to ask first: the
 * only one, or the service's own. Any other source stays one step away.
 */
export function directSource(
  sources: readonly HarnessSourceDescriptor[],
): HarnessSourceDescriptor | undefined {
  const candidates =
    sources.length === 1 ? sources : sources.filter((source) => source.kind === "first-party");
  return candidates.length === 1 && candidates[0]!.fields.length === 0 ? candidates[0] : undefined;
}

/** The source an account was added for, as its engine declares it here. */
export function accountSource(
  environment: EnvironmentSummary,
  profile: HarnessSummary,
): HarnessSourceDescriptor | null {
  const advertised = environment.harnessDrivers.find(
    (driver) => driver.driverKind === profile.driverKind,
  );
  if (!advertised || advertised.readiness === "unavailable") return null;
  return advertised.sources.find((source) => source.sourceId === profile.sourceId) ?? null;
}

/**
 * Who this account signs in as, how it is paid for, and what is left of it.
 *
 * Nothing is second-guessed here: a driver emits `billingLabel` only when it
 * adds something the auth kind does not already say, so suppressing it would
 * throw away the one word — a plan name, a lab — the driver thought worth the
 * room. Usage is shown only for a source that can actually report windows,
 * because an empty bar reads as plenty left.
 */
export function aiEngineAccountLine(
  connection: HarnessObservedConnection | null,
  source: HarnessSourceDescriptor | null,
  now: number = Date.now(),
  labelInTitle = false,
): string | null {
  if (!connection) return null;
  const line = [
    labelInTitle ? undefined : connection.accountLabel,
    connection.billingLabel,
    source?.quota === "windows" ? describeConnectionUsage(connection, now) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return line.length > 0 ? line : null;
}

export interface AiEngineStatus {
  readonly detail: string;
  readonly label: string;
  readonly tone: "bad" | "ok" | "warn";
}

function aiEngineStatus(
  environment: EnvironmentSummary | null,
  catalog: HarnessCatalog | undefined,
  unavailableReason: string | null = null,
  modelSettings = false,
): AiEngineStatus {
  if (!environment?.connected) {
    return { detail: "This work location is offline", label: "Offline", tone: "bad" };
  }
  // The Runner cannot run this engine here at all, so it reports no catalog for
  // the account and the only thing worth saying is its own sentence.
  if (unavailableReason !== null) {
    return { detail: unavailableReason, label: "Needs attention", tone: "bad" };
  }
  // The server answered, but a ready catalog with nothing runnable is not ready.
  if (catalog?.status === "ready" && !catalog.models.some((model) => !model.unavailableReason)) {
    return modelSettings
      ? {
          detail: catalog.models.some((model) => model.needsContextWindow)
            ? "Tell Opensteer each model’s context size to start using it."
            : (catalog.models[0]?.unavailableReason ?? "None of its models can run"),
          label: "Needs setup",
          tone: "warn",
        }
      : {
          detail: catalog.models[0]?.unavailableReason ?? "None of its models can run",
          label: "Needs attention",
          tone: "bad",
        };
  }
  if (catalog?.status === "ready") {
    return { detail: catalog.detail ?? "Ready to run", label: "Ready", tone: "ok" };
  }
  if (catalog?.status === "preparing") {
    return { detail: catalog.detail, label: "Preparing", tone: "warn" };
  }
  if (catalog?.status === "authentication-required") {
    return { detail: catalog.detail, label: "Sign in required", tone: "warn" };
  }
  return {
    detail: catalog?.detail ?? "Checking this AI engine",
    label:
      catalog?.status === "unavailable" || catalog?.status === "error"
        ? "Needs attention"
        : "Starting",
    tone: catalog?.status === "unavailable" || catalog?.status === "error" ? "bad" : "warn",
  };
}

/**
 * What one account's row says: who it is and how much plan is left. A status
 * appears only when something needs attention.
 */
export function aiEngineAccountRow({
  catalog,
  engineName,
  environment,
  now = Date.now(),
  profile,
  source,
  unavailableReason,
}: {
  readonly catalog: HarnessCatalog | undefined;
  readonly engineName: string;
  readonly environment: EnvironmentSummary;
  readonly now?: number;
  readonly profile: HarnessSummary;
  readonly source: HarnessSourceDescriptor | null;
  readonly unavailableReason: string | null;
}): {
  readonly connection: HarnessObservedConnection | null;
  readonly line: string | null;
  readonly name: string;
  readonly server: boolean;
  readonly status: AiEngineStatus | null;
} {
  const status: AiEngineStatus = profile.enabled
    ? aiEngineStatus(environment, catalog, unavailableReason, source?.modelSettings === true)
    : {
        detail: "Turned off. Threads that use it keep it selected but cannot run.",
        label: "Off",
        tone: "warn",
      };
  const connection = catalog ? observedAccountConnection(catalog.connections) : null;
  const name = accountDisplayName({
    accountLabel: connection?.accountLabel,
    engineName,
    name: profile.name,
  });
  // A model server is known by its address, whether it takes a key, and the
  // engine that talks to it — it is listed with the server, not the engine.
  const server = isModelServerSource(source);
  const accountLine = server
    ? [
        // A server named for its address need not say the address twice.
        connection?.label !== undefined && connection.label !== profile.name
          ? connection.label
          : null,
        connection?.authKind === "api-key" ? "API key" : null,
        `Runs with ${engineName}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")
    : aiEngineAccountLine(connection, source, now, name === connection?.accountLabel);
  const ready = status.tone === "ok";
  // The Sign in button says all there is to say about an account that has one.
  const signInOffered =
    catalog?.status === "authentication-required" && catalog.setupMethods.length > 0;
  return {
    connection,
    line: ready ? accountLine : signInOffered ? null : status.detail,
    name,
    server,
    status: ready ? null : status,
  };
}

/** What the person chose: a source, and a value for each field it declares. */
export interface AddAccountChoice {
  readonly fields: Readonly<Record<string, string>>;
  readonly source: HarnessSourceDescriptor;
}

/** The address field of a source that talks to an endpoint the person names. */
export function addAccountAddressField(
  source: HarnessSourceDescriptor | undefined,
): HarnessSourceField | undefined {
  return source?.fields.find((field) => field.kind === "url");
}

/** A source's own defaults, so a field with a sensible answer starts with it. */
export function addAccountInitialValues(
  source: HarnessSourceDescriptor | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (source?.fields ?? []).flatMap((field) =>
      field.defaultValue !== undefined ? [[field.id, field.defaultValue]] : [],
    ),
  );
}

/** Whether a value can be sent for this field; an optional one may be blank. */
function fieldAccepts(field: HarnessSourceField, value: string): boolean {
  if (value === "") return field.required === false;
  if (field.kind === "select") {
    return field.options?.some((option) => option.value === value) ?? false;
  }
  return field.kind !== "url" || serverAddressProblem(value) === null;
}

export function addAccountComplete(
  source: HarnessSourceDescriptor,
  values: Readonly<Record<string, string>>,
): boolean {
  return source.fields.every((field) => fieldAccepts(field, (values[field.id] ?? "").trim()));
}

export function addAccountChoice(
  source: HarnessSourceDescriptor,
  values: Readonly<Record<string, string>>,
): AddAccountChoice {
  return {
    fields: Object.fromEntries(
      source.fields.flatMap((field) => {
        const value = (values[field.id] ?? "").trim();
        if (!value) return [];
        return [[field.id, field.kind === "url" ? normalizeServerAddress(value) : value]];
      }),
    ),
    source,
  };
}

/**
 * The command that creates an account. Names are taken from the accounts as
 * they are now, not as they were when the person started, so two accounts added
 * in a row never collide.
 */
export function accountCreateRequest(input: {
  readonly choice: AddAccountChoice;
  readonly driverKind: string;
  readonly engineName: string;
  readonly environmentId: string;
  readonly harnesses: readonly HarnessSummary[];
}): Extract<HostApiCommandInput, { type: "harness.create" }> {
  const takenNames = input.harnesses
    .filter(
      (harness) =>
        harness.environmentId === input.environmentId && harness.driverKind === input.driverKind,
    )
    .map((harness) => harness.name);
  // An account of the lab itself is named after the engine; one that talks
  // somewhere else is named after that place — the endpoint's host when the
  // person typed one — so "openrouter.ai" never reads as "Codex 2".
  const baseName =
    input.choice.source.kind === "first-party"
      ? input.engineName
      : (endpointAccountName(input.choice.source, input.choice.fields) ??
        input.choice.source.label);
  return {
    ...(Object.keys(input.choice.fields).length > 0 ? { config: input.choice.fields } : {}),
    driverKind: input.driverKind,
    environmentId: input.environmentId,
    idempotencyKey: mutationIdempotencyKey(
      `harness-create:${input.environmentId}:${input.driverKind}`,
    ),
    name: nextAccountName(baseName, takenNames),
    sourceId: input.choice.source.sourceId,
    stateKind: "isolated",
    type: "harness.create",
  };
}
