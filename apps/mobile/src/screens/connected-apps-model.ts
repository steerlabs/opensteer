import {
  connectAvailability,
  connectSignInOptions,
  initialConnectSource,
  installationDefinition,
  integrationAccountRepair,
  integrationAccountStatus,
  integrationAccountTitle,
  type ConnectSignInOption,
  type IntegrationAccountRepair,
  type IntegrationAccountStatus,
  type IntegrationConnectionSummary,
  type IntegrationDashboard,
  type IntegrationOAuthApplicationSource,
  type IntegrationPlatformDashboardView,
} from "@opensteer/client/integrations";

/**
 * How this phone signs in to an app: straight to the provider with the app the
 * Host selected, by choosing among several, or not here at all because the
 * sign-in returns to the computer running Opensteer.
 */
export type ConnectedAppSignIn =
  | { readonly kind: "direct"; readonly source: IntegrationOAuthApplicationSource }
  | { readonly kind: "choose"; readonly options: readonly ConnectSignInOption[] }
  | { readonly kind: "elsewhere"; readonly note: string }
  | { readonly detail: string; readonly kind: "unavailable" };

export interface ConnectedAccountRow {
  readonly id: IntegrationConnectionSummary["id"];
  readonly repair: IntegrationAccountRepair | null;
  readonly status: IntegrationAccountStatus;
  readonly title: string;
}

export interface ConnectedAppModel {
  readonly accounts: readonly ConnectedAccountRow[];
  readonly definitionId: string;
  readonly description: string;
  readonly name: string;
  /** Null for an app connected with a key, which is added from a computer. */
  readonly signIn: ConnectedAppSignIn | null;
}

/**
 * The apps whose accounts this person can see and repair from the phone: every
 * active installation that signs in with OAuth or already holds an account.
 * An app on a computer is set up on that computer, so it is not one of them.
 * Apps that need someone come first, so a repair is never below the fold.
 */
export function connectedAppsModel(input: {
  readonly dashboard: IntegrationDashboard;
  readonly hostName: string;
  readonly platform: IntegrationPlatformDashboardView;
}): readonly ConnectedAppModel[] {
  const apps = input.platform.installations.flatMap(({ installation }): ConnectedAppModel[] => {
    if (installation.status !== "active") return [];
    const definition = installationDefinition(installation.manifest);
    if (definition === null || definition.computerApp !== undefined) return [];
    const oauth = definition.authMethods.some(({ kind }) => kind === "oauth");
    const connections = input.dashboard.connections.filter(
      (connection) =>
        connection.definitionId === definition.id &&
        connection.status !== "revoked" &&
        connection.computer === null,
    );
    if (!oauth && connections.length === 0) return [];
    return [
      {
        accounts: connections.map((connection) => {
          const repair = integrationAccountRepair(connection, { active: true, definition });
          return {
            id: connection.id,
            repair,
            status: integrationAccountStatus(connection, repair),
            title: integrationAccountTitle(connection),
          };
        }),
        definitionId: definition.id,
        description: definition.description,
        name: definition.name,
        signIn: oauth ? signInFor(input.dashboard, definition, input.hostName) : null,
      },
    ];
  });
  const needsSomeone = (app: ConnectedAppModel) =>
    app.accounts.some(({ status }) => status.tone === "attention");
  return [...apps.filter(needsSomeone), ...apps.filter((app) => !needsSomeone(app))];
}

function signInFor(
  dashboard: IntegrationDashboard,
  definition: {
    readonly name: string;
    readonly provider: IntegrationConnectionSummary["provider"];
  },
  hostName: string,
): ConnectedAppSignIn {
  const provider = definition.provider;
  const availability = connectAvailability(dashboard, provider);
  if (availability.kind === "other-surface") {
    return {
      kind: "elsewhere",
      note: `Signing in to ${definition.name} here returns to ${hostName}, so connect or reconnect accounts there.`,
    };
  }
  if (availability.kind !== "ready") return { detail: availability.detail, kind: "unavailable" };
  const source = initialConnectSource(dashboard, provider);
  return source === null
    ? { kind: "choose", options: connectSignInOptions(dashboard, provider) }
    : { kind: "direct", source };
}
