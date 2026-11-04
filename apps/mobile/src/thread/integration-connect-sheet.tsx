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
  computerAccessUpgrade,
  computerAppPermissionNotice,
  computerAppSetupElsewhere,
  computerConnectionState,
  connectCard,
  integrationAccountDetail,
  integrationAuthorizationError,
  integrationRequestStillPending,
  isAndroidPhone,
  repositoryAccountStep,
  resolveIntegrationAccess,
  type AccessPlan,
  type AccessRequestAccount,
  type IntegrationAccess,
  type IntegrationConnectionSummary,
  type IntegrationRepositoryAccess,
  type LoadedAccessRequest,
} from "@opensteer/client/integrations";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import {
  AppText,
  ChoiceRow,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SwitchRow,
} from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import { ComputerAppPicker, computerAppChoices } from "./computer-app-picker.js";
import { InstallReview } from "./integration-install-review.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";

type Step = "review" | "api-key" | "computer" | "repository-access" | "server";
type CardHostState = Pick<HostSnapshot, "deploymentId" | "machines" | "workspaceWindow"> & {
  readonly workspace: HostSnapshot["workspaces"][number] | null;
};
const sameCardHostState = (a: CardHostState, b: CardHostState) =>
  a.deploymentId === b.deploymentId &&
  a.machines === b.machines &&
  a.workspace === b.workspace &&
  a.workspaceWindow.hasMore === b.workspaceWindow.hasMore &&
  a.workspaceWindow.itemCount === b.workspaceWindow.itemCount;

/** The Request stays inline. Only credential entry and device setup need a sheet. */
export function IntegrationConnectCard(props: {
  readonly hostClient: HostClient;
  readonly request: Request;
  readonly disabled?: boolean;
  readonly disabledReason?: string | null;
  readonly canStartResponse?: () => boolean;
  readonly mutationGate?: ThreadMutationGate;
  readonly onResponded: () => void;
  readonly onPresent?: () => void;
  readonly onClose?: () => void;
}): ReactNode {
  const mobile = useMobileClient();
  const navigation = useNavigation();
  const payload =
    props.request.payload.kind === "integration.access" ? props.request.payload : null;
  const [loaded, setLoaded] = useState<LoadedAccessRequest | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [allowChanges, setAllowChanges] = useState(false);
  const [connected, setConnected] = useState<AccessRequestAccount | null>(null);
  const [connectedId, setConnectedId] = useState<IntegrationConnectionSummary["id"] | null>(null);
  const [repositoryAccess, setRepositoryAccess] = useState<IntegrationRepositoryAccess | null>(
    null,
  );
  const [apiKeyValues, setApiKeyValues] = useState<Record<string, string>>({});
  const [apiKeyName, setApiKeyName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [computerId, setComputerId] = useState<string | null>(null);
  const [computerAccess, setComputerAccess] = useState<IntegrationAccess>("read");
  const [disclosed, setDisclosed] = useState(false);
  const operationGeneration = useRef(0);
  const responding = useRef(false);
  const presented = useRef(false);
  /**
   * The last thing the person asked the card to do. Try again repeats exactly
   * that: a failed sign-in for another account must never become approval of
   * the account already selected.
   */
  const lastAction = useRef<"allow" | "connect" | null>(null);
  const selectCardHostState = useMemo(
    () =>
      (snapshot: HostSnapshot): CardHostState => ({
        deploymentId: snapshot.deploymentId,
        machines: snapshot.machines,
        workspaceWindow: snapshot.workspaceWindow,
        workspace:
          snapshot.workspaces.find(({ id }) => id === props.request.targetWorkspaceId) ?? null,
      }),
    [props.request.targetWorkspaceId],
  );
  const snapshot = useHostSelector(props.hostClient, selectCardHostState, sameCardHostState);
  const { workspace } = snapshot;
  const plan = useMemo(
    () => (loaded === null ? null : accessPlan(loaded, accountId)),
    [loaded, accountId],
  );
  const card = useMemo(
    () =>
      loaded && workspace
        ? connectCard({
            loaded,
            workspace,
            selectedAccountId: accountId,
            allowChanges,
            agentProposed: props.request.presentation.agentProposed === true,
            connecting,
            error,
            connectedAccount: connected,
            answered: props.request.status !== "pending",
            repositories: step === "repository-access",
          })
        : null,
    [
      loaded,
      workspace,
      accountId,
      allowChanges,
      props.request.presentation.agentProposed,
      props.request.status,
      connecting,
      error,
      connected,
      step,
    ],
  );
  const computerChoices =
    plan?.requirement.kind === "computer" && plan.definition
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
  const reconnect = card?.reconnect ?? null;
  const effectiveAccess = card?.effectiveAccess ?? "read";
  const computerUpgrade = card?.upgrade ?? null;

  useEffect(() => {
    setLoaded(null);
    setStep("review");
    setBusy(false);
    setConnecting(false);
    setError(null);
    setNotice(null);
    setAccountId(null);
    setAllowChanges(false);
    setConnected(null);
    setConnectedId(null);
    setRepositoryAccess(null);
    setApiKeyValues({});
    setApiKeyName("");
    setComputerId(null);
    setComputerAccess("read");
    return () => {
      operationGeneration.current += 1;
      if (presented.current) props.onClose?.();
    };
  }, [props.hostClient, props.request.id]);
  useEffect(() => {
    if (!payload || workspace || !snapshot.workspaceWindow.hasMore) return;
    let cancelled = false;
    void props.hostClient.loadEarlierWorkspaces().catch((reason: unknown) => {
      if (!cancelled) setError(describe(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [
    props.hostClient,
    payload,
    workspace,
    snapshot.workspaceWindow.hasMore,
    snapshot.workspaceWindow.itemCount,
    reload,
  ]);
  useEffect(() => {
    if (!payload) return;
    let cancelled = false;
    Promise.all([
      props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ])
      .then(([dashboard, platform]) => {
        if (!cancelled)
          setLoaded((current) => ({
            dashboard,
            platform,
            request:
              current &&
              ((payload.installationId === null && current.request.installationId !== null) ||
                (payload.requestedServerId === null && current.request.requestedServerId !== null))
                ? current.request
                : payload,
          }));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(describe(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.hostClient, payload, reload]);

  const showForm = (next: Step): void => {
    setStep(next);
    if (!presented.current) {
      presented.current = true;
      props.onPresent?.();
    }
  };
  const close = (): void => {
    operationGeneration.current += 1;
    setBusy(false);
    setStep("review");
    setApiKeyValues({});
    if (presented.current) {
      presented.current = false;
      props.onClose?.();
    }
  };
  const run = async (operation: (generation: number) => Promise<void>): Promise<void> => {
    if (responding.current || props.disabled || props.canStartResponse?.() === false) return;
    const claim = props.mutationGate?.acquire("request");
    if (props.mutationGate && !claim) return;
    responding.current = true;
    const generation = ++operationGeneration.current;
    setBusy(true);
    setError(null);
    try {
      await operation(generation);
    } catch (reason) {
      if (generation === operationGeneration.current) setError(describe(reason));
    } finally {
      responding.current = false;
      if (claim) props.mutationGate?.release(claim);
      if (generation === operationGeneration.current) {
        setBusy(false);
        setConnecting(false);
      }
    }
  };
  const finish = async (
    connectionId: string,
    generation: number,
    current = loaded,
  ): Promise<void> => {
    if (!current || !workspace) return;
    const [dashboard, platform] = await Promise.all([
      props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ]);
    if (generation !== operationGeneration.current) return;
    const next = { ...current, dashboard, platform };
    const nextPlan = accessPlan(next, connectionId);
    if (!nextPlan?.selectedAccount || nextPlan.selectedAccount.id !== connectionId)
      throw new Error(
        "Authorization finished without recording the requested account. Start the connection again.",
      );
    if (computerAccessUpgrade(nextPlan, effectiveAccess))
      throw new Error("Allow changes on this computer before allowing this request.");
    if (
      workspace.kind === "project" ||
      (await integrationRequestStillPending(
        props.hostClient,
        props.request.originatingThreadId,
        props.request.id,
      ))
    ) {
      if (generation !== operationGeneration.current) return;
      await resolveIntegrationAccess(props.hostClient, {
        access: effectiveAccess,
        accountsCount: nextPlan.accounts.length,
        installationTitle: nextPlan.installationTitle,
        requestId: props.request.id,
        selectedAccount: nextPlan.selectedAccount,
        targetKind: workspace.kind,
      });
    }
    if (generation !== operationGeneration.current) return;
    if (
      await integrationRequestStillPending(
        props.hostClient,
        props.request.originatingThreadId,
        props.request.id,
      )
    )
      throw new Error("The account is connected, but this request is still waiting. Try again.");
    if (generation !== operationGeneration.current) return;
    setLoaded(next);
    setAccountId(connectionId);
    setConnected(nextPlan.selectedAccount);
    setStep("review");
    if (presented.current) {
      presented.current = false;
      props.onClose?.();
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    props.onResponded();
  };
  const checkRepositories = async (
    connectionId: IntegrationConnectionSummary["id"],
    generation: number,
  ): Promise<IntegrationRepositoryAccess | null> => {
    try {
      return unwrapRpcResult(
        await props.hostClient.rpc["integration.repositoryAccess.check"]({ connectionId }),
      );
    } catch (reason) {
      if (generation !== operationGeneration.current) return null;
      const dashboard = await props.hostClient.rpc["integrations.get"]({})
        .then(unwrapRpcResult)
        .catch(() => null);
      if (generation !== operationGeneration.current) return null;
      if (dashboard) setLoaded((current) => (current ? { ...current, dashboard } : current));
      const next = dashboard ? repositoryAccountStep(dashboard, connectionId) : null;
      if (next?.kind === "connected") await finish(connectionId, generation);
      else if (next?.kind === "sign-in") {
        setError(next.detail ?? describe(reason));
        setStep("review");
        if (presented.current) {
          presented.current = false;
          props.onClose?.();
        }
      } else {
        setError(describe(reason));
        showForm("repository-access");
      }
      return null;
    }
  };
  const authorize = async (current: LoadedAccessRequest, generation: number): Promise<void> => {
    if (!workspace) return;
    const next = connectCard({
      loaded: current,
      workspace,
      allowChanges,
      selectedAccountId: accountId,
    });
    const nextPlan = next.plan;
    if (!nextPlan) return;
    setConnecting(true);
    const status =
      nextPlan.requirement.kind === "mcp-oauth" && nextPlan.serverId
        ? await mobile.beginMcpIntegrationAuthorization({
            displayName: accountName.trim() || `${nextPlan.installationTitle} account`,
            requestId: props.request.id,
            serverId: nextPlan.serverId,
          })
        : nextPlan.definition && next.source
          ? await mobile.beginIntegrationAuthorization({
              applicationSource: next.source,
              definitionId: nextPlan.definition.id,
            })
          : null;
    if (generation !== operationGeneration.current) return;
    if (!status) throw new Error("Open integration settings to finish this connection.");
    const outcome = integrationAuthorizationError(status.status, status.failureCode);
    if (outcome) throw new Error(outcome);
    if (!status.connectionId)
      throw new Error(
        "Authorization finished without recording an account. Start the connection again.",
      );
    const dashboard = unwrapRpcResult(await props.hostClient.rpc["integrations.get"]({}));
    if (generation !== operationGeneration.current) return;
    const connection = authorizationConnection(dashboard, status.connectionId);
    if (nextPlan.requirement.kind === "provider" && !connection)
      throw new Error(
        `${nextPlan.integrationName} reported success, but no connected account is recorded here. Start the connection again.`,
      );
    if (connection?.provider === "github") {
      setConnectedId(connection.id);
      setRepositoryAccess(null);
      const access = await checkRepositories(connection.id, generation);
      if (!access || generation !== operationGeneration.current) return;
      if (!access.ready) {
        setRepositoryAccess(access);
        setStep("repository-access");
        if (!presented.current) {
          presented.current = true;
          props.onPresent?.();
        }
        return;
      }
    }
    await finish(status.connectionId, generation, current);
  };
  const install = () =>
    run(async (generation) => {
      if (!payload || !loaded || !card?.primary || !workspace) return;
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}:install`),
        requestId: props.request.id,
        response: { kind: "choice", optionId: "installed" },
        type: "request.respond",
      });
      let before: string | undefined;
      let updated: Request | undefined;
      do {
        const page = unwrapRpcResult(
          await props.hostClient.rpc["thread.requests.list"]({
            threadId: props.request.originatingThreadId,
            limit: 100,
            ...(before ? { before } : {}),
          }),
        );
        updated = page.requests.find((candidate) => candidate.id === props.request.id);
        if (updated || !page.window.hasMore) break;
        if (!page.window.nextBefore)
          throw new Error("Thread Request page is missing its continuation cursor.");
        before = page.window.nextBefore;
      } while (before);
      if (updated?.payload.kind !== "integration.access")
        throw new Error("This connection request is no longer available.");
      const [dashboard, platform] = await Promise.all([
        props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]);
      if (generation !== operationGeneration.current) return;
      const next = { dashboard, platform, request: updated.payload };
      setLoaded(next);
      if (card.autoInstall) {
        const nextCard = connectCard({ loaded: next, workspace, allowChanges });
        if (nextCard.form === "api-key") showForm("api-key");
        else if (nextCard.form === "computer") showForm("computer");
        else if (nextCard.form === "server") showForm("server");
        else if (nextCard.primary?.kind === "connect") await authorize(next, generation);
        else if (nextCard.plan?.requirement.kind === "none") {
          await resolveIntegrationAccess(props.hostClient, {
            access: nextCard.effectiveAccess,
            accountsCount: 0,
            installationTitle: nextCard.plan.installationTitle,
            requestId: props.request.id,
            selectedAccount: null,
            targetKind: workspace.kind,
          });
          if (generation === operationGeneration.current) props.onResponded();
        }
      }
    });
  const connectApiKey = () =>
    run(async (generation) => {
      if (!plan?.apiKeyMethod || !plan.definition || !loaded) return;
      const result = await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-key:${plan.definition.id}`),
        input: {
          authMethodId: plan.apiKeyMethod.id,
          ...(reconnect?.method === "api-key" ? { connectionId: reconnect.account.id } : {}),
          definitionId: plan.definition.id,
          ...(apiKeyName.trim() ? { displayName: apiKeyName.trim() } : {}),
          values: apiKeyValues,
        },
        type: "integration.apiKey.connect",
      });
      if (generation !== operationGeneration.current) return;
      setApiKeyValues({});
      // An older Host does not say which account the key made; the person
      // then chooses it with Use rather than the card guessing.
      if (result.type === "integration.apiKey.connect" && result.connectionId) {
        await finish(result.connectionId, generation);
      } else {
        // Back to the card, where the saved account waits for Use.
        close();
        setReload((value) => value + 1);
      }
    });
  const recheckRepositories = () =>
    run(async (generation) => {
      if (!connectedId) return;
      const access = await checkRepositories(connectedId, generation);
      if (!access || generation !== operationGeneration.current) return;
      setRepositoryAccess(access);
      if (access.ready) await finish(connectedId, generation);
    });
  const setComputerApp = (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }) =>
    run(async (generation) => {
      if (!plan?.definition) return;
      const command = {
        idempotencyKey: mutationIdempotencyKey(
          `integration-computer:${plan.definition.id}:${input.runnerId}:${input.access}`,
        ),
        input: {
          ...input,
          runnerId: RunnerIdSchema.parse(input.runnerId),
          app: null,
          definitionId: plan.definition.id,
          kind: "app" as const,
        },
      };
      const phone = plan.definition.id === "android-phone";
      const result = phone
        ? await props.hostClient.dispatch({ ...command, type: "integration.computer.setup.set" })
        : await props.hostClient.dispatch({
            ...command,
            type: "integration.computer.setup.request",
          });
      if (
        result.type !== "integration.computer.setup.set" &&
        result.type !== "integration.computer.setup.request"
      )
        throw new Error("Integration computer command mismatch.");
      if (generation !== operationGeneration.current) return;
      const computer = snapshot.machines.find((machine) => machine.id === input.runnerId);
      setNotice(
        phone && computer && isAndroidPhone(computer)
          ? `Agents can now use ${computer.name} at the access you chose.`
          : `Setup requested. On ${computer?.name ?? "that computer"}, open Opensteer → Settings → Computers to approve ${plan.definition.name}.`,
      );
      setReload((value) => value + 1);
    });
  const chooseServer = (serverId: string) =>
    run(async (generation) => {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}:server:${serverId}`),
        requestId: props.request.id,
        response: { kind: "choice", optionId: `server:${serverId}` },
        type: "request.respond",
      });
      if (generation !== operationGeneration.current) return;
      setStep("review");
      setReload((value) => value + 1);
    });
  const decline = () =>
    run(async (generation) => {
      await props.hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`request:${props.request.id}`),
        requestId: props.request.id,
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      });
      if (generation === operationGeneration.current) props.onResponded();
    });
  const allow = () => {
    lastAction.current = "allow";
    return run(async (generation) => {
      if (!plan || !workspace) return;
      if (plan.selectedAccount) await finish(plan.selectedAccount.id, generation);
      else {
        await resolveIntegrationAccess(props.hostClient, {
          access: effectiveAccess,
          accountsCount: 0,
          installationTitle: plan.installationTitle,
          requestId: props.request.id,
          selectedAccount: null,
          targetKind: workspace.kind,
        });
        if (generation === operationGeneration.current) props.onResponded();
      }
    });
  };
  const openConnect = (): void => {
    if (!plan || !loaded) return;
    lastAction.current = "connect";
    if (plan.apiKeyMethod) {
      if (reconnect) setApiKeyName(reconnect.account.displayName);
      showForm("api-key");
    } else if (plan.requirement.kind === "computer") showForm("computer");
    else void run((generation) => authorize(loaded, generation));
  };
  const primary = (): void => {
    if (!card) return;
    switch (card.primary?.kind) {
      case "retry":
        setError(null);
        if (step === "repository-access") void recheckRepositories();
        else if (lastAction.current === "allow" && plan?.selectedAccount) void allow();
        else if (loaded?.request.installationId === null) void install();
        else if (plan) openConnect();
        else setReload((value) => value + 1);
        break;
      case "install":
        void install();
        break;
      case "use":
        void allow();
        break;
      case "settings":
        navigation.navigate("SettingsPlugins", { deploymentId: snapshot.deploymentId! });
        break;
      case "server":
        showForm("server");
        break;
      case "repositories":
        void recheckRepositories();
        break;
      case "upgrade":
        if (computerUpgrade)
          void setComputerApp({ access: "read-write", runnerId: computerUpgrade.runnerId });
        break;
      case "connect":
        if (loaded?.request.installationId === null) void install();
        else openConnect();
        break;
    }
  };
  if (!card)
    return (
      <View style={styles.body}>
        <AppText role="secondary">
          {error ??
            (!workspace
              ? snapshot.workspaceWindow.hasMore
                ? "Checking target Workspace…"
                : "The target Workspace is no longer available."
              : "Checking account access…")}
        </AppText>
        {error || (!workspace && !snapshot.workspaceWindow.hasMore) ? (
          <SecondaryButton
            label="Not now"
            disabled={busy || (props.disabled ?? false)}
            onPress={() => void decline()}
          />
        ) : null}
        {error ? (
          <PrimaryButton
            label="Try again"
            onPress={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          />
        ) : null}
      </View>
    );
  if (card.phase === "connected")
    return (
      <View style={styles.result}>
        <AppText role="body">{card.success}</AppText>
      </View>
    );
  if (card.phase === "answered") return <AppText role="secondary">Request answered</AppText>;
  const title =
    step === "computer"
      ? "Choose a computer"
      : step === "repository-access"
        ? "Choose GitHub repositories"
        : step === "server"
          ? "Choose server"
          : (card.primary?.label ?? `Connect ${card.name}`);
  return (
    <View style={styles.body}>
      <View style={styles.integrationHeading}>
        <IntegrationIcon definitionId={card.iconId} name={card.name} />
        <View style={styles.integrationHeadingText}>
          <AppText role="title">{card.name}</AppText>
          <AppText role="secondary" tone="soft">
            {card.purpose}
          </AppText>
        </View>
      </View>
      {card.capabilities
        .filter(
          (line) => line.includes("connecting also allows") || line.includes("requires read-write"),
        )
        .map((line) => (
          <AppText key={line} role="secondary" tone="muted">
            {line}
          </AppText>
        ))}
      {plan?.proposed || props.request.presentation.agentProposed ? (
        <AgentProposedCaption proposed />
      ) : null}
      {card.projectNote ? (
        <AppText role="secondary" tone="muted">
          {card.projectNote}
        </AppText>
      ) : null}
      {/* Primary action precedes account rows in accessibility focus order. */}
      {card.primary ? (
        <PrimaryButton
          busy={busy}
          disabled={props.disabled ?? false}
          label={card.primary.label}
          onPress={primary}
        />
      ) : null}
      {connecting ? (
        <AppText role="secondary">Connecting…</AppText>
      ) : (
        <SecondaryButton
          busy={busy}
          disabled={props.disabled ?? false}
          label={card.secondary}
          onPress={() => void decline()}
        />
      )}
      {card.error ? (
        <Notice detail={card.error} title="This connection did not finish" tone="danger" />
      ) : null}
      {props.disabledReason ? (
        <AppText role="secondary" tone="muted">
          {props.disabledReason}
        </AppText>
      ) : null}
      {notice ? (
        <>
          <Notice detail={notice} title="Saved" tone="neutral" />
          {plan?.requirement.kind === "computer" ? (
            <SecondaryButton
              label="Check setup"
              disabled={busy}
              onPress={() => setReload((value) => value + 1)}
            />
          ) : null}
        </>
      ) : null}
      {card.installReview ? (
        <InstallReview
          canInstall={loaded?.dashboard.isAdministrator ?? false}
          continuesToAccess
          installedTitle={null}
          manifest={loaded?.request.manifest}
        />
      ) : null}
      {card.accounts.length ? (
        <RowGroup>
          {card.accounts.map((account) => (
            <ChoiceRow
              disabled={busy || (props.disabled ?? false)}
              description={`${account.displayName} · ${account.detail}${account.selected ? " · chosen" : ""}`}
              key={account.id}
              onPress={() => setAccountId(account.id)}
              title={account.label}
            />
          ))}
        </RowGroup>
      ) : null}
      {card.canConnectAnother && card.accounts.length ? (
        <SecondaryButton
          disabled={busy || (props.disabled ?? false)}
          label={
            plan?.requirement.kind === "computer"
              ? "Use another computer"
              : "Connect another account"
          }
          onPress={openConnect}
        />
      ) : null}
      {card.canAllowChanges ? (
        <SwitchRow
          disabled={busy || (props.disabled ?? false)}
          label={
            plan?.definition?.computerApp
              ? `Allow changes (${plan.definition.computerApp.accessLabels.readWrite})`
              : "Allow changes"
          }
          onChange={setAllowChanges}
          value={allowChanges}
        />
      ) : null}
      {plan?.requirement.kind === "mcp-oauth" && !plan.accounts.length ? (
        <Field
          label="Account name"
          input={{
            value: accountName || `${plan.installationTitle} account`,
            onChangeText: setAccountName,
          }}
        />
      ) : null}
      {reconnect ? (
        <AppText role="secondary">
          {integrationAccountDetail(reconnect.account, [
            reconnect.account,
            ...(plan?.accounts ?? []),
          ])}{" "}
          · Needs attention
        </AppText>
      ) : null}
      {computerUpgrade ? (
        <Notice
          title="Allow changes on this computer"
          detail={`${plan?.integrationName} on ${computerUpgrade.displayName} is ${plan?.definition?.computerApp?.accessLabels.read ?? "read only"}. Choose ${plan?.definition?.computerApp?.accessLabels.readWrite ?? "read and write"} before allowing changes in this Workspace; the request itself does not change.`}
          tone="neutral"
        />
      ) : null}
      {reconnect?.statusDetail ? (
        <AppText role="secondary" tone="muted">
          {reconnect.statusDetail}
        </AppText>
      ) : null}
      {plan?.requirement.kind === "computer" ? (
        <ReviewStep
          plan={plan}
          connections={loaded?.dashboard.connections ?? []}
          machines={snapshot.machines}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: disclosed }}
        onPress={() => setDisclosed((value) => !value)}
        style={styles.disclosure}
      >
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="action">
          What Opensteer can do
        </AppText>
      </Pressable>
      {disclosed
        ? card.capabilities
            .filter(
              (line) =>
                !line.includes("connecting also allows") && !line.includes("requires read-write"),
            )
            .map((line) => (
              <AppText key={line} role="secondary" tone="muted">
                {line}
              </AppText>
            ))
        : null}
      <Sheet
        open={step !== "review"}
        onClose={close}
        title={title}
        footer={
          <View style={styles.footer}>
            {step === "api-key" && plan?.apiKeyMethod ? (
              <PrimaryButton
                busy={busy}
                disabled={
                  props.disabled ||
                  plan.apiKeyMethod.inputs.some(
                    ({ variable }) => !(apiKeyValues[variable] ?? "").trim(),
                  )
                }
                label={
                  reconnect
                    ? `Reconnect ${reconnect.account.accountIdentifier ?? reconnect.account.displayName}`
                    : `Connect ${card.name}`
                }
                onPress={() => void connectApiKey()}
              />
            ) : null}
            {step === "computer" && computerChosen ? (
              <PrimaryButton
                busy={busy}
                disabled={props.disabled ?? false}
                label={`Request setup on ${computerChosen.machine.name}`}
                onPress={() =>
                  void setComputerApp({
                    access: computerAccess,
                    runnerId: computerChosen.machine.id,
                  })
                }
              />
            ) : null}
            {step === "repository-access" ? (
              <PrimaryButton
                busy={busy}
                disabled={props.disabled ?? false}
                label="Recheck repository access"
                onPress={() => void recheckRepositories()}
              />
            ) : null}
            <SecondaryButton label="Finish later" onPress={close} />
          </View>
        }
      >
        <View style={styles.body}>
          {error ? (
            <Notice detail={error} title="This connection did not finish" tone="danger" />
          ) : null}
          {notice ? (
            <>
              <Notice detail={notice} title="Saved" tone="neutral" />
              {plan?.requirement.kind === "computer" ? (
                <SecondaryButton
                  label="Check setup"
                  disabled={busy}
                  onPress={() => setReload((value) => value + 1)}
                />
              ) : null}
            </>
          ) : null}
          {step === "api-key" && plan?.apiKeyMethod && plan.definition ? (
            <>
              <AgentProposedCaption proposed={card.proposed} />
              <ApiKeyStep
                definition={plan.definition}
                proposed={card.proposed}
                displayName={apiKeyName}
                method={plan.apiKeyMethod}
                onDisplayName={setApiKeyName}
                onValue={(variable, value) =>
                  setApiKeyValues((current) => ({ ...current, [variable]: value }))
                }
                values={apiKeyValues}
              />
            </>
          ) : null}
          {step === "computer" && plan?.definition && computerChoices ? (
            <ComputerAppPicker
              access={computerAccess}
              busy={busy}
              chosenId={computerChosen?.machine.id ?? null}
              definition={plan.definition}
              onAccess={setComputerAccess}
              onChoose={setComputerId}
              targets={computerChoices}
            />
          ) : null}
          {step === "repository-access" ? <RepositoryAccessStep access={repositoryAccess} /> : null}
          {step === "server"
            ? card.serverChoices.map((server) => (
                <SecondaryButton
                  key={server.id}
                  disabled={props.disabled || busy}
                  label={`Continue with ${server.name}`}
                  onPress={() => void chooseServer(server.id)}
                />
              ))
            : null}
        </View>
      </Sheet>
    </View>
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
function AgentProposedCaption({ proposed }: { readonly proposed: boolean }): ReactNode {
  if (!proposed) return null;
  return (
    <AppText accessibilityHint={requestAgentProposedDetail} role="caption" tone="muted">
      {requestAgentProposedLabel}
    </AppText>
  );
}

function ReviewStep(props: {
  readonly connections: LoadedAccessRequest["dashboard"]["connections"];
  readonly machines: HostSnapshot["machines"];
  readonly plan: AccessPlan;
}): ReactNode {
  const { plan } = props;
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
      {selectedComputerPermission === null || selectedComputerMachine === null ? null : (
        <Notice
          detail={`${selectedComputerPermission.detail} ${computerAppSetupElsewhere(
            selectedComputerMachine.name,
          )}`}
          title={selectedComputerPermission.title}
          tone="neutral"
        />
      )}
    </>
  );
}

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

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "This deployment could not be reached.";
}
const styles = StyleSheet.create({
  body: { gap: space[12], padding: space[16] },
  fact: { gap: space[2], paddingHorizontal: space[14], paddingVertical: space[12] },
  footer: { backgroundColor: color.surface, gap: space[8] },
  integrationHeading: { alignItems: "center", flexDirection: "row", gap: space[10] },
  integrationHeadingText: { flex: 1 },
  disclosure: { minHeight: touchTarget, justifyContent: "center" },
  result: { padding: space[16] },
});
