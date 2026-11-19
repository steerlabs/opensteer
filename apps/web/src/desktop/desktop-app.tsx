import { deploymentPolicy } from "@opensteer/core";
import type { AgentConnectionAuthorizationTarget } from "@opensteer/protocol";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type {
  DeploymentAccessDeployment,
  DeploymentAccessSnapshot,
  DesktopDeploymentSummary,
  DesktopNotificationTarget,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import {
  DesktopLoadingScreen,
  DesktopPersonalSetup,
  DesktopPersonalLoadFailure,
  DesktopVerifiedDeployment,
} from "../components/desktop-onboarding.js";
import {
  DesktopChooser,
  DesktopConnect,
  DesktopWelcome,
  type ConnectKind,
} from "../components/places/desktop-entry.js";
import { DeviceRemovedScreen, DeviceSignInScreen } from "../components/devices/device-removed.js";
import { membershipRecord } from "../components/devices/this-device.js";
import { observeLocalExecutionStatus } from "./local-execution-status.js";
import { DesktopPlacesProvider, type DesktopPlaces } from "./places-context.js";
import { ComputerFactsStore, readComputerFacts } from "./computer-facts.js";
import { thisComputerLabel } from "./places.js";
import { pendingSetupStep } from "../components/first-run/setup-memory.js";
import { SetupOpening } from "../components/first-run/setup-opening.js";
import { StartupFailure } from "../components/onboarding-card.js";
import { StartFreshScreen } from "../components/start-fresh-screen.js";
import { useStartFresh } from "./start-fresh.js";
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
import { disposeMessageOutbox } from "@opensteer/client/host";
import { ConnectionGateView } from "../components/connection-shell.js";
import { useClientConnectionEverReady } from "@opensteer/client/react";
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
type BrowsingScreen = ConnectKind | null;

type DesktopAccessPresentation =
  "blocked" | "personal" | "picker" | "ready" | "verified" | "waiting";

export function desktopAccessPresentationFromSnapshot(
  snapshot: DeploymentAccessSnapshot,
): DesktopAccessPresentation {
  const selected = snapshot.deployments.find(({ id }) => id === snapshot.selectedDeploymentId);
  if (personalSetupShowing(snapshot.personalSetup, snapshot.deployments, selected))
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

/**
 * Setting up this computer stays on screen until its own Opensteer is listed
 * and attaching. The supervisor names the Deployment long before it is
 * listed, and the list adds it before it attaches; neither is a reason to
 * show the screens from before setup began. Until it is listed, a setup that
 * fails keeps its own screen too: nothing else here can try it again.
 */
function personalSetupShowing(
  setup: DeploymentAccessSnapshot["personalSetup"],
  deployments: DeploymentAccessSnapshot["deployments"],
  selected: DeploymentAccessSnapshot["deployments"][number] | undefined,
): boolean {
  if (!setup) return false;
  if (setup.deploymentId === null)
    return setup.state !== "stopped" && setup.state !== "repair-required";
  if (!deployments.some(({ id }) => id === setup.deploymentId)) return !selected;
  // Main holds this computer's attachment while its Host restarts, and the
  // restart's own progress and Try again belong on screen until it is back.
  if (setup.state === "degraded")
    return selected?.id === setup.deploymentId && selected.status === "connecting";
  if (setup.state !== "checking" && setup.state !== "starting") return false;
  return !selected || (selected.id === setup.deploymentId && selected.status === "idle");
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
  const [passkeyMode, setPasskeyMode] = useState<"native" | "notice" | null>(null);
  useEffect(() => {
    let live = true;
    void (bridge.passkeys?.available() ?? Promise.resolve(false)).then(
      (available) => {
        if (live) setPasskeyMode(available ? "native" : "notice");
      },
      () => {
        if (live) setPasskeyMode("notice");
      },
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const [snapshot, setSnapshot] = useState<DeploymentAccessSnapshot | null>(null);
  // This app's own record of its places could not be read from Electron main.
  const [accessUnreadable, setAccessUnreadable] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [screen, setScreen] = useState<BrowsingScreen>(null);
  const [chooserFor, setChooserFor] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [connectingPrivate, setConnectingPrivate] = useState(false);
  // This window set this computer up, so setup carries on into the app it
  // opens. A later launch resumes only a setup left unfinished; after that,
  // setup stays one menu away.
  const [settingUpHere, setSettingUpHere] = useState(false);
  // Data an earlier Opensteer left, which this one can't open: offered a fresh
  // start until the person chooses another way on ("Not now").
  const startFresh = useStartFresh(bridge, snapshot?.personalSetup?.state === "repair-required");
  const [startFreshDeclined, setStartFreshDeclined] = useState(false);
  // The notification that was clicked. It names one Deployment, which this
  // window may not be showing, so it waits here — through the selection and any
  // sign-in that follows — until the app for that Deployment can open it.
  const [mcpAuthorization, setMcpAuthorization] =
    useState<AgentConnectionAuthorizationTarget | null>(null);
  const requestedMcpSelection = useRef<string | null>(null);
  useEffect(
    () =>
      bridge.onMcpAuthorization?.((target) => {
        requestedMcpSelection.current = null;
        setMcpAuthorization(target);
        setScreen(null);
      }),
    [bridge],
  );
  useEffect(() => {
    if (!mcpAuthorization || !snapshot) return;
    const id = mcpAuthorization.deploymentId;
    if (!snapshot.deployments.some((deployment) => deployment.id === id)) {
      setMcpAuthorization(null);
      return;
    }
    if (snapshot.selectedDeploymentId === id || requestedMcpSelection.current === id) return;
    requestedMcpSelection.current = id;
    void bridge
      .select({ deploymentId: id })
      .catch(() => setFormError("That Opensteer could not be opened."));
  }, [bridge, mcpAuthorization, snapshot]);
  const [notificationTarget, setNotificationTarget] = useState<DesktopNotificationTarget | null>(
    null,
  );
  const requestedNotificationSelection = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAccessUnreadable(false);
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
      .catch(() => {
        if (!cancelled) setAccessUnreadable(true);
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
  // A Mac removed from the Opensteer on screen shows that before anything
  // signs in again, whichever arrived first: the session ending or the 4010.
  const [membership, setMembership] = useState<DesktopLocalExecutionStatus | null>(null);
  const membershipDeploymentId =
    selected &&
    deploymentPolicy({ kind: selected.kind }).services.personal &&
    !selected.onThisComputer
      ? selected.id
      : null;
  useEffect(() => {
    setMembership(null);
    if (!membershipDeploymentId) return;
    return observeLocalExecutionStatus(bridge, membershipDeploymentId, setMembership, () =>
      setMembership(null),
    );
  }, [bridge, membershipDeploymentId]);
  const removedHere =
    membershipDeploymentId !== null &&
    membership?.deploymentId === membershipDeploymentId &&
    (membershipRecord(membership)?.state === "removed" ||
      membershipRecord(membership)?.state === "leaving");
  const hostTransportIdentity = JSON.stringify([
    desktopHostTransportIdentity(selected),
    selectedConnection?.attachmentKey,
    selectedConnection?.capabilities,
  ]);
  // Main attaches this computer's own Host once its supervisor says it can own
  // a session; a window connecting first races that attach and the Host's start.
  // Admission holds while the identity does, so status changes keep the client,
  // and ends when it moves: a restarted Host can come back as the same identity.
  const [admittedIdentity, setAdmittedIdentity] = useState<string | null>(null);
  const admits = !selected?.onThisComputer || selectedConnection?.status === "connected";
  if (admittedIdentity !== hostTransportIdentity && (admits || admittedIdentity !== null))
    setAdmittedIdentity(admits ? hostTransportIdentity : null);
  const hostClient = useMemo(() => {
    if (!selected || passkeyMode === null || admittedIdentity !== hostTransportIdentity)
      return null;
    return createBrowserHostClient({
      desktopMedia: true,
      ...(selectedConnection?.authorityKey
        ? { authorityKey: selectedConnection.authorityKey }
        : {}),
      presentation: {
        name: selected.name,
        target: "computer",
        route: selected.onThisComputer
          ? "same-computer"
          : selected.access === "connect"
            ? "connect"
            : "private-network",
      },
      passkeys: {
        mode: passkeyMode,
        present: async (requestId) => {
          if (!bridge.passkeys) throw new Error("Native passkeys are unavailable.");
          await bridge.passkeys.present({ requestId });
        },
      },
      ...(bridge.iphoneSetup ? { iphoneSetup: bridge.iphoneSetup } : {}),
      baseUrl: selected.canonicalOrigin,
      capabilities: selectedConnection?.capabilities ?? null,
      fetch: createDesktopHostFetch(bridge, selected.canonicalOrigin, selected.id),
      pacedUploads: true,
      // Desktop main holds the sockets; hiding or covering the window never closes them.
      lifecycle: browserClientLifecycle({ socketTrustWindowMs: Number.POSITIVE_INFINITY }),
      webSocketFactory: createDesktopHostWebSocketFactory(
        bridge,
        selected.canonicalOrigin,
        selected.id,
      ),
    });
  }, [admittedIdentity, bridge, hostTransportIdentity, passkeyMode]);

  // Only whether this window's connection was ever ready; the surface never redraws per publish.
  const everReady = useClientConnectionEverReady(hostClient?.connection ?? null);
  useEffect(
    () => () => {
      if (!hostClient) return;
      disposeMessageOutbox(hostClient);
      hostClient.dispose();
    },
    [hostClient],
  );

  const facts = useMemo(
    () => new ComputerFactsStore((computer) => readComputerFacts(bridge, computer)),
    [bridge],
  );
  const places = useMemo<DesktopPlaces | null>(
    () =>
      snapshot
        ? {
            bridge: {
              ...bridge,
              select: async (input) => {
                setChooserFor(null);
                await bridge.select(input);
              },
            },
            facts,
            onAddPlace: () => setScreen("pairing"),
            snapshot,
          }
        : null,
    [bridge, facts, snapshot],
  );

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
    void bridge.select({ deploymentId }).catch(() => {
      setFormError("That place couldn’t be opened.");
    });
  }, [bridge, notificationTarget, snapshot]);

  if (accessUnreadable) {
    return (
      <StartupFailure
        bare
        detail="Opensteer couldn’t open its list of places."
        onRetry={() => setLoadAttempt((n) => n + 1)}
      />
    );
  }
  if (!snapshot || !places) return <DesktopLoadingScreen />;
  return <DesktopPlacesProvider value={places}>{surface(snapshot, places)}</DesktopPlacesProvider>;

  function surface(snapshot: DeploymentAccessSnapshot, places: DesktopPlaces) {
    const choosing = chooserFor !== null && chooserFor === selected?.id;
    const presentation = choosing
      ? "picker"
      : everReady
        ? "ready"
        : desktopAccessPresentationFromSnapshot(snapshot);
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
      void operation.catch(() => setFormError("That didn’t work. Try again."));
    };

    const fresh = startFresh.state;
    if (fresh.phase === "checking") return <DesktopLoadingScreen />;
    if ((fresh.phase === "offer" && !startFreshDeclined) || fresh.phase === "starting") {
      return (
        <StartFreshScreen
          error={fresh.phase === "offer" ? fresh.error : null}
          moves={fresh.data.entries}
          onNotNow={() => setStartFreshDeclined(true)}
          onStartFresh={startFresh.startFresh}
          working={fresh.phase === "starting"}
        />
      );
    }

    if (selected && removedHere && !choosing) {
      return (
        <DeviceRemovedScreen
          bridge={bridge}
          deploymentId={selected.id}
          name={selected.name}
          onConnectAgain={async () => {
            setMembership(await bridge.getLocalExecutionStatus({ deploymentId: selected.id }));
          }}
          unconfirmed={membership?.membership?.leaveUnconfirmed === true}
          detail={membership?.runner.detail}
          onChoose={() => setChooserFor(selected.id)}
        />
      );
    }

    if (
      selected &&
      !choosing &&
      membership?.membership?.state === "active" &&
      (membership.membership.sessionState === "confirming" ||
        membership.membership.sessionState === "sign-in-again" ||
        selectedConnection?.status === "needs-sign-in")
    ) {
      return (
        <DeviceSignInScreen
          bridge={bridge}
          deploymentId={selected.id}
          name={selected.name}
          confirming={membership.membership.sessionState === "confirming"}
          detail={membership.runner.detail}
          onChoose={() => setChooserFor(selected.id)}
        />
      );
    }

    if (personalLoadFailure && screen === null && snapshot.account.status !== "signed-in") {
      return (
        <DesktopPersonalLoadFailure
          accountAvailable={snapshot.account.available}
          detail={personalLoadFailure}
          onAccount={() => runBridgeOperation(bridge.signIn())}
          onAddDeployment={() => setScreen("pairing")}
        />
      );
    }

    if (presentation === "personal") {
      // Before the list has this computer's Deployment, setting up again is
      // how it is retried, and there is no attempt for Back to cancel.
      const listed = snapshot.deployments.some(
        ({ id }) => id === snapshot.personalSetup?.deploymentId,
      );
      return (
        <DesktopPersonalSetup
          actionError={snapshot.personalSetup?.issue?.detail ?? operationError}
          computerName={snapshot.personalSetup?.name ?? selected?.name ?? thisComputerLabel()}
          firstRun={settingUpHere}
          onBack={listed ? () => runBridgeOperation(bridge.cancel()) : undefined}
          onRetry={() =>
            runBridgeOperation(listed ? bridge.retry() : bridge.createPersonalDeployment({}))
          }
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

    // A place this app couldn't reach yet keeps trying through its own
    // connection, which explains itself on the shared clock; only a refusal is
    // final enough for main's own words.
    const otherComputers =
      snapshot.deployments.length > 1
        ? { label: "Other computers", onPress: () => selected && setChooserFor(selected.id) }
        : null;
    if (
      presentation === "blocked" &&
      selectedConnection?.failure?.retryable &&
      hostClient &&
      activeScreen === null
    )
      return (
        <ConnectionGateView
          connection={hostClient.connection}
          scope="app"
          secondary={otherComputers}
        />
      );
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

    if (activeScreen !== null) {
      return (
        <DesktopConnect
          busy={busy}
          error={operationError}
          kind={activeScreen}
          onBack={() => setScreen(null)}
          onConnect={(input) => {
            setConnectingPrivate(true);
            setFormError(null);
            void bridge
              .connectPrivate(input)
              .catch(() =>
                setFormError("That couldn’t be connected. Check the address and try again."),
              )
              .finally(() => setConnectingPrivate(false));
          }}
        />
      );
    }

    if (presentation === "picker" || !selected) {
      const setup = snapshot.personalSetup;
      const canSetUpHere =
        setup?.deploymentId === null && setup.state === "stopped" && setup.canStart;
      const setUpHere = canSetUpHere
        ? (name?: string) => {
            setScreen(null);
            setSettingUpHere(true);
            runBridgeOperation(bridge.createPersonalDeployment(name ? { name } : {}));
          }
        : null;
      if (snapshot.deployments.length === 0 && snapshot.unavailable.length === 0) {
        return (
          <DesktopWelcome
            error={operationError ?? directoryError ?? personalLoadFailure}
            onConnect={setScreen}
            onSetUpHere={setUpHere}
            places={places}
          />
        );
      }
      const notice = chooserNotice(
        selectedConnection ?? placeAwaitingSignIn(snapshot),
        snapshot,
        bridge,
      );
      return (
        <DesktopChooser
          // A notice already says why the place it names could not open; its
          // attempt's own failure would only say it again.
          error={notice ? formError : (operationError ?? directoryError ?? personalLoadFailure)}
          notice={notice}
          onConnect={setScreen}
          onSetUpHere={setUpHere}
          places={places}
        />
      );
    }

    const opening = settingUpHere ? <SetupOpening /> : null;
    if (!hostClient || (!everReady && selectedConnection?.status !== "connected")) {
      if (opening && !operationError) return opening;
      // Main's own first attempt can still be cancelled; once it has
      // answered, this window's connection explains itself on the shared clock.
      if (hostClient && !operationError && selectedConnection?.status !== "connecting")
        return (
          <ConnectionGateView
            connection={hostClient.connection}
            scope="app"
            secondary={otherComputers}
          />
        );
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
      <Suspense fallback={opening ?? <DesktopLoadingScreen />}>
        <SignedInApp
          mcpAuthorizationRequestId={
            mcpAuthorization?.deploymentId === selected.id ? mcpAuthorization.requestId : null
          }
          onMcpAuthorizationClosed={() => {
            const requestId = mcpAuthorization?.requestId;
            setMcpAuthorization((current) => (current?.requestId === requestId ? null : current));
            if (requestId) void bridge.dismissMcpAuthorization?.(requestId).catch(() => undefined);
          }}
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
          onSetupOpened={() => setSettingUpHere(false)}
          // Right after this computer is set up, and on every later launch
          // until the person finishes the setup they started.
          openSetup={
            (settingUpHere || pendingSetupStep(selected.id) !== null) &&
            selected.kind === "personal" &&
            selected.onThisComputer
          }
        />
      </Suspense>
    );
  }
}

/**
 * With nothing selected, the one Account place still listed while signed out.
 * Main keeps such a place listed only because this computer joined it, so the
 * sign-in that reopens it is the move to offer.
 */
export function placeAwaitingSignIn(
  snapshot: DeploymentAccessSnapshot,
): DeploymentAccessDeployment | undefined {
  if (snapshot.selectedDeploymentId !== null || snapshot.account.status === "signed-in") return;
  const waiting = snapshot.deployments.filter(({ source }) => source === "account");
  return waiting.length === 1 ? waiting[0] : undefined;
}

/**
 * What the list of places says above itself when the place a person was in
 * cannot open: an Account place waiting on a sign-in that ended, or a place
 * that is not reachable right now. Each names the one move that helps.
 */
export function chooserNotice(
  place: DeploymentAccessDeployment | undefined,
  snapshot: Pick<DeploymentAccessSnapshot, "account" | "selectedDeploymentId">,
  bridge: Pick<OpensteerDesktopBridge, "cancel" | "checkDeployments" | "select" | "signIn">,
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
  const { account } = snapshot;
  if (account.status === "authorizing") {
    return {
      // A browser tab can be closed without a word reaching this window, so
      // the wait always has a way out.
      action: { label: "Cancel", quiet: true, run: () => bridge.cancel() },
      body: "Finish signing in in your browser. This window continues by itself.",
      signIn: true,
      title: place?.source === "account" ? `Signing in to open ${place.name}` : "Signing in",
    };
  }
  if (!place) return null;
  if (place.source === "account" && account.status !== "signed-in") {
    // Selecting first is what lets the sign-in reopen this place by itself.
    const signIn = async () => {
      if (snapshot.selectedDeploymentId !== place.id)
        await bridge.select({ deploymentId: place.id });
      await bridge.signIn();
    };
    return {
      action: account.available ? { label: "Sign in again", run: signIn } : null,
      body: `Your sign-in on this computer ended. Your work on ${place.name} is safe and still running.`,
      signIn: true,
      title: `Sign in again to keep using ${place.name}`,
    };
  }
  if (place.status === "needs-remote-access" || place.statusInfo.status === "offline") {
    return {
      action: { label: "Check again", run: () => bridge.checkDeployments() },
      body: place.statusInfo.reason,
      signIn: false,
      title: `${place.name} isn’t available right now`,
    };
  }
  return null;
}

export function blockedConnectionRecovery(
  deployment: Pick<DeploymentAccessDeployment, "availableActions">,
): { readonly action: "cancel" | "retry"; readonly label: string } {
  return deployment.availableActions.includes("retry")
    ? { action: "retry", label: "Try again" }
    : { action: "cancel", label: "Choose another place" };
}
