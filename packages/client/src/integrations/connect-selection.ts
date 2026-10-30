import type {
  IntegrationConnectionSummary,
  IntegrationDashboard,
  IntegrationDefinitionSummaryView,
  IntegrationOAuthApplicationSource,
  IntegrationProvider,
  IntegrationProviderApplication,
  IntegrationProviderManifest,
} from "@opensteer/integration-core";
import {
  oauthSourceFinishesOnHostComputer,
  sameIntegrationOAuthApplicationSource,
} from "@opensteer/integration-core";

/**
 * What one Connect flow decides before it touches the Host, shared by the web
 * sheet and the phone's. Everything here reads the dashboard the Host already
 * returns; nothing infers an eligible sign-in app from a catalog entry, a
 * provider manifest, or a definition's declared hosted-OAuth capability.
 *
 * Two rules this file exists to hold:
 *
 * - the Host's concrete `selectedSource` is the only preselection. An eligible
 *   custom app does not become the default because it is the only one: the Host
 *   leaves the selection null when a saved default is missing or its service is
 *   down, and preselecting through that would connect against an app the person
 *   never chose.
 * - a chosen app that stops being offered stops the flow. Falling back would
 *   authorize a different OAuth client than the one that was picked.
 */
export interface ConnectSignInOption {
  /** The registered app behind this option; absent for Opensteer's own. */
  readonly application: IntegrationProviderApplication | null;
  readonly detail: string;
  readonly label: string;
  readonly source: IntegrationOAuthApplicationSource;
}

/**
 * Why a Connect flow cannot start. Configuration that was never done, an app
 * that was withdrawn, a service that is down right now, and a surface that may
 * not launch authorization at all are four different problems with four
 * different instructions, and only one of them is worth a Retry.
 */
export type ConnectAvailability =
  | { readonly kind: "ready" }
  | {
      readonly canSetUpOwnApp: boolean;
      readonly detail: string;
      readonly kind: "account-link" | "setup-required" | "source-unavailable";
    }
  | { readonly canSetUpOwnApp: boolean; readonly detail: string; readonly kind: "hosted-outage" }
  | { readonly detail: string; readonly kind: "other-surface" };

export function connectProviderManifest(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): IntegrationProviderManifest | null {
  return dashboard.providers.find((candidate) => candidate.provider === provider) ?? null;
}

/**
 * Anyone may register an app for themselves; only an administrator may offer
 * one to the whole deployment. The Host enforces both — this is what the flow
 * offers, and it needs the provider's own setup manifest to offer anything.
 */
export function canSetUpOwnApp(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): boolean {
  return (
    connectProviderManifest(dashboard, provider) !== null &&
    Boolean(dashboard.callbackUrls[provider]) &&
    dashboard.providerAuthorizations[provider]?.code !== "CANONICAL_SURFACE_REQUIRED"
  );
}

export function canShareApps(dashboard: IntegrationDashboard): boolean {
  return dashboard.isAdministrator;
}

/**
 * The apps a sign-in can use from this device. A remote session cannot finish
 * one whose provider returns to the Host computer's loopback address.
 */
export function connectSignInOptions(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): readonly ConnectSignInOption[] {
  const remote = dashboard.authorizationSurface === "personal-remote";
  const sources = (dashboard.providerAuthorizations[provider]?.availableSources ?? []).filter(
    (source) => !remote || !oauthSourceFinishesOnHostComputer(source),
  );
  return sources.map((source) => {
    if (source.kind === "hosted-oauth") {
      return {
        application: null,
        detail: dashboard.hostedOAuthDisclosure,
        label: "Opensteer",
        source,
      };
    }
    // A custom source is one exact registration, so it is matched by id and
    // never by its kind: several of these can be offered at once.
    const application =
      dashboard.applications.find(({ id }) => id === source.providerApplicationId) ?? null;
    return {
      application,
      detail:
        application?.availability === "personal"
          ? "Your own app. Only you can sign in with it."
          : "Registered for everyone in this deployment.",
      label: application?.displayName ?? "This deployment's app",
      source,
    };
  });
}

/** The Host's concrete selection, or nothing to start on. */
export function initialConnectSource(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): IntegrationOAuthApplicationSource | null {
  const selected = dashboard.providerAuthorizations[provider]?.selectedSource ?? null;
  if (!selected) return null;
  return connectSignInOptions(dashboard, provider).some(({ source }) =>
    sameIntegrationOAuthApplicationSource(source, selected),
  )
    ? selected
    : null;
}

/**
 * A Host with eligible apps and no default reports a failure code, because
 * nothing is *selected* — the person can still connect by choosing one. So an
 * eligible app outranks the code.
 *
 * A remote session's Host reports CANONICAL_SURFACE_REQUIRED when its selected
 * app returns to the Host computer; another app that can finish here is then
 * offered by choice. An older Host reports it for every remote sign-in, with a
 * selection that could finish anywhere, and that refusal stands.
 */
export function connectAvailability(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): ConnectAvailability {
  const canSetUp = canSetUpOwnApp(dashboard, provider);
  const authorization = dashboard.providerAuthorizations[provider] ?? null;
  const options = connectSignInOptions(dashboard, provider);
  if (authorization?.code === "CANONICAL_SURFACE_REQUIRED") {
    const selected = authorization.selectedSource;
    return options.length > 0 && selected !== null && oauthSourceFinishesOnHostComputer(selected)
      ? { kind: "ready" }
      : { detail: authorization.detail, kind: "other-surface" };
  }
  if (options.length > 0) return { kind: "ready" };
  if (!authorization) {
    return {
      canSetUpOwnApp: canSetUp,
      detail: "This deployment has no sign-in app for this service yet.",
      kind: "setup-required",
    };
  }
  switch (authorization.code) {
    case "READY":
      return { kind: "ready" };
    case "OAUTH_SOURCE_UNAVAILABLE":
      return { canSetUpOwnApp: canSetUp, detail: authorization.detail, kind: "source-unavailable" };
    case "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE":
      return { canSetUpOwnApp: canSetUp, detail: authorization.detail, kind: "hosted-outage" };
    case "ACCOUNT_LINK_REQUIRED":
    case "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED":
      return { canSetUpOwnApp: canSetUp, detail: authorization.detail, kind: "account-link" };
    case "PROVIDER_APPLICATION_REQUIRED":
      return { canSetUpOwnApp: canSetUp, detail: authorization.detail, kind: "setup-required" };
  }
}

/**
 * Opensteer's own sign-in service did not answer, which is not evidence that it
 * was never registered — the difference decides between Retry and setup.
 */
export function hostedOAuthOutage(
  dashboard: IntegrationDashboard,
  provider: IntegrationProvider,
): boolean {
  return (
    dashboard.providerAuthorizations[provider]?.hostedOAuthStatus === "temporarily-unavailable"
  );
}

/** The provider's own fixed consent set, as the installed definition declares it. */
export function connectRequestedScopes(
  definition: IntegrationDefinitionSummaryView,
): readonly string[] {
  const method = definition.authMethods.find((candidate) => candidate.kind === "oauth");
  return method?.kind === "oauth" ? method.oauth.scopes : [];
}

export function connectChoiceAvailable(
  options: readonly ConnectSignInOption[],
  chosen: IntegrationOAuthApplicationSource | null,
): boolean {
  return (
    chosen === null ||
    options.some(({ source }) => sameIntegrationOAuthApplicationSource(source, chosen))
  );
}

export function connectOption(
  options: readonly ConnectSignInOption[],
  chosen: IntegrationOAuthApplicationSource | null,
): ConnectSignInOption | null {
  if (!chosen) return null;
  return (
    options.find(({ source }) => sameIntegrationOAuthApplicationSource(source, chosen)) ?? null
  );
}

/**
 * The source for the app the Host just saved, found by that record's own id and
 * revision. Two people — or one person twice — can register apps with the same
 * name and client id, so nothing here identifies a registration by its contents.
 */
export function connectSavedSource(
  dashboard: IntegrationDashboard,
  application: Pick<IntegrationProviderApplication, "id" | "provider" | "revision">,
): IntegrationOAuthApplicationSource | null {
  return (
    connectSignInOptions(dashboard, application.provider).find(
      ({ source }) =>
        source.kind === "deployment-oauth" &&
        source.providerApplicationId === application.id &&
        source.providerApplicationRevision === application.revision,
    )?.source ?? null
  );
}

/** The app this person may edit, when the chosen option is one of theirs. */
export function manageableApplication(
  option: ConnectSignInOption | null,
): IntegrationProviderApplication | null {
  return option?.application?.canManage ? option.application : null;
}

/** The real connection row, or null — the only evidence that an account exists. */
export function connectedAccount(
  dashboard: IntegrationDashboard,
  connectionId: string | null,
): IntegrationConnectionSummary | null {
  if (!connectionId) return null;
  return (
    dashboard.connections.find(
      (connection) => connection.id === connectionId && connection.status === "connected",
    ) ?? null
  );
}

/**
 * The row a completed provider callback may continue with: a connected one,
 * or one whose sign-in worked but which the provider still grants too little,
 * GitHub's repository installation step between OAuth and readiness.
 */
export function authorizationConnection(
  dashboard: IntegrationDashboard,
  connectionId: string | null,
): IntegrationConnectionSummary | null {
  if (!connectionId) return null;
  return (
    dashboard.connections.find(
      (connection) =>
        connection.id === connectionId &&
        (connection.status === "connected" || connection.statusReason === "permissions"),
    ) ?? null
  );
}

export type RepositoryAccountStep =
  | {
      readonly connection: IntegrationConnectionSummary;
      readonly kind: "connected" | "repository-access";
    }
  | {
      /** The reason the Host recorded on the account, when there is one. */
      readonly detail: string | null;
      readonly kind: "sign-in";
    };

/**
 * Where a GitHub account goes after a refused repository check, read from the
 * row the Host reloaded rather than from the refusal. The Host records
 * GitHub's rejection of the sign-in, which only a new sign-in repairs, and
 * leaves the account waiting for repositories after an outage, a rate limit
 * or a 403, which a recheck can outlast. A gone account signs in again too.
 */
export function repositoryAccountStep(
  dashboard: IntegrationDashboard,
  connectionId: string,
): RepositoryAccountStep {
  const connection = authorizationConnection(dashboard, connectionId);
  if (connection === null) {
    const row = dashboard.connections.find(({ id }) => id === connectionId);
    return { detail: row?.statusDetail ?? null, kind: "sign-in" };
  }
  return {
    connection,
    kind: connection.status === "connected" ? "connected" : "repository-access",
  };
}
