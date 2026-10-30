import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CloudDeploymentOperation } from "@opensteer/protocol/desktop";
import type {
  DeploymentAccessDeployment,
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
  DesktopNotificationTarget,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { AddDeployment } from "../components/add-deployment.js";
import { CloudDeploymentFlow } from "../components/cloud-deployment-flow.js";
import {
  DesktopLoadingScreen,
  DesktopPersonalSetup,
  DesktopPersonalLoadFailure,
  DesktopVerifiedDeployment,
} from "../components/desktop-onboarding.js";
import { DesktopPlaceChooser, DesktopWelcome } from "../components/places/place-chooser.js";
import { DesktopPlacesProvider, type DesktopPlaces } from "./places-context.js";
import { StartupFailure } from "../components/onboarding-card.js";
import {
  createDesktopHostFetch,
  createDesktopHostWebSocketFactory,
} from "./desktop-host-transport.js";
import {
  acceptDesktopDeploymentSelection,
  desktopSummaryFromAccess,
} from "./desktop-deployment-selection.js";
import { ToastProvider } from "../components/toast.js";
import { createBrowserHostClient } from "../host/browser-host-client.js";
import { browserClientLifecycle } from "../host/browser-lifecycle.js";

const SignedInApp = lazy(async () => {
  const module = await import("../app.js");
  return { default: module.App };
});

/**
 * Screens this window can browse to while a Deployment is already attached.
 * They are renderer-local: the Desktop machine has no idea a person is looking
 * at the Directory or filling in an address, and nothing is persisted.
 */
type BrowsingScreen = "add-deployment" | "cloud-deployments" | null;

type DesktopAccessPresentation =
  "blocked" | "personal" | "picker" | "ready" | "verified" | "waiting";

export function desktopAccessPresentationFromSnapshot(
  snapshot: DeploymentAccessSnapshot,
): DesktopAccessPresentation {
  const selected = snapshot.deployments.find(({ id }) => id === snapshot.selectedDeploymentId);
  if (
    snapshot.personalSetup &&
    snapshot.personalSetup.deploymentId === null &&
    snapshot.personalSetup.state !== "stopped" &&
    snapshot.personalSetup.state !== "repair-required"
  )
    return "personal";
  if (!selected) return "picker";
  if (selected.status === "connected") return "ready";
  // An Account place opens through the Account: until it is signed in again,
  // the list says so and offers the sign-in, never a server's own sign-in page.
  if (selected.source === "account" && snapshot.account.status !== "signed-in") return "picker";
  // Waiting on this Host's own browser sign-in is a person-wait, so it belongs
  // on the verified screen that says so and offers a way out — never on the
  // bare spinner the machine-wait shows.
  if (selected.status === "authorizing" || selected.status === "needs-sign-in") return "verified";
  if (selected.status === "offline" && selected.failure) return "blocked";
  // Selected but not attached — cancelled, or a place whose remote access lives
  // on another computer. The Directory is the honest surface: it says what the
  // row's own authority reports and lets a person choose again.
  if (selected.status === "idle" || selected.status === "needs-remote-access") return "picker";
  return "waiting";
}

export function desktopHostTransportIdentity(
  deployment: DesktopDeploymentSummary | undefined,
): string | null {
  return deployment
    ? `${deployment.id}\u0000${deployment.canonicalOrigin}\u0000${deployment.activeOrigin}`
    : null;
}

export function DesktopApp({ bridge }: { readonly bridge: OpensteerDesktopBridge }) {
  return (
    <ToastProvider>
      <DesktopAppSurfaces bridge={bridge} />
    </ToastProvider>
  );
}

function DesktopAppSurfaces({ bridge }: { readonly bridge: OpensteerDesktopBridge }) {
  const [snapshot, setSnapshot] = useState<DeploymentAccessSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [screen, setScreen] = useState<BrowsingScreen>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [connectingPrivate, setConnectingPrivate] = useState(false);
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [cloudOperations, setCloudOperations] = useState<readonly CloudDeploymentOperation[]>([]);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudLoadedFor, setCloudLoadedFor] = useState<string | null>(null);
  const createCloudAttempt = useRef<{ readonly name: string; readonly operationId: string } | null>(
    null,
  );
  const observedCloudTerminals = useRef(new Set<string>());
  const cloudOperationsRef = useRef<readonly CloudDeploymentOperation[]>([]);
  const accountSessionKeyRef = useRef<string | null>(null);
  const previousAccountSessionKey = useRef<string | null>(null);
  // The notification that was clicked. It names one Deployment, which this
  // window may not be showing, so it waits here — through the selection and any
  // sign-in that follows — until the app for that Deployment can open it.
  const [notificationTarget, setNotificationTarget] = useState<DesktopNotificationTarget | null>(
    null,
  );
  const requestedNotificationSelection = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    // The one staleness policy in the app: a snapshot with a revision that is
    // not newer than the one on screen is dropped. Every surface below reads
    // this state, so no section can be shown a snapshot another section refused.
    const update = (next: DeploymentAccessSnapshot) => {
      if (!cancelled) {
        setSnapshot((current) => acceptDesktopDeploymentSelection(current, next));
      }
    };
    const unsubscribe = bridge.onDeploymentAccessSnapshotChanged(update);
    void bridge
      .getDeploymentAccessSnapshot()
      .then(update)
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(errorDetail(reason, "Desktop access state is unavailable."));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, loadAttempt]);

  const selectedConnection = snapshot?.deployments.find(
    ({ id }) => id === snapshot.selectedDeploymentId,
  );
  const selected = selectedConnection ? desktopSummaryFromAccess(selectedConnection) : undefined;
  const hostTransportIdentity = JSON.stringify([
    desktopHostTransportIdentity(selected),
    selectedConnection?.attachmentKey,
    selectedConnection?.capabilities,
  ]);
  const hostClient = useMemo(() => {
    if (!selected) return null;
    return createBrowserHostClient({
      baseUrl: selected.canonicalOrigin,
      capabilities: selectedConnection?.capabilities ?? null,
      fetch: createDesktopHostFetch(bridge, selected.canonicalOrigin),
      bufferedResponses: true,
      // Desktop main holds the sockets; hiding or covering the window never closes them.
      lifecycle: browserClientLifecycle({ socketTrustWindowMs: Number.POSITIVE_INFINITY }),
      webSocketFactory: createDesktopHostWebSocketFactory(bridge, selected.canonicalOrigin),
    });
  }, [bridge, hostTransportIdentity]);

  useEffect(() => () => hostClient?.dispose(), [hostClient]);

  const cloudDeploymentIds = useMemo(
    () => new Set(cloudOperations.map(({ deploymentId }) => deploymentId)),
    [cloudOperations],
  );
  const places = useMemo<DesktopPlaces | null>(
    () =>
      snapshot
        ? {
            bridge,
            cloudDeploymentIds,
            onAddPlace: () => setScreen("add-deployment"),
            snapshot,
          }
        : null,
    [bridge, cloudDeploymentIds, snapshot],
  );

  const signedIntoAccount = snapshot?.account.status === "signed-in";
  const accountSessionKey = signedIntoAccount
    ? snapshot.account.issuer && snapshot.account.subject
      ? `${snapshot.account.issuer}\u0000${snapshot.account.subject}`
      : (snapshot.account.email ?? "signed-in")
    : null;
  accountSessionKeyRef.current = accountSessionKey;
  const hasActiveCloudOperation = cloudOperations.some(
    ({ status }) => status === "creating" || status === "deleting",
  );
  useEffect(() => {
    if (previousAccountSessionKey.current !== accountSessionKey) {
      createCloudAttempt.current = null;
      observedCloudTerminals.current.clear();
      cloudOperationsRef.current = [];
      previousAccountSessionKey.current = accountSessionKey;
    }
    if (!signedIntoAccount) {
      setCloudAvailable(false);
      setCloudOperations([]);
      createCloudAttempt.current = null;
      observedCloudTerminals.current.clear();
      cloudOperationsRef.current = [];
      return;
    }
    let cancelled = false;
    const load = async () => {
      const requestedFor = accountSessionKey;
      try {
        const result = await bridge.listCloudDeployments();
        if (!cancelled && cloudResultBelongsToAccount(requestedFor, accountSessionKeyRef.current)) {
          const previous = cloudOperationsRef.current;
          const completedDeletionDisappeared = cloudDeletionDisappeared(
            previous,
            result.deployments,
          );
          cloudOperationsRef.current = result.deployments;
          setCloudLoadedFor(requestedFor);
          setCloudAvailable(result.available);
          setCloudOperations(result.deployments);
          setCloudError(null);
          const newTerminal = result.deployments.some((operation) => {
            if (operation.status !== "ready" && operation.status !== "deleted") return false;
            const key = `${operation.operationId}:${operation.status}`;
            if (observedCloudTerminals.current.has(key)) return false;
            observedCloudTerminals.current.add(key);
            return true;
          });
          if (newTerminal || completedDeletionDisappeared) {
            void bridge
              .refreshDirectory()
              .catch((reason: unknown) =>
                setCloudError(errorDetail(reason, "Your list couldn’t be refreshed.")),
              );
          }
        }
      } catch (reason) {
        if (!cancelled) setCloudError(errorDetail(reason, "Opensteer Cloud couldn’t be loaded."));
      }
    };
    void load();
    const timer = hasActiveCloudOperation ? window.setInterval(() => void load(), 2_000) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [accountSessionKey, bridge, hasActiveCloudOperation, signedIntoAccount, screen]);

  useEffect(() => {
    if (selectedConnection?.status !== "connected" || !hostClient) return;
    if (hostClient.getSnapshot().session !== "authentication-required") return;
    void hostClient.reauthenticate().catch(() => undefined);
  }, [hostClient, selectedConnection?.status]);

  // Browsing ends when a Deployment becomes ready: a Directory or connection
  // screen left open would otherwise cover the app it just opened.
  useEffect(() => {
    if (selectedConnection?.status === "connected") setScreen(null);
  }, [selectedConnection?.status]);

  useEffect(() => {
    return bridge.onNotificationActivated((target) => {
      requestedNotificationSelection.current = null;
      setNotificationTarget(target);
      setScreen(null);
    });
  }, [bridge]);

  // Selecting the Deployment the notification belongs to is this surface's own
  // authority. A Deployment this app does not have is not one to invent an
  // address for: the target is dropped rather than opened against another Host.
  useEffect(() => {
    if (notificationTarget === null || snapshot === null) return;
    const { deploymentId } = notificationTarget;
    if (!snapshot.deployments.some((deployment) => deployment.id === deploymentId)) {
      setNotificationTarget(null);
      return;
    }
    if (
      snapshot.selectedDeploymentId === deploymentId ||
      requestedNotificationSelection.current === deploymentId
    ) {
      return;
    }
    requestedNotificationSelection.current = deploymentId;
    void bridge.select({ deploymentId }).catch((reason: unknown) => {
      setFormError(errorDetail(reason, "That place couldn’t be opened."));
    });
  }, [bridge, notificationTarget, snapshot]);

  if (loadError) {
    return <StartupFailure bare detail={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />;
  }
  if (!snapshot || !places) return <DesktopLoadingScreen />;
  return <DesktopPlacesProvider value={places}>{surface(snapshot, places)}</DesktopPlacesProvider>;

  function surface(snapshot: DeploymentAccessSnapshot, places: DesktopPlaces) {
    const presentation = desktopAccessPresentationFromSnapshot(snapshot);
    const activeScreen = screen;
    const busy =
      connectingPrivate ||
      snapshot.account.status === "authorizing" ||
      selectedConnection?.status === "authorizing" ||
      selectedConnection?.status === "connecting";
    const operationError = selectedConnection?.failure?.detail ?? formError;
    const directoryError = snapshot.directoryFailure?.detail ?? null;
    const personalLoadFailure =
      snapshot.personalSetup?.deploymentId === null &&
      snapshot.personalSetup.state === "repair-required" &&
      snapshot.personalSetup.issue !== null
        ? snapshot.personalSetup.issue.detail
        : null;
    const runBridgeOperation = (operation: Promise<unknown>) => {
      void operation.catch((reason: unknown) =>
        setFormError(errorDetail(reason, "The desktop operation could not be completed.")),
      );
    };

    if (
      personalLoadFailure &&
      screen !== "add-deployment" &&
      snapshot.account.status !== "signed-in"
    ) {
      return (
        <DesktopPersonalLoadFailure
          accountAvailable={snapshot.account.available}
          detail={personalLoadFailure}
          onAccount={() => runBridgeOperation(bridge.signIn())}
          onAddDeployment={() => setScreen("add-deployment")}
        />
      );
    }

    if (presentation === "personal") {
      return (
        <DesktopPersonalSetup
          actionError={snapshot.personalSetup?.issue?.detail ?? operationError}
          onBack={() => runBridgeOperation(bridge.cancel())}
          onRetry={() => runBridgeOperation(bridge.retry())}
          requestPending={busy}
          status={
            snapshot.personalSetup ?? {
              canStart: false,
              components: {
                browser: { state: "starting", version: null },
                host: { state: "starting", version: null },
                messaging: { state: "starting", version: null },
                postgresql: { state: "starting", version: null },
                runner: { state: "starting", version: null },
              },
              deploymentId: selected?.id ?? null,
              environmentId: null,
              issue: null,
              schemaVersion: 1,
              state: "starting",
              step: "checking-computer",
            }
          }
        />
      );
    }

    if (selected && presentation === "verified") {
      return (
        <DesktopVerifiedDeployment
          authorizing={selectedConnection?.status === "authorizing"}
          deployment={selected}
          error={operationError}
          onBack={() => runBridgeOperation(bridge.cancel())}
          onContinue={() =>
            runBridgeOperation(
              selectedConnection?.availableActions.includes("retry")
                ? bridge.retry()
                : bridge.select({ deploymentId: selected.id }),
            )
          }
        />
      );
    }

    if (presentation === "blocked" && selectedConnection?.failure) {
      const recovery = blockedConnectionRecovery(selectedConnection);
      return (
        <StartupFailure
          bare
          detail={selectedConnection.failure.detail}
          onRetry={() =>
            runBridgeOperation(recovery.action === "retry" ? bridge.retry() : bridge.cancel())
          }
          retryLabel={recovery.label}
        />
      );
    }

    if (activeScreen === "add-deployment") {
      return (
        <AddDeployment
          accountEmail={snapshot.account.email ?? null}
          busy={busy}
          error={operationError}
          onBack={() => setScreen(null)}
          onConnect={(input) => {
            setConnectingPrivate(true);
            setFormError(null);
            void bridge
              .connectPrivate(input)
              .catch((reason: unknown) =>
                setFormError(
                  errorDetail(
                    reason,
                    "That couldn’t be connected. Check the address and try again.",
                  ),
                ),
              )
              .finally(() => setConnectingPrivate(false));
          }}
          onCreateCloud={
            cloudLoadedFor === accountSessionKey && cloudAvailable
              ? () => setScreen("cloud-deployments")
              : null
          }
          onCreatePersonal={
            snapshot.personalSetup?.deploymentId === null &&
            snapshot.personalSetup.state === "stopped" &&
            snapshot.personalSetup.canStart
              ? () => {
                  setScreen(null);
                  runBridgeOperation(bridge.createPersonalDeployment());
                }
              : null
          }
          onManageCloud={
            cloudLoadedFor === accountSessionKey && cloudOperations.length > 0
              ? () => setScreen("cloud-deployments")
              : null
          }
          onSignIn={
            snapshot.account.available && snapshot.account.status !== "signed-in"
              ? () => runBridgeOperation(bridge.signIn())
              : null
          }
        />
      );
    }

    if (activeScreen === "cloud-deployments") {
      const refreshCloud = async () => {
        const requestedFor = accountSessionKey;
        const result = await bridge.listCloudDeployments();
        if (accountSessionKeyRef.current !== requestedFor) return;
        cloudOperationsRef.current = result.deployments;
        setCloudAvailable(result.available);
        setCloudOperations(result.deployments);
        if (result.deployments.some(({ status }) => status === "ready" || status === "deleted")) {
          await bridge.refreshDirectory();
        }
      };
      return (
        <CloudDeploymentFlow
          available={cloudLoadedFor === accountSessionKey && cloudAvailable}
          error={cloudError}
          onBack={() => setScreen(null)}
          onCreate={async (name) => {
            const requestedFor = accountSessionKey;
            const attempt =
              createCloudAttempt.current?.name === name
                ? createCloudAttempt.current
                : { name, operationId: crypto.randomUUID() };
            createCloudAttempt.current = attempt;
            await bridge.createCloudDeployment(attempt);
            if (accountSessionKeyRef.current !== requestedFor) return;
            createCloudAttempt.current = null;
            await refreshCloud();
          }}
          onDelete={async (operationId, name) => {
            const requestedFor = accountSessionKey;
            await bridge.deleteCloudDeployment({ operationId, name });
            if (accountSessionKeyRef.current !== requestedFor) return;
            await refreshCloud();
          }}
          onOpen={async (deploymentId) => {
            const requestedFor = accountSessionKey;
            await bridge.refreshDirectory();
            if (accountSessionKeyRef.current !== requestedFor) return;
            await bridge.select({ deploymentId });
          }}
          onRetry={async (operationId) => {
            const requestedFor = accountSessionKey;
            await bridge.retryCloudDeployment({ operationId });
            if (accountSessionKeyRef.current !== requestedFor) return;
            await refreshCloud();
          }}
          operations={cloudLoadedFor === accountSessionKey ? cloudOperations : []}
        />
      );
    }

    if (presentation === "picker" || !selected) {
      const setup = snapshot.personalSetup;
      const canSetUpHere =
        setup?.deploymentId === null && setup.state === "stopped" && setup.canStart;
      const setUpHere = canSetUpHere
        ? () => {
            setScreen(null);
            runBridgeOperation(bridge.createPersonalDeployment());
          }
        : null;
      if (snapshot.deployments.length === 0 && snapshot.unavailable.length === 0) {
        return (
          <DesktopWelcome
            error={operationError ?? directoryError ?? personalLoadFailure}
            onAdd={() => setScreen("add-deployment")}
            onStart={setUpHere}
            places={places}
          />
        );
      }
      const notice = chooserNotice(selectedConnection, snapshot.account, bridge);
      return (
        <DesktopPlaceChooser
          // A notice already says why the place it names could not open; its
          // attempt's own failure would only say it again.
          error={notice ? formError : (operationError ?? directoryError ?? personalLoadFailure)}
          notice={notice}
          onSetUpThisComputer={setUpHere}
          places={places}
        />
      );
    }

    if (selectedConnection?.status !== "connected" || !hostClient) {
      return (
        <DesktopLoadingScreen
          error={operationError}
          onCancel={
            selectedConnection?.availableActions.includes("cancel")
              ? () => runBridgeOperation(bridge.cancel())
              : null
          }
        />
      );
    }

    return (
      <Suspense fallback={<DesktopLoadingScreen />}>
        <SignedInApp
          deploymentAccess={snapshot}
          desktopBridge={bridge}
          desktopDeployment={selected}
          hostClient={hostClient}
          key={`${selected.id}:${selected.activeOrigin}`}
          onNotificationTargetOpened={() => setNotificationTarget(null)}
          // Handed over only for the Deployment it names, so no foreign id ever
          // reaches a Host that did not issue it.
          notificationTarget={
            notificationTarget?.deploymentId === selected.id ? notificationTarget : null
          }
        />
      </Suspense>
    );
  }
}

/**
 * What the list of places says above itself when the place a person was in
 * cannot open: an Account place waiting on a sign-in that ended, or a place
 * that is not reachable right now. Each names the one move that helps.
 */
export function chooserNotice(
  selected: DeploymentAccessDeployment | undefined,
  account: DeploymentAccessSnapshot["account"],
  bridge: Pick<OpensteerDesktopBridge, "cancel" | "checkDeployments" | "signIn">,
): {
  readonly action: {
    readonly label: string;
    readonly quiet?: boolean;
    readonly run: () => Promise<void>;
  } | null;
  readonly body: string | null;
  readonly signIn: boolean;
  readonly title: string;
} | null {
  if (!selected) return null;
  if (selected.source === "account" && account.status !== "signed-in") {
    if (account.status === "authorizing") {
      return {
        // A browser tab can be closed without a word reaching this window, so
        // the wait always has a way out.
        action: { label: "Cancel", quiet: true, run: () => bridge.cancel() },
        body: "Finish signing in in your browser. This window continues by itself.",
        signIn: true,
        title: `Signing in to open ${selected.name}`,
      };
    }
    return {
      action: account.available ? { label: "Sign in again", run: () => bridge.signIn() } : null,
      body: `Your sign-in on this computer ended. Your work on ${selected.name} is safe and still running.`,
      signIn: true,
      title: `Sign in again to keep using ${selected.name}`,
    };
  }
  if (selected.status === "needs-remote-access" || selected.statusInfo.status === "offline") {
    return {
      action: { label: "Check again", run: () => bridge.checkDeployments() },
      body: selected.statusInfo.reason,
      signIn: false,
      title: `${selected.name} isn’t available right now`,
    };
  }
  return null;
}

function errorDetail(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

export function blockedConnectionRecovery(
  deployment: Pick<DeploymentAccessDeployment, "availableActions">,
): { readonly action: "cancel" | "retry"; readonly label: string } {
  return deployment.availableActions.includes("retry")
    ? { action: "retry", label: "Try again" }
    : { action: "cancel", label: "Choose another place" };
}

export function cloudResultBelongsToAccount(
  requestedFor: string | null,
  currentAccount: string | null,
): boolean {
  return requestedFor !== null && requestedFor === currentAccount;
}

export function cloudDeletionDisappeared(
  previous: readonly CloudDeploymentOperation[],
  next: readonly CloudDeploymentOperation[],
): boolean {
  const presentIds = new Set(next.map(({ operationId }) => operationId));
  return previous.some(
    ({ desiredState, operationId, status }) =>
      (desiredState === "deleted" || status === "deleting") && !presentIds.has(operationId),
  );
}
