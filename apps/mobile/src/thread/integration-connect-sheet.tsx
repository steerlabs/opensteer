import { computerTargetId } from "@opensteer/client/host";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { isPhoneDisplayDefinitionId, RunnerIdSchema, type Request } from "@opensteer/core";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import {
  accessPlan,
  computerAccessUpgrade,
  computerAppPermissionNotice,
  computerAppSetupElsewhere,
  collapsedAccountRows,
  computerConnectionState,
  connectCard,
  integrationRequestStillPending,
  setPhoneUseAccess,
  resolveIntegrationAccess,
  type AccessPlan,
  type AccessRequestAccount,
  type ConnectCard,
  type IntegrationAccess,
  type LoadedAccessRequest,
} from "@opensteer/client/integrations";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { Symbol } from "../ui/symbol.js";
import { AppText, Notice, PrimaryButton, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import { ComputerAppPicker, computerAppChoices } from "./computer-app-picker.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";

type Step = "review" | "accounts" | "computer" | "server";
type CardHostState = Pick<HostSnapshot, "deploymentId" | "machines"> & {
  readonly deploymentName: string;
};
const sameCardHostState = (a: CardHostState, b: CardHostState) =>
  a.deploymentId === b.deploymentId &&
  a.machines === b.machines &&
  a.deploymentName === b.deploymentName;

/**
 * An agent's ask for a device data app or a local server. The Request stays
 * inline; only choosing a computer or a server needs a sheet.
 */
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
  const aiSharing = useAiSharing();
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
  const [connected, setConnected] = useState<AccessRequestAccount | null>(null);
  const [computerId, setComputerId] = useState<string | null>(null);
  const [computerAccess, setComputerAccess] = useState<IntegrationAccess>("read");
  const [disclosed, setDisclosed] = useState(false);
  const operationGeneration = useRef(0);
  const responding = useRef(false);
  const presented = useRef(false);
  /** What Try again repeats: a failed install must never become approval. */
  const lastAction = useRef<"allow" | "connect" | null>(null);
  const selectCardHostState = useMemo(
    () =>
      (snapshot: HostSnapshot): CardHostState => ({
        deploymentId: snapshot.deploymentId,
        machines: snapshot.machines,
        deploymentName: snapshot.identityConfig?.deployment.name ?? "your computer",
      }),
    [],
  );
  const snapshot = useHostSelector(props.hostClient, selectCardHostState, sameCardHostState);
  const plan = useMemo(
    () => (loaded === null ? null : accessPlan(loaded, accountId)),
    [loaded, accountId],
  );
  const card = useMemo(
    () =>
      loaded
        ? connectCard({
            loaded,
            selectedAccountId: accountId,
            allowChanges,
            error,
            connectedAccount: connected,
            answered: props.request.status !== "pending",
          })
        : null,
    [loaded, accountId, allowChanges, props.request.status, error, connected],
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
  const effectiveAccess = card?.effectiveAccess ?? "read";
  const computerUpgrade = card?.upgrade ?? null;

  useEffect(() => {
    setLoaded(null);
    setStep("review");
    setBusy(false);
    setError(null);
    setNotice(null);
    setAccountId(null);
    setAllowChanges(false);
    setConnected(null);
    setComputerId(null);
    setComputerAccess("read");
    return () => {
      operationGeneration.current += 1;
      if (presented.current) props.onClose?.();
    };
  }, [props.hostClient, props.request.id]);
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
    if (presented.current) {
      presented.current = false;
      props.onClose?.();
    }
  };
  const run = async (
    operation: (generation: number) => Promise<void>,
    needsConsent = true,
  ): Promise<void> => {
    const reviewGeneration = operationGeneration.current;
    if (needsConsent && !(await authorizeAiSharing(aiSharing, props.hostClient))) return;
    if (reviewGeneration !== operationGeneration.current) return;
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
      if (generation === operationGeneration.current) setBusy(false);
    }
  };
  const finish = async (
    connectionId: string,
    generation: number,
    current = loaded,
  ): Promise<void> => {
    if (!current) return;
    const [dashboard, platform] = await Promise.all([
      props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
      props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    ]);
    if (generation !== operationGeneration.current) return;
    const next = { ...current, dashboard, platform };
    const nextPlan = accessPlan(next, connectionId);
    if (!nextPlan?.selectedAccount || nextPlan.selectedAccount.id !== connectionId)
      throw new Error("That computer is no longer available. Choose it again.");
    if (computerAccessUpgrade(nextPlan, effectiveAccess))
      throw new Error("Allow changes on this computer before allowing this request.");
    if (
      await integrationRequestStillPending(
        props.hostClient,
        props.request.originatingThreadId,
        props.request.id,
      )
    ) {
      if (generation !== operationGeneration.current) return;
      await resolveIntegrationAccess(props.hostClient, {
        access: effectiveAccess,
        accountsCount: nextPlan.accounts.length,
        installationTitle: nextPlan.installationTitle,
        requestId: props.request.id,
        selectedAccount: nextPlan.selectedAccount,
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
      throw new Error("This request is still waiting. Try again.");
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
  const install = () =>
    run(async (generation) => {
      if (!payload || !loaded || !card?.primary) return;
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
        throw new Error("This request is no longer available.");
      const [dashboard, platform] = await Promise.all([
        props.hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
        props.hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]);
      if (generation !== operationGeneration.current) return;
      const next = { dashboard, platform, request: updated.payload };
      setLoaded(next);
      // A catalog app goes on to its computer, or to its server, on the same card.
      const nextCard = connectCard({ loaded: next, allowChanges });
      if (nextCard.form === "computer") showForm("computer");
      else if (nextCard.form === "server") showForm("server");
    });
  const setComputerApp = (input: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  }) =>
    run(async (generation) => {
      if (!plan?.definition) return;
      const computer = snapshot.machines.find((machine) => machine.id === input.runnerId);
      // The owner sets a phone's access here; a Mac app is approved on that Mac.
      if (isPhoneDisplayDefinitionId(plan.definition.id)) {
        if (!computer) throw new Error("That phone isn't one of your devices any more.");
        await setPhoneUseAccess(props.hostClient, computer, input.access);
        if (generation !== operationGeneration.current) return;
        setNotice(`Agents can now use ${computer.name} at the access you chose.`);
        setReload((value) => value + 1);
        return;
      }
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
      const result = await props.hostClient.dispatch({
        ...command,
        type: "integration.computer.setup.request",
      });
      if (result.type !== "integration.computer.setup.request")
        throw new Error("Integration computer command mismatch.");
      if (generation !== operationGeneration.current) return;
      setNotice(
        `Setup requested. On ${computer?.name ?? "that computer"}, open Opensteer → Settings → Devices to approve ${plan.definition.name}.`,
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
    }, false);
  const allow = () => {
    lastAction.current = "allow";
    return run(async (generation) => {
      if (!plan) return;
      if (plan.selectedAccount) await finish(plan.selectedAccount.id, generation);
      else {
        await resolveIntegrationAccess(props.hostClient, {
          access: effectiveAccess,
          accountsCount: 0,
          installationTitle: plan.installationTitle,
          requestId: props.request.id,
          selectedAccount: null,
        });
        if (generation === operationGeneration.current) props.onResponded();
      }
    });
  };
  const openConnect = (): void => {
    if (plan?.requirement.kind !== "computer") return;
    lastAction.current = "connect";
    showForm("computer");
  };
  const primary = (): void => {
    if (!card) return;
    switch (card.primary?.kind) {
      case "retry":
        setError(null);
        if (lastAction.current === "allow") void allow();
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
      case "server":
        showForm("server");
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
        <AppText role="secondary">{error ?? "Checking access…"}</AppText>
        {error ? (
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
      <View accessibilityRole="summary" style={styles.result}>
        <View style={styles.resultMark}>
          <Symbol name="checkmark" size={11} tint={color.green} weight="bold" />
        </View>
        <AppText role="body" style={styles.resultText}>
          {card.success}
        </AppText>
      </View>
    );
  if (card.phase === "answered") return <AppText role="secondary">Request answered</AppText>;
  const title =
    step === "accounts"
      ? `${card.name} on your computers`
      : step === "computer"
        ? "Choose a computer"
        : step === "server"
          ? "Choose server"
          : (card.primary?.label ?? `Connect ${card.name}`);
  const controlsDisabled = busy || (props.disabled ?? false);
  const collapsed = collapsedAccountRows(card.accounts, collapsedAccountLimit);
  const addLabel = "Use another computer";
  const canAdd = card.canConnectAnother && card.accounts.length > 0;
  const chooseAccount = (id: string) => {
    setAccountId(id);
    void Haptics.selectionAsync();
  };
  return (
    <View style={styles.body}>
      <View style={styles.integrationHeading}>
        <IntegrationIcon definitionId={card.iconId} name={card.name} />
        <View style={styles.integrationHeadingText}>
          <AppText role="title">{card.title}</AppText>
          {card.reason ? (
            <AppText role="secondary" tone="soft">
              {card.reason}
            </AppText>
          ) : null}
        </View>
      </View>
      {card.error ? <Notice detail={card.error} title="This didn't finish" tone="danger" /> : null}
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
      {collapsed.rows.length > 0 ? (
        <View style={styles.list}>
          {collapsed.rows.map((account, index) => (
            <AccountRow
              account={account}
              disabled={controlsDisabled}
              first={index === 0}
              key={account.id}
              onPress={() => chooseAccount(account.id)}
            />
          ))}
          {collapsed.hidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              // Dismissing a sheet abandons what it belongs to, so the list
              // cannot open over an answer the card is still waiting on.
              disabled={busy}
              onPress={() => showForm("accounts")}
              style={({ pressed }) => [
                styles.row,
                styles.rowSeparated,
                pressed && styles.rowPressed,
                busy && styles.rowDisabled,
              ]}
            >
              <AppText role="secondaryMedium" style={styles.rowText} tone="soft">
                {`See all ${card.accounts.length} computers`}
              </AppText>
              <Symbol name="chevron.right" size={13} tint={color.muted} />
            </Pressable>
          ) : null}
          {canAdd ? (
            <AddAccountRow disabled={controlsDisabled} label={addLabel} onPress={openConnect} />
          ) : null}
        </View>
      ) : null}
      {card.canAllowChanges ? (
        <SwitchRow
          disabled={controlsDisabled}
          label={
            plan?.definition?.computerApp
              ? `Allow changes (${plan.definition.computerApp.accessLabels.readWrite})`
              : "Allow changes"
          }
          onChange={setAllowChanges}
          value={allowChanges}
        />
      ) : null}
      {computerUpgrade ? (
        <Notice
          title="Allow changes on this computer"
          detail={`${plan?.integrationName} on ${computerUpgrade.displayName} is ${plan?.definition?.computerApp?.accessLabels.read ?? "read only"}. Choose ${plan?.definition?.computerApp?.accessLabels.readWrite ?? "read and write"} before allowing changes; the request itself does not change.`}
          tone="neutral"
        />
      ) : null}
      {plan?.requirement.kind === "computer" ? (
        <ReviewStep
          plan={plan}
          connections={loaded?.dashboard.connections ?? []}
          machines={snapshot.machines}
        />
      ) : null}
      <View style={styles.actions}>
        <View style={styles.actionSecondary}>
          <SecondaryButton
            busy={busy && !card.primary}
            disabled={props.disabled ?? false}
            label={card.secondary}
            onPress={() => void decline()}
          />
        </View>
        {card.primary ? (
          <View style={styles.actionPrimary}>
            <PrimaryButton
              busy={busy}
              disabled={props.disabled ?? false}
              label={card.primary.label}
              onPress={primary}
            />
          </View>
        ) : null}
      </View>
      {card.details.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: disclosed }}
          hitSlop={space[8]}
          onPress={() => setDisclosed((value) => !value)}
          style={styles.scope}
        >
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
            {card.scope}
          </AppText>
          <Symbol name={disclosed ? "chevron.up" : "chevron.down"} size={11} tint={color.muted} />
        </Pressable>
      ) : (
        <AppText role="caption" style={styles.scopeText} tone="muted">
          {card.scope}
        </AppText>
      )}
      {disclosed && card.details.length > 0 ? (
        <View style={styles.details}>
          {card.details.map((line) => (
            <AppText key={line} role="secondary" tone="soft">
              {line}
            </AppText>
          ))}
        </View>
      ) : null}
      <Sheet
        open={step !== "review"}
        onClose={close}
        title={title}
        // The account list is a light page sheet a person swipes away; the
        // forms keep their pinned footer above the keyboard.
        footer={
          step === "accounts" ? undefined : (
            <View style={styles.footer}>
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
              <SecondaryButton label="Finish later" onPress={close} />
            </View>
          )
        }
      >
        <View style={styles.body}>
          {error ? <Notice detail={error} title="This didn't finish" tone="danger" /> : null}
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
          {step === "accounts" ? (
            <View style={styles.list}>
              {card.accounts.map((account, index) => (
                <AccountRow
                  account={account}
                  disabled={controlsDisabled}
                  first={index === 0}
                  key={account.id}
                  onPress={() => {
                    chooseAccount(account.id);
                    close();
                  }}
                />
              ))}
              {card.canConnectAnother ? (
                <AddAccountRow
                  disabled={controlsDisabled}
                  label={addLabel}
                  onPress={() => {
                    close();
                    openConnect();
                  }}
                />
              ) : null}
            </View>
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

/** Rows shown before "See all": two, so the card never covers the whole thread on a phone. */
const collapsedAccountLimit = 2;

type AccountRowModel = ConnectCard["accounts"][number];

function AccountRow(props: {
  readonly account: AccountRowModel;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly onPress: () => void;
}): ReactNode {
  const { account } = props;
  return (
    <Pressable
      accessibilityLabel={account.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: account.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        !props.first && styles.rowSeparated,
        account.selected && styles.rowSelected,
        pressed && !account.selected && styles.rowPressed,
        props.disabled && !account.selected && styles.rowDisabled,
      ]}
    >
      <View style={styles.avatar}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="soft">
          {(account.label.trim()[0] ?? "?").toLocaleUpperCase()}
        </AppText>
      </View>
      <View style={styles.rowText}>
        <AppText numberOfLines={1} role="bodyMedium">
          {account.label}
        </AppText>
      </View>
      <View style={[styles.radio, account.selected && styles.radioChecked]}>
        {account.selected ? <View style={styles.radioDot} /> : null}
      </View>
    </Pressable>
  );
}

function AddAccountRow(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        styles.rowSeparated,
        pressed && styles.rowPressed,
        props.disabled && styles.rowDisabled,
      ]}
    >
      <View style={[styles.avatar, styles.avatarAdd]}>
        <Symbol name="plus" size={13} tint={color.ember} weight="semibold" />
      </View>
      <AppText role="bodyMedium" style={styles.rowText} tone="ember">
        {props.label}
      </AppText>
    </Pressable>
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
      : (props.machines.find(
          ({ id }) => id === computerTargetId(selectedComputerConnection.computer),
        ) ?? null);
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

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "This deployment could not be reached.";
}
const styles = StyleSheet.create({
  actionPrimary: { flex: 1.4 },
  actionSecondary: { flex: 1 },
  actions: { flexDirection: "row", gap: space[8] },
  avatar: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: color.lineStrong,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  avatarAdd: {
    backgroundColor: "transparent",
    borderColor: color.emberLine,
    borderStyle: "dashed",
    borderWidth: 1,
  },
  body: { gap: space[12], padding: space[16] },
  details: {
    ...material.quiet,
    borderRadius: radius.sm,
    gap: space[6],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  footer: { backgroundColor: color.surface, gap: space[8] },
  integrationHeading: { alignItems: "flex-start", flexDirection: "row", gap: space[12] },
  integrationHeadingText: { flex: 1, gap: space[2] },
  list: { ...material.plate, borderRadius: radius.md, overflow: "hidden" },
  radio: {
    alignItems: "center",
    borderColor: color.lineControl,
    borderRadius: 10,
    borderWidth: 1.5,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  radioChecked: { borderColor: color.ember },
  radioDot: { backgroundColor: color.ember, borderRadius: 5, height: 10, width: 10 },
  result: { alignItems: "center", flexDirection: "row", gap: space[10], padding: space[16] },
  resultMark: {
    alignItems: "center",
    backgroundColor: color.greenWash,
    borderRadius: 10,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  resultText: { flex: 1 },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[6],
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
  rowDisabled: { opacity: 0.5 },
  rowPressed: { ...material.quiet },
  rowSelected: { backgroundColor: color.emberWash },
  rowSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, minWidth: 0 },
  scope: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: space[4],
    minHeight: space[24],
  },
  scopeText: { textAlign: "center" },
});
