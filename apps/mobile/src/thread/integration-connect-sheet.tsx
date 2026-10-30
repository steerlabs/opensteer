import {
  requestAgentProposedDetail,
  requestAgentProposedLabel,
  RunnerIdSchema,
  type Request,
} from "@opensteer/core";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import {
  accessPlan,
  apiKeyDisclosure,
  authorizationConnection,
  accessServerChoices,
  accountConnectable,
  canSetUpOwnApp,
  changingOperationCount,
  computerAccessUpgrade,
  computerAppAccessLabel,
  computerAppConnectionLabel,
  computerAppElsewhereDetail,
  computerAppRunsOnPhone,
  computerAppPermissionNotice,
  computerAppSetupElsewhere,
  computerAppStateLabel,
  computerConnectionState,
  connectAvailability,
  connectChoiceAvailable,
  connectOption,
  connectProviderManifest,
  connectRequestedScopes,
  connectSavedSource,
  connectSignInOptions,
  connectedAccount,
  effectiveIntegrationAccess,
  hostedOAuthOutage,
  initialConnectSource,
  grantedIntegrationAccess,
  integrationAccessSummary,
  integrationAccountDetail,
  integrationAuthorizationError,
  isAndroidPhone,
  mainConnectAllowsNote,
  matchingInstallationForManifest,
  repositoryAccountStep,
  requestedAccountUnavailableDetail,
  resolveIntegrationAccess,
  type AccessPlan,
  type ConnectSignInOption,
  type IntegrationAccess,
  type IntegrationConnectionSummary,
  type IntegrationOAuthApplicationSource,
  type IntegrationRepositoryAccess,
  type LoadedAccessRequest,
} from "@opensteer/client/integrations";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import {
  AppText,
  ChoiceRow,
  CodeBlock,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  SwitchRow,
} from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import { ComputerAppPicker, computerAppChoices } from "./computer-app-picker.js";
import { InstallReview } from "./integration-install-review.js";
import { useMobileClient } from "../ui/mobile-client-context.js";

type Step =
  "review" | "apps" | "api-key" | "own-app" | "computer" | "repository-access" | "connected";

const selectHostSnapshot = (snapshot: HostSnapshot): HostSnapshot => snapshot;

/**
 * Connecting an integration account from the phone.
 *
 * The phone runs the same flow the browser does, against the same Host: it
 * shows what the agent asked for, which sign-in app will be used, and — after
 * the system browser returns — the account the Host actually recorded. The
 * browser return is only a wake-up; `MobileClient.beginIntegrationAuthorization`
 * reads the durable attempt with this phone's Host credential, and a Workspace
 * grant is still a separate answer given here.
 */
export function IntegrationConnectSheet(props: {
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  /** The Request was answered; the card's Thread state reloads behind the sheet. */
  readonly onResponded: () => void;
  readonly open: boolean;
  readonly request: Request;
}): ReactNode {
  const mobile = useMobileClient();
  const payload =
    props.request.payload.kind === "integration.access" ? props.request.payload : null;
  const [loaded, setLoaded] = useState<LoadedAccessRequest | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [allowChanges, setAllowChanges] = useState(false);
  const [chosen, setChosen] = useState<IntegrationOAuthApplicationSource | null>(null);
  const [connectedId, setConnectedId] = useState<IntegrationConnectionSummary["id"] | null>(null);
  const [repositoryAccess, setRepositoryAccess] = useState<IntegrationRepositoryAccess | null>(
    null,
  );
  const [apiKeyValues, setApiKeyValues] = useState<Record<string, string>>({});
  const [apiKeyName, setApiKeyName] = useState("");
  const [computerId, setComputerId] = useState<string | null>(null);
  // The safe level is the default, always: the phone never preselects the
  // access that lets an agent act on somebody's behalf.
  const [computerAccess, setComputerAccess] = useState<IntegrationAccess>("read");
  // Every operation takes a new generation, and so does closing the sheet or
  // changing its request; an operation writes only while its own is current.
  const operationGeneration = useRef(0);
  const sourceSelectionSeeded = useRef(false);
  const reconnectStepSeeded = useRef(false);

  useEffect(() => {
    operationGeneration.current += 1;
    if (!props.open) return;
    setLoaded(null);
    setStep("review");
    setBusy(false);
    setError(null);
    setNotice(null);
    setAccountId(null);
    setAllowChanges(false);
    setChosen(null);
    setConnectedId(null);
    setRepositoryAccess(null);
    setApiKeyValues({});
    setApiKeyName("");
    setComputerId(null);
    setComputerAccess("read");
    sourceSelectionSeeded.current = false;
    reconnectStepSeeded.current = false;
    return () => {
      operationGeneration.current += 1;
    };
  }, [props.open, props.request.id]);

  useEffect(() => {
    if (!props.open || payload === null) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ])
      .then(([dashboard, platform]) => {
        if (cancelled) return;
        setLoaded({ dashboard, platform, request: payload });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(describe(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.hostClient, props.open, payload, reload]);

  const snapshot = useHostSelector(props.hostClient, selectHostSnapshot);
  const workspace =
    snapshot.workspaces.find(({ id }) => id === props.request.targetWorkspaceId) ?? null;
  const plan = loaded === null ? null : accessPlan(loaded, accountId);
  const serverChoices = loaded === null ? [] : accessServerChoices(loaded);
  const matchingInstallation =
    loaded === null || payload === null || payload.manifest === null
      ? null
      : matchingInstallationForManifest(loaded.platform, payload.manifest);
  const provider =
    plan?.requirement.kind === "provider" && plan.requirement.providerApplicationRequired
      ? plan.requirement.provider
      : null;
  const availability =
    loaded !== null && provider !== null ? connectAvailability(loaded.dashboard, provider) : null;
  const options =
    loaded !== null && provider !== null ? connectSignInOptions(loaded.dashboard, provider) : [];
  const chosenOption = connectOption(options, chosen);
  const choiceLost = !connectChoiceAvailable(options, chosen);
  const manifest =
    loaded !== null && provider !== null
      ? connectProviderManifest(loaded.dashboard, provider)
      : null;
  const scopes = plan?.definition ? connectRequestedScopes(plan.definition) : [];
  const effectiveAccess =
    plan === null || workspace?.kind !== "specialized"
      ? (plan?.requestedAccess ?? "read")
      : effectiveIntegrationAccess(plan.requestedAccess, allowChanges);
  const grantedAccess =
    plan === null
      ? effectiveAccess
      : grantedIntegrationAccess({
          allowChanges,
          plan,
          workspaceKind: workspace?.kind === "main" ? "main" : "specialized",
        });
  // An app on a computer is turned on here, inline: there is no sign-in to hand
  // off to, so the phone offers it exactly when a computer is reporting the app.
  const computerChoices =
    plan?.requirement.kind === "computer" && plan.definition !== null
      ? computerAppChoices({
          connections: loaded?.dashboard.connections ?? [],
          definition: plan.definition,
          machines: snapshot.machines,
        })
      : null;
  const computerChosen =
    computerId === null
      ? (computerChoices?.available[0] ?? null)
      : (computerChoices?.available.find(({ machine }) => machine.id === computerId) ?? null);
  // Asking for changes through a computer that is only allowed to read is not
  // something a Workspace grant can settle — the tool does not exist yet.
  const computerUpgrade = plan === null ? null : computerAccessUpgrade(plan, effectiveAccess);
  // A Request that names an account is answered by that account or not at
  // all, so the only connection worth making for it is the one that repairs it.
  const reconnect =
    plan !== null && plan.requestedAccountMissing ? plan.requestedAccountReconnect : null;
  const unavailable = plan !== null && plan.requestedAccountMissing && reconnect === null;
  // An MCP server's sign-in returns to the Host's own callback, which only a
  // browser on that computer reaches; the Host refuses to begin one from here.
  const mcpElsewhere =
    plan?.requirement.kind === "mcp-oauth" &&
    loaded?.platform.authorizationSurface === "personal-remote";
  const connectable =
    !mcpElsewhere &&
    plan !== null &&
    accountConnectable(plan) &&
    (plan.requestedConnectionId === null || reconnect !== null) &&
    (provider !== null ||
      plan.apiKeyMethod !== null ||
      plan.requirement.kind === "mcp-oauth" ||
      (plan.requirement.kind === "computer" && (computerChoices?.available.length ?? 0) > 0)) &&
    (provider === null || availability?.kind !== "other-surface");
  // A key reconnects the exact account a Request names: nothing else can say
  // which account an unidentified key belongs to.
  const reconnectedConnectionId = reconnect?.method === "api-key" ? reconnect.account.id : null;
  const close = (): void => {
    operationGeneration.current += 1;
    props.onClose();
  };

  // The Host's own selection is the only preselection, and it is taken once:
  // a later reload never moves the app this person chose for this attempt.
  useEffect(() => {
    if (loaded === null || provider === null || sourceSelectionSeeded.current) return;
    sourceSelectionSeeded.current = true;
    setChosen(initialConnectSource(loaded.dashboard, provider));
  }, [loaded, provider]);

  // A key repair is the key itself, so a Request naming an account that needs
  // a new one opens on the key, under the account's own name, and once only.
  const keyReconnectName =
    connectable && reconnect?.method === "api-key" ? reconnect.account.displayName : null;
  useEffect(() => {
    if (keyReconnectName === null || reconnectStepSeeded.current) return;
    reconnectStepSeeded.current = true;
    setApiKeyName(keyReconnectName);
    setStep("api-key");
  }, [keyReconnectName]);

  const connect = async (): Promise<void> => {
    if (plan === null || plan.definition === null || chosen === null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const status = await mobile.beginIntegrationAuthorization({
        applicationSource: chosen,
        definitionId: plan.definition.id,
      });
      if (operationGeneration.current !== generation) return;
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome !== null) {
        setError(outcome);
        setStep("apps");
        return;
      }
      const dashboard = unwrapRpcResult(await props.hostClient.rpc["integrations.get"]({}));
      if (operationGeneration.current !== generation) return;
      const connection = authorizationConnection(dashboard, status.connectionId);
      if (connection === null) {
        setError(
          `${plan.definition.name} reported success, but no connected account is recorded here. Start the connection again.`,
        );
        setStep("apps");
        return;
      }
      if (connection.provider === "github") {
        setConnectedId(connection.id);
        setRepositoryAccess(null);
        const access = await checkRepositories(connection.id, generation);
        if (access === null || operationGeneration.current !== generation) return;
        if (!access.ready) {
          setRepositoryAccess(access);
          setStep("repository-access");
          return;
        }
      }
      setAccountId(connection.id);
      setConnectedId(connection.id);
      setReload((value) => value + 1);
      setStep("connected");
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
      setStep("apps");
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  /**
   * GitHub's repository check, the first and every recheck. After a refusal
   * the sheet reloads the account and goes where the Host put it
   * (`repositoryAccountStep`), and answers no access to show.
   */
  const checkRepositories = async (
    connectionId: IntegrationConnectionSummary["id"],
    generation: number,
  ): Promise<IntegrationRepositoryAccess | null> => {
    try {
      return unwrapRpcResult(
        await props.hostClient.rpc["integration.repositoryAccess.check"]({ connectionId }),
      );
    } catch (reason) {
      if (operationGeneration.current !== generation) return null;
      // An account that cannot be reloaded keeps its saved sign-in and this step.
      const dashboard = await props.hostClient.rpc["integrations.get"]({})
        .then(unwrapRpcResult)
        .catch(() => null);
      if (operationGeneration.current !== generation) return null;
      if (dashboard !== null) {
        setLoaded((current) => (current === null ? current : { ...current, dashboard }));
      }
      const next = dashboard === null ? null : repositoryAccountStep(dashboard, connectionId);
      if (next?.kind === "connected") {
        setAccountId(connectionId);
        setReload((value) => value + 1);
        setStep("connected");
      } else if (next?.kind === "sign-in") {
        setError(next.detail ?? describe(reason));
        setStep("apps");
      } else {
        setError(describe(reason));
        setStep("repository-access");
      }
      return null;
    }
  };

  const recheckRepositories = async (): Promise<void> => {
    if (connectedId === null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      const access = await checkRepositories(connectedId, generation);
      if (access === null || operationGeneration.current !== generation) return;
      setRepositoryAccess(access);
      if (!access.ready) return;
      setAccountId(connectedId);
      setReload((value) => value + 1);
      setStep("connected");
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const saveOwnApp = async (draft: {
    readonly clientId: string;
    readonly displayName: string;
    readonly installationUrl?: string;
    readonly secrets: Record<string, string>;
  }): Promise<void> => {
    if (manifest === null || provider === null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      const saved = await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-app:${provider}`),
        input: {
          availability: "personal",
          clientId: draft.clientId,
          displayName: draft.displayName,
          expectedRevision: null,
          ...(draft.installationUrl ? { installationUrl: draft.installationUrl } : {}),
          provider,
          secrets: draft.secrets,
        },
        type: "integration.providerApplication.save",
      });
      if (saved.type !== "integration.providerApplication.save") {
        throw new Error("Integration application command mismatch.");
      }
      if (operationGeneration.current !== generation) return;
      const dashboard = unwrapRpcResult(await props.hostClient.rpc["integrations.get"]({}));
      const platform = unwrapRpcResult(await props.hostClient.rpc["integration.platform.get"]({}));
      if (operationGeneration.current !== generation) return;
      if (payload !== null) setLoaded({ dashboard, platform, request: payload });
      // The Host's answer names the row it wrote; two apps can carry the same
      // name and client id, so nothing here matches on what was typed.
      const source = connectSavedSource(dashboard, saved.application);
      if (source !== null) setChosen(source);
      setNotice(
        source === null
          ? "App saved, but this deployment is not offering it for sign-in yet. No account is connected."
          : "App saved. No account is connected yet.",
      );
      setStep("apps");
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    if (payload === null || payload.installationId !== null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}:install`),
        requestId: props.request.id,
        response: { kind: "choice", optionId: "installed" },
        type: "request.respond",
      });
      if (operationGeneration.current !== generation) return;
      setNotice("Installation is ready. Loading the account and access review…");
      setReload((value) => value + 1);
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  /**
   * Turning the app on for one computer, or raising the ceiling of the one it
   * is already on. Both are the same authoritative write, and both leave the
   * request exactly as the agent pinned it: only the connection changes.
   */
  const setComputerApp = async (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }): Promise<void> => {
    if (!plan?.definition) return;
    const definitionId = plan.definition.id;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const command = {
        idempotencyKey: mutationIdempotencyKey(
          `integration-computer:${definitionId}:${input.runnerId}:${input.access}`,
        ),
        input: {
          access: input.access,
          app: null,
          definitionId,
          kind: "app" as const,
          runnerId: RunnerIdSchema.parse(input.runnerId),
        },
      };
      const phone = definitionId === "android-phone";
      if (phone) {
        const result = await props.hostClient.dispatch({
          ...command,
          type: "integration.computer.setup.set",
        });
        if (result.type !== "integration.computer.setup.set")
          throw new Error("Phone access did not change.");
      } else {
        const result = await props.hostClient.dispatch({
          ...command,
          type: "integration.computer.setup.request",
        });
        if (result.type !== "integration.computer.setup.request")
          throw new Error("Integration computer command mismatch.");
      }
      if (operationGeneration.current !== generation) return;
      const computer = snapshot.machines.find((machine) => machine.id === input.runnerId);
      setNotice(
        phone && computer !== undefined && isAndroidPhone(computer)
          ? `Agents can now use ${computer.name} at the access you chose.`
          : `Setup requested. On ${computer?.name ?? "that computer"}, open Opensteer → Settings → Computers to approve ${plan.definition.name}.`,
      );
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const connectApiKey = async (): Promise<void> => {
    if (plan?.apiKeyMethod === null || !plan?.definition) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-key:${plan.definition.id}`),
        input: {
          authMethodId: plan.apiKeyMethod.id,
          ...(reconnectedConnectionId === null ? {} : { connectionId: reconnectedConnectionId }),
          definitionId: plan.definition.id,
          ...(apiKeyName.trim() ? { displayName: apiKeyName.trim() } : {}),
          values: apiKeyValues,
        },
        type: "integration.apiKey.connect",
      });
      if (operationGeneration.current !== generation) return;
      setReload((value) => value + 1);
      setStep("review");
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const connectMcp = async (): Promise<void> => {
    if (plan?.requirement.kind !== "mcp-oauth" || plan.serverId === null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      const status = await mobile.beginMcpIntegrationAuthorization({
        displayName: `${plan.installationTitle} account`,
        requestId: props.request.id,
        serverId: plan.serverId,
      });
      if (operationGeneration.current !== generation) return;
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome !== null) {
        setError(outcome);
        return;
      }
      if (status.connectionId === null) {
        setError(
          "Authorization finished without recording an account. Start the connection again.",
        );
        return;
      }
      setAccountId(status.connectionId);
      setReload((value) => value + 1);
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const chooseServer = async (serverId: string): Promise<void> => {
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}:server:${serverId}`),
        requestId: props.request.id,
        response: { kind: "choice", optionId: `server:${serverId}` },
        type: "request.respond",
      });
      if (operationGeneration.current !== generation) return;
      setNotice("Server selected. Loading its account and access review…");
      setReload((value) => value + 1);
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const decline = async (): Promise<void> => {
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}`),
        requestId: props.request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
      if (operationGeneration.current !== generation) return;
      props.onResponded();
      close();
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  const allow = async (): Promise<void> => {
    if (plan === null || workspace === null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    setBusy(true);
    setError(null);
    try {
      await resolveIntegrationAccess(props.hostClient, {
        access: effectiveAccess,
        accountsCount: plan.accounts.length,
        installationTitle: plan.installationTitle,
        requestId: props.request.id,
        selectedAccount: plan.selectedAccount,
        targetKind: workspace.kind,
      });
      if (operationGeneration.current !== generation) return;
      props.onResponded();
      close();
    } catch (reason) {
      if (operationGeneration.current !== generation) return;
      setError(describe(reason));
    } finally {
      if (operationGeneration.current === generation) setBusy(false);
    }
  };

  // Main uses every account its owner connects, so connecting answers a
  // request for Main at once. Every stage that connects says so beside its
  // action, a key repair that opens straight on its key included.
  const connectNote =
    workspace?.kind === "main" &&
    connectable &&
    plan?.requirement.kind !== "computer" &&
    ((step === "review" && payload?.installationId !== null && serverChoices.length === 0) ||
      (step === "apps" && options.length > 0) ||
      step === "api-key")
      ? mainConnectAllowsNote(workspace.name)
      : null;

  const title =
    payload?.installationId === null
      ? "Install integration"
      : serverChoices.length > 0
        ? "Choose server"
        : step === "own-app"
          ? "Your own app"
          : step === "computer"
            ? "Choose a computer"
            : step === "api-key"
              ? reconnect === null
                ? "Connect API key"
                : `Reconnect ${plan?.integrationName ?? "account"}`
              : step === "repository-access"
                ? "Choose GitHub repositories"
                : step === "connected"
                  ? "Account connected"
                  : plan === null
                    ? "Connect account"
                    : reconnect === null
                      ? `Connect ${plan.integrationName}`
                      : `Reconnect ${plan.integrationName}`;

  return (
    <Sheet
      footer={
        <View style={styles.footer}>
          {connectNote === null ? null : (
            <AppText role="secondary" tone="muted">
              {connectNote}
            </AppText>
          )}
          {step === "review" ? (
            <>
              {serverChoices.length > 0 ? (
                serverChoices.map((server) => (
                  <PrimaryButton
                    busy={busy}
                    key={server.id}
                    label={`Continue with ${server.name}`}
                    onPress={() => void chooseServer(server.id)}
                  />
                ))
              ) : payload?.installationId === null ? (
                loaded !== null &&
                (loaded.dashboard.isAdministrator || matchingInstallation !== null) ? (
                  <PrimaryButton
                    busy={busy}
                    label={matchingInstallation ? "Continue" : "Install and continue"}
                    onPress={() => void install()}
                  />
                ) : null
              ) : connectable ? (
                <SecondaryButton
                  busy={busy}
                  label={
                    reconnect !== null
                      ? "Reconnect account"
                      : // An app on a computer is turned on for a computer, never
                        // signed in to, so the action says which move it is.
                        plan?.requirement.kind === "computer"
                        ? plan.accounts.length > 0
                          ? "Use another computer"
                          : "Choose a computer"
                        : plan && plan.accounts.length > 0
                          ? "Connect another account"
                          : "Connect account"
                  }
                  onPress={() => {
                    setError(null);
                    if (plan?.requirement.kind === "mcp-oauth") void connectMcp();
                    else if (plan?.requirement.kind === "computer") setStep("computer");
                    else {
                      if (reconnect?.method === "api-key")
                        setApiKeyName(reconnect.account.displayName);
                      setStep(plan?.apiKeyMethod ? "api-key" : "apps");
                    }
                  }}
                />
              ) : null}
              {unavailable ? (
                <SecondaryButton
                  busy={busy}
                  label="Decline request"
                  onPress={() => void decline()}
                />
              ) : null}
              {computerUpgrade === null ? null : (
                <SecondaryButton
                  busy={busy}
                  label={`Request sending access on ${computerUpgrade.displayName}`}
                  onPress={() =>
                    void setComputerApp({
                      access: "read-write",
                      runnerId: computerUpgrade.runnerId,
                    })
                  }
                />
              )}
              {plan !== null &&
              !plan.requestedAccountMissing &&
              // Approving would grant an access the connection cannot carry, so
              // the ceiling is raised first, deliberately, or not at all.
              computerUpgrade === null &&
              (plan.requirement.kind === "none" || plan.selectedAccount !== null) &&
              workspace !== null ? (
                <PrimaryButton
                  busy={busy}
                  label={
                    workspace.kind === "main" ? "Use this account" : `Allow in ${workspace.name}`
                  }
                  onPress={() => void allow()}
                />
              ) : null}
            </>
          ) : null}
          {step === "apps" ? (
            <>
              {manifest !== null &&
              loaded !== null &&
              provider !== null &&
              canSetUpOwnApp(loaded.dashboard, provider) ? (
                <SecondaryButton
                  busy={busy}
                  label={
                    options.length > 0
                      ? `Use my own ${plan?.integrationName ?? ""} app`.trim()
                      : `Set up my own ${plan?.integrationName ?? ""} app`.trim()
                  }
                  onPress={() => {
                    setError(null);
                    setNotice(null);
                    setStep("own-app");
                  }}
                />
              ) : null}
              {options.length > 0 ? (
                <PrimaryButton
                  busy={busy}
                  disabled={chosenOption === null || choiceLost}
                  label="Continue in browser"
                  onPress={() => void connect()}
                />
              ) : null}
            </>
          ) : null}
          {step === "computer" ? (
            <>
              <SecondaryButton
                busy={busy}
                label="Back to the request"
                onPress={() => {
                  setError(null);
                  setStep("review");
                }}
              />
              {computerChosen === null ? null : (
                <PrimaryButton
                  busy={busy}
                  label={`Request setup on ${computerChosen.machine.name}`}
                  onPress={() =>
                    void setComputerApp({
                      access: computerAccess,
                      runnerId: computerChosen.machine.id,
                    })
                  }
                />
              )}
            </>
          ) : null}
          {step === "connected" ? (
            <PrimaryButton
              label="Back to the request"
              onPress={() => {
                setNotice(null);
                setStep("review");
              }}
            />
          ) : null}
          {step === "repository-access" ? (
            <>
              <SecondaryButton busy={busy} label="Finish later" onPress={close} />
              <PrimaryButton
                busy={busy}
                label="Recheck repository access"
                onPress={() => void recheckRepositories()}
              />
            </>
          ) : null}
          {step === "api-key" && plan?.apiKeyMethod ? (
            <PrimaryButton
              busy={busy}
              disabled={plan.apiKeyMethod.inputs.some(
                ({ variable }) => !(apiKeyValues[variable] ?? "").trim(),
              )}
              label={reconnect === null ? "Connect account" : "Reconnect account"}
              onPress={() => void connectApiKey()}
            />
          ) : null}
        </View>
      }
      onClose={close}
      open={props.open}
      title={title}
    >
      <View style={styles.body}>
        {error === null ? null : (
          <Notice detail={error} title="This connection did not finish" tone="danger" />
        )}
        {notice === null ? null : <Notice detail={notice} title="Saved" tone="neutral" />}

        {payload === null ? (
          <Notice
            detail="Ask the agent to request the integration again."
            title="This request is not an integration request"
            tone="danger"
          />
        ) : payload.installationId === null ? (
          <InstallReview
            canInstall={loaded?.dashboard.isAdministrator ?? false}
            continuesToAccess
            installedTitle={matchingInstallation?.installation.title ?? null}
            manifest={payload.manifest}
          />
        ) : serverChoices.length > 0 ? (
          <>
            <AppText role="body">
              Choose the {serverChoices[0]!.installationTitle} server this request should use.
            </AppText>
            <AppText role="secondary" tone="muted">
              The account and operations shown next come only from that server.
            </AppText>
          </>
        ) : plan === null ? (
          <AppText role="secondary" tone="muted">
            Checking this deployment…
          </AppText>
        ) : step === "review" ? (
          <ReviewStep
            access={grantedAccess}
            connections={loaded?.dashboard.connections ?? []}
            allowChanges={allowChanges}
            computerAvailable={(computerChoices?.available.length ?? 0) > 0}
            computerUpgrade={computerUpgrade}
            availabilityDetail={
              mcpElsewhere
                ? mcpSignInElsewhere
                : availability !== undefined &&
                    availability !== null &&
                    availability.kind !== "ready"
                  ? availability.detail
                  : null
            }
            agentProposed={props.request.presentation.agentProposed === true}
            onAccount={setAccountId}
            onAllowChanges={setAllowChanges}
            plan={plan}
            reconnect={reconnect}
            machines={snapshot.machines}
            scopes={scopes}
            supportedConnect={connectable}
            workspaceKind={workspace?.kind ?? null}
            workspaceName={workspace?.name ?? null}
          />
        ) : step === "apps" ? (
          <AppsStep
            choiceLost={choiceLost}
            chosen={chosen}
            hostedOutage={
              loaded !== null && provider !== null && hostedOAuthOutage(loaded.dashboard, provider)
            }
            onChoose={setChosen}
            options={options}
            unavailable={
              availability !== null && availability.kind !== "ready" ? availability.detail : null
            }
          />
        ) : step === "own-app" && manifest !== null && loaded !== null && provider !== null ? (
          <OwnAppStep
            busy={busy}
            callbackUrl={loaded.dashboard.callbackUrls[provider] ?? ""}
            manifest={manifest}
            onSave={(draft) => void saveOwnApp(draft)}
          />
        ) : step === "api-key" && plan.apiKeyMethod && plan.definition ? (
          <>
            {props.request.presentation.agentProposed === true ? <AgentProposedCaption /> : null}
            {reconnect === null ? null : (
              <ReconnectAccount accounts={plan.accounts} reconnect={reconnect} />
            )}
            <ApiKeyStep
              definition={plan.definition}
              proposed={plan.proposed}
              displayName={apiKeyName}
              method={plan.apiKeyMethod}
              onDisplayName={setApiKeyName}
              onValue={(variable, value) =>
                setApiKeyValues((current) => ({ ...current, [variable]: value }))
              }
              values={apiKeyValues}
            />
          </>
        ) : step === "computer" && plan.definition !== null && computerChoices !== null ? (
          <ComputerAppPicker
            access={computerAccess}
            busy={busy}
            chosenId={computerChosen?.machine.id ?? null}
            definition={plan.definition}
            onAccess={setComputerAccess}
            onChoose={setComputerId}
            targets={computerChoices}
          />
        ) : step === "connected" ? (
          <ConnectedStep
            connection={loaded !== null ? connectedAccount(loaded.dashboard, connectedId) : null}
            name={plan.integrationName}
          />
        ) : step === "repository-access" ? (
          <RepositoryAccessStep access={repositoryAccess} />
        ) : null}
      </View>
    </Sheet>
  );
}

function ApiKeyStep(props: {
  readonly definition: NonNullable<AccessPlan["definition"]>;
  readonly proposed: boolean;
  readonly displayName: string;
  readonly method: NonNullable<AccessPlan["apiKeyMethod"]>;
  readonly onDisplayName: (value: string) => void;
  readonly onValue: (variable: string, value: string) => void;
  readonly values: Readonly<Record<string, string>>;
}): ReactNode {
  const disclosure = apiKeyDisclosure(props.definition);
  if (disclosure === null) return null;
  return (
    <>
      {disclosure.setupUrl ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(disclosure.setupUrl!)}
        >
          <AppText role="secondary">
            {disclosure.setupInstruction.prefix}
            {new URL(disclosure.setupUrl).host}
            {disclosure.setupInstruction.suffix}
          </AppText>
        </Pressable>
      ) : (
        <AppText role="secondary">
          {disclosure.setupInstruction.prefix}
          {disclosure.setupInstruction.suffix}
        </AppText>
      )}
      {props.method.inputs.map((input) => (
        <Field
          key={input.variable}
          label={input.label}
          {...(input.description
            ? { hint: `${props.proposed ? "From the agent’s proposal: " : ""}${input.description}` }
            : {})}
          hintPosition="before"
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: (value: string) => props.onValue(input.variable, value),
            secureTextEntry: input.secret,
            value: props.values[input.variable] ?? "",
          }}
        />
      ))}
      <Field
        input={{ onChangeText: props.onDisplayName, value: props.displayName }}
        label="Account label (optional)"
      />
      <AppText role="secondary" tone="muted">
        {disclosure.custody}
      </AppText>
      <AppText role="secondary" tone="muted">
        {disclosure.check}
      </AppText>
    </>
  );
}

/** Said under the integration a Request asks about whenever an agent proposed it. */
function AgentProposedCaption(): ReactNode {
  return (
    <AppText accessibilityHint={requestAgentProposedDetail} role="caption" tone="muted">
      {requestAgentProposedLabel}
    </AppText>
  );
}

/**
 * The account a Request names, when it needs reconnecting: which one it is,
 * and why, as the Host recorded it.
 */
function ReconnectAccount(props: {
  readonly accounts: AccessPlan["accounts"];
  readonly reconnect: NonNullable<AccessPlan["requestedAccountReconnect"]>;
}): ReactNode {
  const { account, statusDetail } = props.reconnect;
  return (
    <>
      <SectionLabel>Account</SectionLabel>
      <RowGroup>
        <View style={styles.fact}>
          <AppText role="body">{account.displayName}</AppText>
          <AppText role="secondary" tone="muted">
            {`${integrationAccountDetail(account, [account, ...props.accounts])} · Needs attention`}
          </AppText>
        </View>
        {statusDetail === null ? null : (
          <View style={styles.fact}>
            <AppText role="secondary" tone="muted">
              {statusDetail}
            </AppText>
          </View>
        )}
      </RowGroup>
    </>
  );
}

function ReviewStep(props: {
  readonly access: "read" | "read-write";
  readonly agentProposed: boolean;
  readonly allowChanges: boolean;
  readonly availabilityDetail: string | null;
  readonly connections: LoadedAccessRequest["dashboard"]["connections"];
  /** Whether a computer is reporting this app and has it turned off. */
  readonly computerAvailable: boolean;
  readonly computerUpgrade: ReturnType<typeof computerAccessUpgrade>;
  readonly onAccount: (connectionId: string) => void;
  readonly onAllowChanges: (value: boolean) => void;
  readonly machines: HostSnapshot["machines"];
  readonly plan: NonNullable<ReturnType<typeof accessPlan>>;
  readonly reconnect: AccessPlan["requestedAccountReconnect"];
  readonly scopes: readonly string[];
  readonly supportedConnect: boolean;
  readonly workspaceKind: "main" | "specialized" | null;
  readonly workspaceName: string | null;
}): ReactNode {
  const { plan } = props;
  const operations = plan.readCount + plan.writeCount;
  const accounts =
    plan.requestedConnectionId === null
      ? plan.accounts
      : plan.accounts.filter(({ id }) => id === plan.requestedConnectionId);
  const requestDescription =
    operations === 0
      ? `${plan.installationTitle} is asking for access${
          props.workspaceName === null ? "" : ` in ${props.workspaceName}`
        }.`
      : `${plan.installationTitle} is asking to use a ${plan.integrationName} account${
          props.workspaceName === null ? "" : ` in ${props.workspaceName}`
        }.`;
  const selectedComputerConnection =
    plan.selectedAccount?.computer === null || plan.selectedAccount?.computer === undefined
      ? null
      : (props.connections.find(({ id }) => id === plan.selectedAccount?.id) ?? null);
  const selectedComputerMachine =
    selectedComputerConnection?.computer === null ||
    selectedComputerConnection?.computer === undefined
      ? null
      : (props.machines.find(({ id }) => id === selectedComputerConnection.computer?.runnerId) ??
        null);
  const selectedComputerState =
    selectedComputerConnection === null || plan.definition === null
      ? null
      : computerConnectionState({
          connection: selectedComputerConnection,
          definition: plan.definition,
          machines: props.machines,
        });
  const selectedComputerPermission =
    selectedComputerState === null || plan.definition === null || selectedComputerMachine === null
      ? null
      : computerAppPermissionNotice({
          appName: plan.definition.name,
          machineName: selectedComputerMachine.name,
          platform: selectedComputerMachine.device?.platform,
          state: selectedComputerState,
        });
  return (
    <>
      {plan.definition === null ? (
        <AppText role="body">{requestDescription}</AppText>
      ) : (
        <View style={styles.integrationHeading}>
          <IntegrationIcon definitionId={plan.definition.id} name={plan.definition.name} />
          <AppText role="body" style={styles.integrationHeadingText}>
            {requestDescription}
          </AppText>
        </View>
      )}
      {props.agentProposed ? <AgentProposedCaption /> : null}
      {operations === 0 ? null : (
        <AppText role="secondary" tone="muted">
          {integrationAccessSummary(plan, props.access)}
        </AppText>
      )}
      {props.scopes.length === 0 ? null : (
        <>
          <SectionLabel>Permissions requested at the provider</SectionLabel>
          <AppText role="secondary" tone="muted">
            {props.scopes.join(", ")}
          </AppText>
        </>
      )}
      {plan.requirement.kind === "none" ? null : props.reconnect !== null ? (
        <ReconnectAccount accounts={plan.accounts} reconnect={props.reconnect} />
      ) : plan.requestedAccountMissing ? (
        <Notice
          detail={requestedAccountUnavailableDetail}
          title="Account no longer available"
          tone="neutral"
        />
      ) : plan.accounts.length === 0 ? (
        plan.requirement.kind === "computer" ? (
          props.computerAvailable ? (
            <Notice
              detail={
                computerAppRunsOnPhone(plan.definition?.computerApp)
                  ? "Agents see and operate the whole screen of the phone you choose. You set their access here."
                  : `${plan.integrationName} runs on the computer you choose. Agents reach it through Opensteer, and nothing else on that computer is opened.`
              }
              title="Choose a computer"
              tone="neutral"
            />
          ) : (
            <Notice
              detail={computerAppElsewhereDetail({
                integrationName: plan.integrationName,
                presentation: plan.definition?.computerApp,
              })}
              title={`No computer is offering ${plan.integrationName} yet`}
              tone="neutral"
            />
          )
        ) : (
          <Notice
            detail={
              props.supportedConnect
                ? "Connect one below. Installing this integration connected nothing."
                : "Connect this account on a computer, then return here to allow access."
            }
            title="No account is connected yet"
            tone="neutral"
          />
        )
      ) : (
        <>
          <SectionLabel>
            {plan.requirement.kind === "computer" ? "Computer" : "Account"}
          </SectionLabel>
          <RowGroup>
            {accounts.map((account) => {
              const pinned = plan.requestedConnectionId !== null;
              const connection = props.connections.find(({ id }) => id === account.id) ?? null;
              const accountName =
                connection?.computer && plan.definition
                  ? computerAppConnectionLabel({
                      connection,
                      definition: plan.definition,
                      machines: props.machines,
                    })
                  : account.displayName;
              const computerState =
                connection?.computer && plan.definition
                  ? computerConnectionState({
                      connection,
                      definition: plan.definition,
                      machines: props.machines,
                    })
                  : null;
              const computerPlatform = props.machines.find(
                ({ id }) => id === connection?.computer?.runnerId,
              )?.device?.platform;
              const accountDetail =
                connection?.computer && plan.definition?.computerApp && computerState
                  ? `${computerAppAccessLabel(
                      plan.definition.computerApp,
                      connection.computer.access,
                    )} · ${computerAppStateLabel(computerState, computerPlatform)}`
                  : integrationAccountDetail(account, plan.accounts);
              return pinned || accounts.length === 1 ? (
                <View key={account.id} style={styles.fact}>
                  <AppText role="body">{accountName}</AppText>
                  <AppText role="secondary" tone="muted">
                    {pinned
                      ? `${accountDetail} · Requested ${connection?.computer ? "computer" : "account"}`
                      : accountDetail}
                  </AppText>
                </View>
              ) : (
                <ChoiceRow
                  description={
                    account.id === plan.selectedAccount?.id
                      ? `${accountDetail} · chosen`
                      : accountDetail
                  }
                  key={account.id}
                  onPress={() => props.onAccount(account.id)}
                  title={accountName}
                />
              );
            })}
          </RowGroup>
        </>
      )}
      {selectedComputerPermission === null || selectedComputerMachine === null ? null : (
        <Notice
          detail={`${selectedComputerPermission.detail} ${computerAppSetupElsewhere(
            selectedComputerMachine.name,
          )}`}
          title={selectedComputerPermission.title}
          tone="neutral"
        />
      )}
      {props.computerUpgrade === null ? null : (
        <Notice
          detail={`${plan.integrationName} on ${props.computerUpgrade.displayName} is ${
            plan.definition?.computerApp?.accessLabels.read ?? "read only"
          }. Choose ${
            plan.definition?.computerApp?.accessLabels.readWrite ?? "read and write"
          } before allowing changes in this Workspace; the request itself does not change.`}
          title="Allow changes on this computer"
          tone="neutral"
        />
      )}
      {props.workspaceKind === "specialized" &&
      plan.requestedAccess === "read" &&
      (plan.writeCount > 0 || plan.definition?.computerApp?.accessLevels.length === 2) ? (
        <SwitchRow
          label={
            plan.definition?.computerApp
              ? `Allow changes (${plan.definition.computerApp.accessLabels.readWrite})`
              : `Allow changes (${changingOperationCount(plan.writeCount)})`
          }
          onChange={props.onAllowChanges}
          value={props.allowChanges}
        />
      ) : null}
      {props.workspaceKind === "specialized" && plan.requestedAccess === "read-write" ? (
        <AppText role="secondary" tone="muted">
          {plan.writeCount > 0
            ? `This task requires read-write access, including ${changingOperationCount(plan.writeCount)}.`
            : "This task requires read-write access. It allows changes when operations become available."}
        </AppText>
      ) : null}
      {props.availabilityDetail === null ? null : (
        <AppText role="secondary" tone="muted">
          {props.availabilityDetail}
        </AppText>
      )}
    </>
  );
}

function AppsStep(props: {
  readonly choiceLost: boolean;
  readonly chosen: IntegrationOAuthApplicationSource | null;
  readonly hostedOutage: boolean;
  readonly onChoose: (source: IntegrationOAuthApplicationSource) => void;
  readonly options: readonly ConnectSignInOption[];
  readonly unavailable: string | null;
}): ReactNode {
  return (
    <>
      {props.hostedOutage ? (
        <Notice
          detail="This is an outage, not missing setup. Try again in a moment, or continue with another app."
          title="Opensteer sign-in is temporarily unavailable"
          tone="neutral"
        />
      ) : null}
      {props.choiceLost ? (
        <Notice
          detail="Choose a sign-in app below. Opensteer never switches it for you."
          title="The app you chose is no longer offered"
          tone="danger"
        />
      ) : null}
      {props.options.length === 0 ? (
        <Notice
          detail={props.unavailable ?? "This deployment has no sign-in app for this service yet."}
          title="No sign-in app is ready yet"
          tone="neutral"
        />
      ) : (
        <>
          <SectionLabel>Sign-in app</SectionLabel>
          <RowGroup>
            {props.options.map((option) => (
              <ChoiceRow
                description={
                  sameSource(option.source, props.chosen)
                    ? `${option.detail} · chosen`
                    : option.detail
                }
                key={optionKey(option)}
                onPress={() => props.onChoose(option.source)}
                title={option.label}
              />
            ))}
          </RowGroup>
          <AppText role="caption" tone="muted">
            Opensteer opens the provider in a browser and waits for this deployment to record the
            result. Closing that browser connects nothing.
          </AppText>
        </>
      )}
    </>
  );
}

function OwnAppStep(props: {
  readonly busy: boolean;
  readonly callbackUrl: string;
  readonly manifest: NonNullable<ReturnType<typeof connectProviderManifest>>;
  readonly onSave: (draft: {
    readonly clientId: string;
    readonly displayName: string;
    readonly installationUrl?: string;
    readonly secrets: Record<string, string>;
  }) => void;
}): ReactNode {
  const [displayName, setDisplayName] = useState(props.manifest.label);
  const [clientId, setClientId] = useState("");
  const [installationUrl, setInstallationUrl] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const complete =
    displayName.trim() !== "" &&
    clientId.trim() !== "" &&
    (!props.manifest.installationUrlRequired || installationUrl.trim() !== "") &&
    props.manifest.secretFields.every((field) => (secrets[field] ?? "") !== "");
  return (
    <>
      <AppText role="secondary" tone="soft">
        Create a {props.manifest.setupLabel} at {props.manifest.setupUrl}, then paste its
        credentials here. Saving the app does not connect an account, and only you can sign in with
        it.
      </AppText>
      {props.manifest.setupSteps.map((setupStep) => (
        <AppText key={setupStep} role="secondary" tone="muted">
          {setupStep}
        </AppText>
      ))}
      <CodeBlock label="Authorized callback URL" text={props.callbackUrl} />
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          onChangeText: setDisplayName,
          value: displayName,
        }}
        label="App name"
      />
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          onChangeText: setClientId,
          value: clientId,
        }}
        label="Client ID"
      />
      {props.manifest.installationUrlRequired ? (
        <Field
          hint="Opensteer uses this exact URL after sign-in so people can choose repositories."
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: setInstallationUrl,
            value: installationUrl,
          }}
          label="GitHub App installation URL"
        />
      ) : null}
      {props.manifest.secretFields.map((field) => (
        <Field
          hint="Encrypted before storage and never shown again."
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: (value: string) =>
              setSecrets((current) => ({ ...current, [field]: value })),
            secureTextEntry: true,
            value: secrets[field] ?? "",
          }}
          key={field}
          label={secretLabel(field)}
        />
      ))}
      <PrimaryButton
        busy={props.busy}
        disabled={!complete}
        label="Save app"
        onPress={() =>
          props.onSave({
            clientId: clientId.trim(),
            displayName: displayName.trim(),
            ...(props.manifest.installationUrlRequired
              ? { installationUrl: installationUrl.trim() }
              : {}),
            secrets,
          })
        }
      />
    </>
  );
}

const mcpSignInElsewhere =
  "This sign-in returns to the computer running Opensteer, so finish it there.";

function RepositoryAccessStep({
  access,
}: {
  readonly access: IntegrationRepositoryAccess | null;
}): ReactNode {
  if (access === null) {
    return (
      <Notice
        detail="Your GitHub sign-in is saved. Recheck instead of signing in again."
        title="Repository access could not be checked"
        tone="neutral"
      />
    );
  }
  return (
    <>
      <Notice
        detail="Install the GitHub App or choose at least one repository, then recheck."
        title="Repository access is still required"
        tone="neutral"
      />
      {access.installationUrl ? (
        <PrimaryButton
          label="Install GitHub App"
          onPress={() => void Linking.openURL(access.installationUrl!)}
        />
      ) : access.installations.length === 0 ? (
        <AppText role="secondary" tone="muted">
          No installation link is configured for this sign-in app. Edit your own app registration,
          or ask an administrator to configure its installation URL.
        </AppText>
      ) : null}
      <RowGroup>
        {access.installations.map((installation) => (
          <ChoiceRow
            description={
              installation.suspended
                ? "Installation suspended"
                : installation.repositorySelection === "all"
                  ? `${installation.repositoryCount} repositories · all repositories`
                  : `${installation.repositoryCount} selected repositories`
            }
            key={installation.id}
            onPress={() => void Linking.openURL(installation.configureUrl)}
            title={`${installation.accountLogin} · Choose/change repositories`}
          />
        ))}
      </RowGroup>
    </>
  );
}

function ConnectedStep(props: {
  readonly connection: ReturnType<typeof connectedAccount>;
  readonly name: string;
}): ReactNode {
  if (props.connection === null) {
    return (
      <Notice
        detail="Open this request again to see the account this deployment recorded."
        title="The connection is not readable here"
        tone="danger"
      />
    );
  }
  return (
    <>
      <AppText role="body">
        {props.name} is connected as {props.connection.displayName}.
      </AppText>
      <RowGroup>
        <View style={styles.fact}>
          <AppText role="secondary" tone="muted">
            Account
          </AppText>
          <AppText role="body">
            {props.connection.accountIdentifier ?? props.connection.displayName}
          </AppText>
        </View>
        {props.connection.externalTenantId === null ? null : (
          <View style={styles.fact}>
            <AppText role="secondary" tone="muted">
              {props.name} workspace
            </AppText>
            <AppText role="body">{props.connection.externalTenantId}</AppText>
          </View>
        )}
      </RowGroup>
      <AppText role="secondary" tone="muted">
        Nothing can use it until you answer the request behind this sheet.
      </AppText>
    </>
  );
}

function optionKey(option: ConnectSignInOption): string {
  return option.source.kind === "hosted-oauth"
    ? `hosted:${option.source.brokerIssuer}`
    : `app:${option.source.providerApplicationId}`;
}

function sameSource(
  left: IntegrationOAuthApplicationSource,
  right: IntegrationOAuthApplicationSource | null,
): boolean {
  if (right === null || left.kind !== right.kind) return false;
  return left.kind === "hosted-oauth"
    ? left.brokerIssuer === (right as typeof left).brokerIssuer
    : left.providerApplicationId === (right as typeof left).providerApplicationId;
}

/** Turns `clientSecret` into the label a provider console uses. */
function secretLabel(field: string): string {
  return field
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "This deployment could not be reached.";
}

const styles = StyleSheet.create({
  body: { gap: space[16], paddingHorizontal: space[16], paddingTop: space[8] },
  fact: { gap: space[2], paddingHorizontal: space[14], paddingVertical: space[12] },
  footer: { backgroundColor: color.surface, gap: space[8] },
  integrationHeading: { alignItems: "center", flexDirection: "row", gap: space[10] },
  integrationHeadingText: { flex: 1 },
});
