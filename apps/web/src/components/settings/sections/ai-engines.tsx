import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { harnessDisplayRank, harnessDriverLabel } from "@opensteer/core";
import type {
  HarnessAuthKind,
  HarnessObservedConnection,
  HarnessSourceDescriptor,
  HarnessInstallation,
  HostApiCommandInput,
} from "@opensteer/protocol";
import {
  deploymentStatusLabel,
  type DeploymentStatus,
} from "@opensteer/protocol/deployment-status";
import {
  describeConnectionUsage,
  mutationIdempotencyKey,
  observedAccountConnection,
  unwrapRpcResult,
  type EnvironmentSummary,
  type HarnessSummary,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import {
  startHarnessAuthentication,
  type HarnessAuthenticationRun,
} from "../../harness-authentication-dialog.js";
import { Icon } from "../../icon.js";
import { Popover } from "../../popover.js";
import { engineProviderId, ProviderLogo } from "../../provider-brand.js";
import { useToast } from "../../toast.js";
import { UsageMeter } from "../../usage-meter.js";
import { SectionHeader, SettingsRow } from "../primitives.js";
import { AddAccountDialog, type AddAccountChoice } from "./add-account-dialog.js";
import { ModelSettingsDialog } from "./model-settings-dialog.js";
import { isModelServerSource, modelServerKey, serverAccountName } from "./model-servers.js";
import {
  ModelServersCard,
  type ModelServerAccountRow,
  type ModelServerConnection,
} from "./model-servers-card.js";

type HarnessCatalog = EnvironmentSummary["harnessCatalogs"][number];

export function AiEnginesSection() {
  const { hostClient, openHarnessAuthentication, placements, snapshot } = useShell();
  const toast = useToast();
  return (
    <>
      <SectionHeader
        lead="Connect the accounts that power your agents. Each service has a default account on each computer."
        title="AI services"
      />
      <AiEngineSettings
        client={hostClient}
        environments={snapshot.environments}
        harnesses={snapshot.harnesses}
        onAuthenticate={openHarnessAuthentication}
        onError={(message) => toast.error(message)}
        placements={placements}
        updatesAvailable={snapshot.harnessUpdateAvailable === true}
      />
    </>
  );
}

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
  const menu: AiEngineAction[] = [];
  if (live && retry === null) {
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
          : retry,
  };
}

/**
 * The name a new account gets before anyone has signed in to it: the engine's
 * own name while it is the only one, then "Codex 2", "Codex 3" — the lowest
 * number not already taken on this work location, so removing "Codex 2" and
 * adding again yields "Codex 2" rather than "Codex 4".
 */
export function nextAccountName(engineName: string, takenNames: readonly string[]): string {
  const taken = new Set(takenNames);
  if (!taken.has(engineName)) return engineName;
  for (let index = 2; ; index += 1) {
    const candidate = `${engineName} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** One engine on one work location, with every account of it. */
interface EngineGroup {
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

export function installationUpdateLabel(update: HarnessInstallation["update"]): string {
  switch (update) {
    case "available":
      return "Update available";
    case "current":
      return "Up to date";
    case "manual":
      return "Update on computer";
    case "unknown":
      return "Update status unavailable";
    case "updating":
      return "Updating…";
    case "succeeded":
      return "Updated";
    case "failed":
      return "Update failed";
  }
}

/**
 * The engines a work location offers, whether or not an account exists for
 * them yet: every driver the Runner advertises as usable, plus any driver an
 * existing account still names. A driver the Runner reports as unavailable
 * is skipped unless an account of it already exists — that account then
 * shows the reason on its own row.
 */
export function engineGroups(
  environment: EnvironmentSummary,
  profiles: readonly HarnessSummary[],
): EngineGroup[] {
  const kinds = new Set<string>();
  for (const driver of environment.harnessDrivers) {
    if (driver.readiness !== "unavailable" || driver.installation) kinds.add(driver.driverKind);
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

/** The source an account was added for, as its engine declares it here. */
function accountSource(
  environment: EnvironmentSummary,
  profile: HarnessSummary,
): HarnessSourceDescriptor | null {
  const advertised = environment.harnessDrivers.find(
    (driver) => driver.driverKind === profile.driverKind,
  );
  if (!advertised || advertised.readiness === "unavailable") return null;
  return advertised.sources.find((source) => source.sourceId === profile.sourceId) ?? null;
}

function authKindLabel(authKind: HarnessAuthKind): string {
  switch (authKind) {
    case "subscription":
      return "Subscription";
    case "api-key":
      return "API key";
    case "cloud-identity":
      return "Cloud identity";
    case "none":
      return "No API key";
  }
}

type AiEngineRowState =
  | { readonly id: string; readonly kind: "confirm-remove" | "confirm-sign-out" }
  | { readonly id: string; readonly kind: "rename"; readonly name: string };

export function AiEngineSettings({
  client,
  environments,
  harnesses,
  onAuthenticate,
  onError,
  placements,
  updatesAvailable = false,
}: {
  readonly client: HostClient;
  readonly environments: readonly EnvironmentSummary[];
  readonly harnesses: readonly HarnessSummary[];
  readonly onAuthenticate: ((placement: ThreadPlacementOption) => void) | null;
  readonly onError: (message: string) => void;
  readonly placements: readonly ThreadPlacementOption[];
  readonly updatesAvailable?: boolean;
}) {
  // A link from the composer names the work location it was about, so the
  // page opens on that one rather than on whichever sorts first.
  const [searchParams] = useSearchParams();
  const [requestedEnvironmentId, setRequestedEnvironmentId] = useState<string | null>(
    searchParams.get("location") ?? environments[0]?.id ?? null,
  );
  const [rowState, setRowState] = useState<AiEngineRowState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // The engine whose "Add account" needs a choice or a field before it can
  // create anything; null while no dialog is open.
  const [adding, setAdding] = useState<EngineGroup | null>(null);
  // The server account whose models' limits are open for editing.
  const [configuringModels, setConfiguringModels] = useState<string | null>(null);
  // An account with no sign-in does nothing, so adding one hands straight over
  // to the sign-in dialog. Native startup can outlive the create request; the
  // id is held through the intermediate runtime check until its catalog lands.
  const [signInAfterCreate, setSignInAfterCreate] = useState<HarnessSummary | null>(null);
  // A new server handed to its sign-in, whose models open next if none can run.
  const [modelsAfterSignIn, setModelsAfterSignIn] = useState<string | null>(null);
  // A retry must send the exact original request, even if the response was
  // lost and the account has since appeared in the live inventory.
  const createAttempts = useRef(
    new Map<string, Extract<HostApiCommandInput, { type: "harness.create" }>>(),
  );
  const environment =
    environments.find(({ id }) => id === requestedEnvironmentId) ?? environments[0] ?? null;
  const profiles = environment
    ? harnesses.filter((harness) => harness.environmentId === environment.id)
    : [];
  // A model server's accounts are listed with the server, not with the engine
  // that happens to talk to it.
  const serverProfiles = environment
    ? profiles.filter((profile) => isModelServerSource(accountSource(environment, profile)))
    : [];
  const engines = environment
    ? engineGroups(
        environment,
        profiles.filter((profile) => !serverProfiles.includes(profile)),
      )
    : [];
  // Connect on a server the computer found copies its key in with no dialog;
  // the run is kept so leaving the page stops it.
  const importRun = useRef<HarnessAuthenticationRun | null>(null);
  useEffect(() => () => importRun.current?.stop(), []);
  const configuringProfile = profiles.find((profile) => profile.id === configuringModels) ?? null;
  const configuringCatalog = environment?.harnessCatalogs.find(
    (candidate) => candidate.harnessInstanceId === configuringModels,
  );

  useEffect(() => {
    if (signInAfterCreate === null) return;
    const placement = placements.find(
      (candidate) => candidate.harnessInstanceId === signInAfterCreate.id,
    );
    const target = environments.find(
      (candidate) => candidate.id === signInAfterCreate.environmentId,
    );
    const catalog = target?.harnessCatalogs.find(
      (candidate) => candidate.harnessInstanceId === signInAfterCreate.id,
    );
    const modelSettings =
      target !== undefined && accountSource(target, signInAfterCreate)?.modelSettings === true;
    const action = !target?.connected
      ? "error"
      : createdHarnessSignInAction(
          placement,
          onAuthenticate !== null,
          catalog?.status,
          modelSettings && catalog?.status === "ready"
            ? catalog.models.some((model) => model.needsContextWindow)
            : false,
        );
    if (action === "wait") return;
    setSignInAfterCreate(null);
    // An account that is already usable — an existing CLI sign-in the Runner
    // recognises — has nothing to sign in to.
    if (action === "complete") return;
    if (action === "models") {
      setConfiguringModels(signInAfterCreate.id);
      return;
    }
    // A server whose own settings hold its key is connected with that key:
    // choosing Connect was the click the sign-in would have asked for.
    const localImport = placement?.setupMethods.find((method) => method.kind === "local-import");
    if (action === "authenticate" && placement && localImport) {
      if (modelSettings) setModelsAfterSignIn(signInAfterCreate.id);
      const name = signInAfterCreate.name;
      importRun.current?.stop();
      importRun.current = startHarnessAuthentication({
        client,
        ...(localImport.connectionSlot ? { connectionSlot: localImport.connectionSlot } : {}),
        environmentId: placement.environmentId,
        harnessInstanceId: placement.harnessInstanceId,
        methodId: localImport.methodId,
        onError: (message) => onError(`${name} isn’t ready: ${message}`),
        onReady: () => undefined,
        onSession: (session) => {
          if (session.view.kind === "failed")
            onError(`${name} isn’t ready: ${session.view.detail}`);
        },
      });
      return;
    }
    if (action === "authenticate" && placement && onAuthenticate) {
      if (modelSettings) setModelsAfterSignIn(signInAfterCreate.id);
      onAuthenticate(placement);
      return;
    }
    onError(
      `${signInAfterCreate.name} isn’t ready: ${placement?.detail ?? "AI engine is unavailable"}`,
    );
  }, [client, environments, onAuthenticate, onError, placements, signInAfterCreate]);

  // A new server signed in to goes on to its models once, if none can run yet.
  useEffect(() => {
    if (modelsAfterSignIn === null) return;
    const target = environments.find((candidate) =>
      candidate.harnessCatalogs.some((catalog) => catalog.harnessInstanceId === modelsAfterSignIn),
    );
    const catalog = target?.harnessCatalogs.find(
      (candidate) => candidate.harnessInstanceId === modelsAfterSignIn,
    );
    if (
      target?.connected &&
      (catalog?.status === "authentication-required" || catalog?.status === "preparing")
    )
      return;
    setModelsAfterSignIn(null);
    if (
      target?.connected &&
      catalog?.status === "ready" &&
      catalog.models.some((model) => model.needsContextWindow)
    )
      setConfiguringModels(modelsAfterSignIn);
  }, [environments, modelsAfterSignIn]);

  /** Runs one profile operation with shared pending/error handling. */
  const run = (key: string, operation: () => Promise<unknown>, onDone?: () => void) => {
    setPending(key);
    void operation()
      .then(() => onDone?.())
      .catch((error: unknown) => onError(actionErrorMessage(error)))
      .finally(() => setPending(null));
  };

  const createAccount = (
    engine: Pick<EngineGroup, "driverKind" | "engineName">,
    choice: AddAccountChoice,
    options: { readonly onCreated?: () => void; readonly pendingKey?: string } = {},
  ) => {
    if (!environment || pending || signInAfterCreate) return;
    // The key stands for one exact request — engine, source and fields — so
    // a retry lands on the account the first attempt created and a different
    // choice is never mistaken for a replay of it.
    const attempt = `${environment.id}:${engine.driverKind}:${choice.source.sourceId}:${JSON.stringify(choice.fields)}`;
    setRowState(null);
    // Names are taken from the accounts as they are now, not as they were
    // when the dialog opened, so two accounts added in a row never collide.
    const takenNames = harnesses
      .filter(
        (harness) =>
          harness.environmentId === environment.id && harness.driverKind === engine.driverKind,
      )
      .map((harness) => harness.name);
    // An account of the lab itself is named after the engine; one that talks
    // somewhere else is named after that place — the endpoint's host when the
    // person typed one — so "openrouter.ai" never reads as "Codex 2".
    const baseName =
      choice.source.kind === "first-party"
        ? engine.engineName
        : (endpointAccountName(choice.source, choice.fields) ?? choice.source.label);
    const request =
      createAttempts.current.get(attempt) ??
      ({
        ...(Object.keys(choice.fields).length > 0 ? { config: choice.fields } : {}),
        driverKind: engine.driverKind,
        environmentId: environment.id,
        idempotencyKey: mutationIdempotencyKey(
          `harness-create:${environment.id}:${engine.driverKind}`,
        ),
        name: nextAccountName(baseName, takenNames),
        sourceId: choice.source.sourceId,
        stateKind: "isolated",
        type: "harness.create",
      } satisfies Extract<HostApiCommandInput, { type: "harness.create" }>);
    createAttempts.current.set(attempt, request);
    run(
      options.pendingKey ?? `add:${engine.driverKind}`,
      async () => {
        const result = await client.dispatch(request);
        if (result.type !== "harness.create") {
          throw new Error("AI engine create command mismatch.");
        }
        createAttempts.current.delete(attempt);
        setSignInAfterCreate(result.harness);
        options.onCreated?.();
      },
      () => setAdding(null),
    );
  };

  /** A server found on the computer, or checked at an address, becomes an account of its engine. */
  const connectModelServer = (connection: ModelServerConnection, onConnected: () => void) =>
    createAccount(
      {
        driverKind: connection.engine.driverKind,
        engineName: harnessDriverLabel(connection.engine.driverKind),
      },
      {
        fields: { baseUrl: connection.baseUrl, runtime: connection.runtime },
        source: connection.engine.source,
      },
      {
        onCreated: onConnected,
        pendingKey: `connect:${modelServerKey(connection.runtime, connection.baseUrl)}`,
      },
    );

  /**
   * One source with nothing to type creates straight away; anything else
   * asks first. The question is only ever "which source" and "its fields".
   */
  const addAccount = (engine: EngineGroup) => {
    const only = engine.sources.length === 1 ? engine.sources[0] : undefined;
    if (only && only.fields.length === 0) {
      createAccount(engine, { fields: {}, source: only });
      return;
    }
    setAdding(engine);
  };

  const updateEngine = (engine: EngineGroup) => {
    if (!environment || pending || !engine.installation) return;
    run(`update:${engine.driverKind}`, async () => {
      const result = await client.dispatch({
        driverKind: engine.driverKind,
        environmentId: environment.id,
        idempotencyKey: mutationIdempotencyKey(
          `harness-update:${environment.id}:${engine.driverKind}`,
        ),
        type: "harness.update",
      });
      if (result.type !== "harness.update") throw new Error("AI engine update command mismatch.");
      await client.refresh();
    });
  };

  const signOut = (profile: HarnessSummary, catalog: HarnessCatalog | undefined) => {
    const connectionSlot = catalog?.connections.find(
      (connection) => connection.status === "connected" && connection.logoutSupported,
    )?.connectionSlot;
    run(
      `logout:${profile.id}`,
      async () => {
        await client.dispatch({
          ...(connectionSlot ? { connectionSlot } : {}),
          environmentId: profile.environmentId,
          harnessInstanceId: profile.id,
          idempotencyKey: mutationIdempotencyKey(`harness-logout:${profile.id}`),
          type: "harness.authentication.logout",
        });
        await client.refresh();
      },
      () => setRowState(null),
    );
  };

  const refreshCatalog = async (profile: HarnessSummary) => {
    unwrapRpcResult(
      await client.rpc["harness.catalog.refresh"]({
        environmentId: profile.environmentId,
        harnessInstanceId: profile.id,
      }),
    );
    await client.refresh();
  };

  const selectAction = (
    profile: HarnessSummary,
    catalog: HarnessCatalog | undefined,
    placement: ThreadPlacementOption | undefined,
    action: AiEngineAction,
  ) => {
    switch (action.id) {
      case "refresh-models":
        run(`refresh:${profile.id}`, () => refreshCatalog(profile));
        return;
      case "models":
        setConfiguringModels(profile.id);
        return;
      case "add-connection":
      case "sign-in":
        if (placement && onAuthenticate) onAuthenticate(placement);
        return;
      case "make-default":
        run(`default:${profile.id}`, () =>
          client.dispatch({
            environmentId: profile.environmentId,
            harnessInstanceId: profile.id,
            idempotencyKey: mutationIdempotencyKey(`harness-default:${profile.id}`),
            type: "harness.default.set",
          }),
        );
        return;
      case "rename":
        setRowState({ id: profile.id, kind: "rename", name: profile.name });
        return;
      case "remove":
        setRowState({ id: profile.id, kind: "confirm-remove" });
        return;
      case "sign-out":
        if (profile.stateKind === "ambient") {
          setRowState({ id: profile.id, kind: "confirm-sign-out" });
          return;
        }
        signOut(profile, catalog);
        return;
      case "toggle-enabled":
        run(`enabled:${profile.id}`, () =>
          client.dispatch({
            enabled: !profile.enabled,
            environmentId: profile.environmentId,
            harnessInstanceId: profile.id,
            idempotencyKey: mutationIdempotencyKey(`harness-enabled:${profile.id}`),
            type: "harness.enabled.set",
          }),
        );
        return;
    }
  };

  const rename = (event: FormEvent<HTMLFormElement>, profile: HarnessSummary, name: string) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || pending !== null) return;
    // Two accounts of one engine with one name would read the same wherever
    // an account is named, so the collision is refused here, where it is made.
    const taken = harnesses.some(
      (harness) =>
        harness.id !== profile.id &&
        harness.environmentId === profile.environmentId &&
        harness.driverKind === profile.driverKind &&
        harness.name.trim().toLocaleLowerCase() === next.toLocaleLowerCase(),
    );
    if (taken) {
      onError(
        `Another ${harnessDriverLabel(profile.driverKind)} account here is already called “${next}”.`,
      );
      return;
    }
    run(
      `rename:${profile.id}`,
      () =>
        client.dispatch({
          environmentId: profile.environmentId,
          harnessInstanceId: profile.id,
          idempotencyKey: mutationIdempotencyKey(`harness-rename:${profile.id}`),
          name: next,
          type: "harness.rename",
        }),
      () => setRowState(null),
    );
  };

  if (!environment) {
    return (
      <div className="card">
        <p className="card__empty">No work location is attached to this deployment yet.</p>
      </div>
    );
  }

  /** One account's row: its rename form while renaming, otherwise its facts and actions. */
  const renderAccount = (
    profile: HarnessSummary,
    engineName: string,
    unavailableReason: string | null,
  ): ReactNode => {
    const catalog = environment.harnessCatalogs.find(
      (candidate) => candidate.harnessInstanceId === profile.id,
    );
    const placement = placements.find(
      (candidate) =>
        candidate.environmentId === environment.id && candidate.harnessInstanceId === profile.id,
    );
    const state = rowState?.id === profile.id ? rowState : null;
    if (state?.kind === "rename") {
      return (
        <form
          className="card__form settings-ai-engine-form"
          key={profile.id}
          onSubmit={(event) => rename(event, profile, state.name)}
        >
          <label className="field">
            <span className="field__label">Name for this account</span>
            <input
              autoFocus
              className="text-input"
              disabled={pending !== null}
              maxLength={120}
              onChange={(event) => setRowState({ ...state, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRowState(null);
              }}
              required
              value={state.name}
            />
            <span className="field__hint">
              For example, “Work” or “Personal”. Shown wherever this account is named.
            </span>
          </label>
          <div className="settings-ai-engine-form__actions">
            <button
              className="btn btn--primary btn--small"
              disabled={!state.name.trim() || pending !== null}
              type="submit"
            >
              {pending === `rename:${profile.id}` ? "Saving…" : "Save name"}
            </button>
            <button
              className="btn btn--ghost btn--small"
              disabled={pending !== null}
              onClick={() => setRowState(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      );
    }
    const source = accountSource(environment, profile);
    const actions = aiEngineActions({
      catalog,
      environment,
      profile,
      setupOpenable: placement?.setupAvailable === true && onAuthenticate !== null,
      source,
    });
    return (
      <AccountRow
        action={
          state?.kind === "confirm-remove" ? (
            <ConfirmActions
              busy={pending === `remove:${profile.id}`}
              disabled={pending !== null}
              label="Remove"
              onCancel={() => setRowState(null)}
              onConfirm={() =>
                run(
                  `remove:${profile.id}`,
                  () =>
                    client.dispatch({
                      environmentId: profile.environmentId,
                      harnessInstanceId: profile.id,
                      idempotencyKey: mutationIdempotencyKey(`harness-delete:${profile.id}`),
                      type: "harness.delete",
                    }),
                  () => setRowState(null),
                )
              }
              pendingLabel="Removing…"
            />
          ) : state?.kind === "confirm-sign-out" ? (
            <ConfirmActions
              busy={pending === `logout:${profile.id}`}
              disabled={pending !== null}
              label="Sign out"
              onCancel={() => setRowState(null)}
              onConfirm={() => signOut(profile, catalog)}
              pendingLabel="Signing out…"
            />
          ) : (
            <>
              {actions.primary ? (
                <button
                  className="btn btn--primary btn--small"
                  disabled={pending !== null}
                  onClick={() =>
                    actions.primary && selectAction(profile, catalog, placement, actions.primary)
                  }
                  type="button"
                >
                  {actions.primary.label}
                </button>
              ) : null}
              {actions.menu.length > 0 ? (
                <AiEngineRowMenu
                  disabled={pending !== null}
                  items={actions.menu}
                  label={`More actions for ${profile.name}`}
                  onSelect={(action) => selectAction(profile, catalog, placement, action)}
                />
              ) : null}
            </>
          )
        }
        catalog={catalog}
        confirming={
          state?.kind === "confirm-remove"
            ? profile.stateKind === "ambient"
              ? `Remove this account from ${environment.name}? The ${engineName} CLI on that computer keeps its sign-in — only Opensteer stops using it. An account an active Thread is using cannot be removed.`
              : `Remove this account from ${environment.name}? Its sign-in is deleted. An account an active Thread is using cannot be removed.`
            : state?.kind === "confirm-sign-out"
              ? `This account shares its sign-in with the ${engineName} CLI on that computer, so signing out here signs the CLI out too.`
              : null
        }
        engineName={engineName}
        environment={environment}
        key={profile.id}
        profile={profile}
        source={source}
        unavailableReason={unavailableReason}
      />
    );
  };

  const serverAccounts: ModelServerAccountRow[] = serverProfiles.map((profile) => {
    const advertised = environment.harnessDrivers.find(
      (driver) => driver.driverKind === profile.driverKind,
    );
    return {
      node: renderAccount(
        profile,
        harnessDriverLabel(profile.driverKind),
        advertised?.readiness === "unavailable" ? advertised.reason : null,
      ),
      serverKey: modelServerKey(profile.endpoint?.runtime, profile.endpoint?.baseUrl ?? profile.id),
    };
  });

  return (
    <>
      {adding ? (
        <AddAccountDialog
          engineName={adding.engineName}
          onClose={() => {
            if (pending === null) setAdding(null);
          }}
          onSubmit={(choice) => createAccount(adding, choice)}
          sources={adding.sources}
          submitting={pending === `add:${adding.driverKind}`}
          whereLabel={environment.name}
        />
      ) : null}
      {configuringProfile ? (
        <ModelSettingsDialog
          catalog={configuringCatalog}
          client={client}
          connected={environment.connected}
          key={configuringProfile.id}
          onClose={() => setConfiguringModels(null)}
          onRefresh={() => refreshCatalog(configuringProfile)}
          profile={configuringProfile}
        />
      ) : null}
      {environments.length > 1 ? (
        <fieldset className="settings-choice-group settings-ai-engines__locations">
          <legend className="visually-hidden">Work location</legend>
          {environments.map((candidate) => (
            <label
              className={`settings-choice${candidate.id === environment.id ? " is-selected" : ""}`}
              key={candidate.id}
            >
              <input
                checked={candidate.id === environment.id}
                name="ai-engine-environment"
                onChange={() => {
                  setRequestedEnvironmentId(candidate.id);
                  setRowState(null);
                }}
                type="radio"
                value={candidate.id}
              />
              <span className="settings-choice__copy">
                <span className="settings-choice__title">{candidate.name}</span>
                <span className="settings-choice__detail">{environmentStatusLabel(candidate)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {signInAfterCreate ? (
        <div className="notice" role="status">
          <span>
            {isModelServerSource(accountSource(environment, signInAfterCreate))
              ? `Connecting ${signInAfterCreate.name}…`
              : `Preparing sign-in for ${signInAfterCreate.name}…`}
          </span>{" "}
          <button
            className="btn btn--ghost btn--small"
            onClick={() => setSignInAfterCreate(null)}
            type="button"
          >
            Sign in later
          </button>
        </div>
      ) : null}
      <div className="settings-engines">
        <ModelServersCard
          accounts={serverAccounts}
          client={client}
          connecting={pending?.startsWith("connect:") ? pending.slice("connect:".length) : null}
          disabled={pending !== null || signInAfterCreate !== null}
          environment={environment}
          onConnect={connectModelServer}
        />
        {engines.map((engine) => {
          const providerId = engineProviderId(engine.driverKind);
          const headingId = `settings-engine-${engine.driverKind}`;
          return (
            <section
              aria-labelledby={headingId}
              className="card settings-engine"
              key={engine.driverKind}
            >
              <header className="settings-engine__head">
                <span className="settings-engine__mark">
                  {providerId !== null ? (
                    <ProviderLogo providerId={providerId} />
                  ) : (
                    <Icon name="terminal" />
                  )}
                </span>
                <h2 className="settings-engine__title" id={headingId}>
                  {engine.engineName}
                </h2>
                <span className="settings-engine__count">
                  {engine.profiles.length === 1
                    ? "1 account"
                    : `${engine.profiles.length} accounts`}
                </span>
                {engine.installation ? (
                  <span className="settings-engine__update-state" role="status">
                    {installationUpdateLabel(engine.installation.update)}
                  </span>
                ) : null}
                {updatesAvailable &&
                engine.installation &&
                (engine.installation.update === "available" ||
                  engine.installation.update === "unknown" ||
                  engine.installation.update === "failed") ? (
                  <button
                    className="btn btn--small btn--ghost settings-engine__update"
                    disabled={pending !== null}
                    onClick={() => updateEngine(engine)}
                    type="button"
                  >
                    {pending === `update:${engine.driverKind}` ? "Updating…" : "Update"}
                  </button>
                ) : null}
                {engine.addable ? (
                  <button
                    className="btn btn--small settings-engine__add"
                    disabled={pending !== null || signInAfterCreate !== null}
                    onClick={() => addAccount(engine)}
                    type="button"
                  >
                    {pending === `add:${engine.driverKind}` ? "Adding…" : "Add account"}
                  </button>
                ) : null}
              </header>
              {engine.installation &&
              (engine.installation.update === "failed" ||
                engine.installation.update === "manual") ? (
                <p className="settings-engine__update-detail" role="status">
                  {engine.installation.detail ??
                    (engine.installation.update === "manual"
                      ? "Update this engine on its computer."
                      : "The update did not finish.")}
                  {engine.installation.manualCommand
                    ? ` Run ${engine.installation.manualCommand}.`
                    : ""}
                </p>
              ) : null}
              {engine.profiles.map((profile) =>
                renderAccount(profile, engine.engineName, engine.unavailableReason),
              )}
              {engine.profiles.length === 0 ? (
                <p className="card__empty">
                  {engine.addable
                    ? `No ${engine.engineName} account yet. Add one to start Threads with it here.`
                    : `No ${engine.engineName} account on this work location.`}
                </p>
              ) : null}
            </section>
          );
        })}
        {engines.length === 0 ? (
          <div className="card">
            <p className="card__empty">
              {environment.connected
                ? "This work location has no AI engines installed."
                : "Reconnect this work location to see its AI engines."}
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
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
): string | null {
  if (!connection) return null;
  const line = [
    connection.accountLabel,
    connection.billingLabel,
    source?.quota === "windows" ? describeConnectionUsage(connection, now) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return line.length > 0 ? line : null;
}

/**
 * One account of an engine: its name, whether it is the default, whether it
 * can run, who it signs in as, how much plan is left, and where the sign-in
 * came from. A confirmation replaces the facts with the question.
 */
function AccountRow({
  action,
  catalog,
  confirming,
  engineName,
  environment,
  profile,
  source,
  unavailableReason,
}: {
  readonly action: ReactNode;
  readonly catalog: HarnessCatalog | undefined;
  readonly confirming: string | null;
  readonly engineName: string;
  readonly environment: EnvironmentSummary;
  readonly profile: HarnessSummary;
  readonly source: HarnessSourceDescriptor | null;
  readonly unavailableReason: string | null;
}) {
  const status = profile.enabled
    ? aiEngineStatus(environment, catalog, unavailableReason, source?.modelSettings === true)
    : {
        detail: "Turned off. Threads that use it keep it selected but cannot run.",
        label: "Off",
        tone: "chip--warn",
      };
  const connection = catalog ? observedAccountConnection(catalog.connections) : null;
  // Only a missing context size is fixed from here; a model the server hasn't
  // loaded, or one without tools, is explained in the models dialog instead.
  const needingContext =
    catalog?.status === "ready"
      ? catalog.models.filter((model) => model.needsContextWindow).length
      : 0;
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
    : aiEngineAccountLine(connection, source);
  // Where this account talks to and how it got in: the source unless it is the
  // lab itself, the endpoint the driver saw for a compatible one, the kind of
  // credential, and whether the sign-in is the CLI's own or this account's.
  const originLine = [
    source === null
      ? // An engine the Runner cannot run advertises no sources at all, so the
        // account's source is missing for a reason the status line already
        // gives; only a source an available engine dropped is worth naming.
        unavailableReason !== null
        ? null
        : "A source this engine no longer offers here"
      : source.kind === "first-party"
        ? null
        : source.kind === "compatible-endpoint" && connection
          ? `${source.label} · ${connection.label}`
          : source.label,
    connection?.authKind !== undefined ? authKindLabel(connection.authKind) : null,
    profile.stateKind === "ambient"
      ? `Shares the ${engineName} CLI’s sign-in on this computer`
      : "Its own sign-in, kept on this work location",
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <SettingsRow
      action={action}
      className={`settings-account settings-ai-engine-row${confirming ? " is-confirming" : ""}`}
      detail={
        confirming ?? (
          <span className="settings-account__facts">
            <span className="settings-account__line">
              {/* A failure outranks who the account is: it is what needs acting on. */}
              {catalog?.status === "error" ||
              catalog?.status === "unavailable" ||
              (server && status.tone !== "chip--ok")
                ? status.detail
                : (accountLine ?? status.detail)}
            </span>
            {connection && source?.quota === "windows" ? (
              <UsageMeter connection={connection} />
            ) : null}
            {server ? null : <span className="settings-account__origin">{originLine}</span>}
            {catalog?.status === "ready" && profile.enabled ? (
              <span className="settings-account__origin">
                {catalog.models.length} {catalog.models.length === 1 ? "model" : "models"}
                {needingContext > 0
                  ? ` · ${needingContext} ${needingContext === 1 ? "needs" : "need"} a context size`
                  : null}
                {catalog.capturedAt ? (
                  <>
                    {" "}
                    · Updated{" "}
                    <time dateTime={catalog.capturedAt}>
                      {new Date(catalog.capturedAt).toLocaleString()}
                    </time>
                  </>
                ) : null}
              </span>
            ) : null}
          </span>
        )
      }
      icon={server ? "server" : "user"}
      title={
        <>
          {profile.name}
          {profile.isDefault ? <span className="chip chip--accent">Default</span> : null}
          <span className={`chip ${status.tone}`}>{status.label}</span>
        </>
      }
    />
  );
}

function ConfirmActions({
  busy,
  disabled,
  label,
  onCancel,
  onConfirm,
  pendingLabel,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly pendingLabel: string;
}) {
  return (
    <>
      <button
        className="btn btn--danger btn--small"
        disabled={disabled}
        onClick={onConfirm}
        type="button"
      >
        {busy ? pendingLabel : label}
      </button>
      <button
        className="btn btn--ghost btn--small"
        disabled={disabled}
        onClick={onCancel}
        type="button"
      >
        Cancel
      </button>
    </>
  );
}

function AiEngineRowMenu({
  disabled,
  items,
  label,
  onSelect,
}: {
  readonly disabled: boolean;
  readonly items: readonly AiEngineAction[];
  readonly label: string;
  readonly onSelect: (action: AiEngineAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="icon-btn"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        ref={anchorRef}
        type="button"
      >
        <Icon name="more" />
      </button>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="settings-row-menu"
          label={label}
          onClose={() => setOpen(false)}
        >
          {items.map((item) => (
            <button
              className={`picker__row${item.danger ? " picker__row--danger" : ""}`}
              key={item.id}
              onClick={() => {
                setOpen(false);
                onSelect(item);
              }}
              role="menuitem"
              type="button"
            >
              <span className="picker__label-stack">
                <span className="picker__label">{item.label}</span>
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

/**
 * What follows creating an account once its first catalog lands. Only an
 * account that asks for a sign-in gets one: a server that cannot be reached
 * is an error the account row explains and retries, because signing in again
 * cannot start it. A server that answered with models waiting on a context
 * size goes on to its models, which is where that is typed.
 */
export function createdHarnessSignInAction(
  placement: ThreadPlacementOption | undefined,
  authenticationOpenable: boolean,
  catalogStatus?: HarnessCatalog["status"],
  needsContextWindow = false,
): "authenticate" | "complete" | "error" | "models" | "wait" {
  if (catalogStatus === "error" || catalogStatus === "unavailable") return "error";
  if (catalogStatus === "ready" && needsContextWindow) return "models";
  if (
    !placement ||
    placement.availability === "runtime-check" ||
    placement.availability === "preparing"
  )
    return "wait";
  if (placement.available) return "complete";
  return placement.availability === "authentication-required" &&
    placement.setupAvailable &&
    placement.harnessAuthenticationAllowed &&
    authenticationOpenable
    ? "authenticate"
    : "error";
}

/**
 * A work location uses the same status words as everything else in the product.
 */
function environmentStatusLabel(environment: EnvironmentSummary): string {
  return deploymentStatusLabel(environmentStatus(environment));
}

function environmentStatus(environment: EnvironmentSummary): DeploymentStatus {
  if (environment.connected) return "ready";
  return "offline";
}

function aiEngineStatus(
  environment: EnvironmentSummary | null,
  catalog: HarnessCatalog | undefined,
  unavailableReason: string | null = null,
  modelSettings = false,
): { detail: string; label: string; tone: string } {
  if (!environment?.connected) {
    return { detail: "This work location is offline", label: "Offline", tone: "chip--bad" };
  }
  // The Runner cannot run this engine here at all, so it reports no catalog for
  // the account and the only thing worth saying is its own sentence.
  if (unavailableReason !== null) {
    return { detail: unavailableReason, label: "Needs attention", tone: "chip--bad" };
  }
  // The server answered, but a ready catalog with nothing runnable is not ready.
  if (catalog?.status === "ready" && !catalog.models.some((model) => !model.unavailableReason)) {
    return modelSettings
      ? {
          detail: catalog.models.some((model) => model.needsContextWindow)
            ? "Tell Opensteer each model’s context size to start using it."
            : (catalog.models[0]?.unavailableReason ?? "None of its models can run"),
          label: "Needs setup",
          tone: "chip--warn",
        }
      : {
          detail: catalog.models[0]?.unavailableReason ?? "None of its models can run",
          label: "Needs attention",
          tone: "chip--bad",
        };
  }
  if (catalog?.status === "ready") {
    return { detail: catalog.detail ?? "Ready to run", label: "Ready", tone: "chip--ok" };
  }
  if (catalog?.status === "preparing") {
    return { detail: catalog.detail, label: "Preparing", tone: "chip--warn" };
  }
  if (catalog?.status === "authentication-required") {
    return { detail: catalog.detail, label: "Sign in required", tone: "chip--warn" };
  }
  return {
    detail: catalog?.detail ?? "Checking this AI engine",
    label:
      catalog?.status === "unavailable" || catalog?.status === "error"
        ? "Needs attention"
        : "Starting",
    tone:
      catalog?.status === "unavailable" || catalog?.status === "error" ? "chip--bad" : "chip--warn",
  };
}
