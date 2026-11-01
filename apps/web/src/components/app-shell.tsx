import { autoPlacePart } from "./workspace/composer-context.js";
import { destinationPlaceKey } from "./workspace/navigation.js";
import { useBrowserTabStrip } from "@opensteer/client/react";
import { DesktopWebLinkDeliverySchema } from "@opensteer/protocol/desktop";
import { VoiceContext, VoiceIsland, useVoiceRuntime } from "./voice.js";
import { useDictation } from "./dictation.js";
import {
  desktopWebLinksReady,
  openDesktopWebLink,
  receiveDesktopWebLinks,
  webLinkSelection,
  type WebLinkFailureActions,
} from "../desktop/web-links.js";
import { lastBrowsingChoice, openWorkspaceWebLink } from "./workspace/start-page.js";
import { DownloadFeedback } from "./browser/browser-downloads.js";
import { provisionalThreadTitle } from "@opensteer/core";
import { useNativeBrowserOverlay } from "./native-browser-overlays.js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import {
  DesktopNotificationTargetSchema,
  DesktopUseComputerViewInputSchema,
  type DeploymentAccessSnapshot,
  type DesktopDeploymentSummary,
  type DesktopLocalExecutionStatus,
  type DesktopNotificationTarget,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import {
  type ExecutionPreferences,
  type ThreadAccessMode,
  type WorkspaceIconName,
} from "@opensteer/core";
import { actionErrorMessage, conversationPath, fromLivePage, useMediaQuery } from "../ui-utils.js";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { observeLocalExecutionStatus } from "../desktop/local-execution-status.js";
import { onNotificationActivated, showNotification } from "../desktop/notifications.js";
import { isReadingThread } from "./thread-reading.js";
import {
  canRespondToRequests,
  defaultThreadPlacement,
  mutationIdempotencyKey,
  reviewHostAction,
  sameStableHostSnapshot,
  threadPlacementOptions,
  unwrapRpcResult,
  type ExecutionChoice,
  type ExecutionSelection,
  type PendingBrowserTabDestination,
  type WorkspaceSurfaceDestination,
  type HostClient,
  type HostSnapshot,
  type LocalRunnerIdentity,
  type ThreadPlacementOption,
  type ThreadSummary,
  taskAttention,
  heldThread,
  taskUnderWay,
} from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { useActionReview, useHostSelector } from "@opensteer/client/react";
import type { ComposerQuote, PendingSubmission } from "./composer.js";
import {
  claimFirstMessage,
  pendingScopeUnavailable,
  pendingStorageAvailable,
  pendingStorageUnavailable,
} from "./pending-sends.js";
import { Sidebar, type SidebarProps } from "./sidebar.js";
import { SidebarChromeProvider } from "./sidebar-chrome.js";
import { useChromeConnectEnvironment } from "./chrome/chrome-environment.js";
import { selectedDeploymentFrom } from "../desktop/desktop-deployment-selection.js";
import {
  WorkspaceProvider,
  drawerQuery,
  type LocalMachine,
} from "./workspace/workspace-context.js";
import { WorkspaceLayout } from "./workspace/workspace-layout.js";
import { AppIconProvider } from "./computer-apps/app-icons.js";
import { PlaceStage } from "./workspace/place-stage.js";
import { usePlaceSuccession } from "./workspace/place-succession.js";
import { TabCloserProvider } from "./workspace/tab-closer.js";
import { ShortcutsHelp, useWorkspaceShortcuts } from "./workspace/shortcuts.js";
import { useNewTab } from "./workspace/start-page.js";
import {
  canonicalPlaceSearch,
  isSettingsPath,
  placeSelection,
  rememberPlace,
  rememberedPlace,
  rememberedNewTab,
  rememberedTalk,
  rememberNewTab,
  useWorkspaceNavigation,
} from "./workspace/navigation.js";
import { DeploymentOperationBanner } from "./deployment-operation.js";
import { Icon } from "./icon.js";
import { NewWorkspaceDialog, type NewWorkspaceStorageChoice } from "./new-workspace-dialog.js";
import {
  PaneResizeHandle,
  usePersistedPaneSize,
  type PaneSizeRange,
} from "./pane-resize-handle.js";
import { WorkspaceSharingDialog } from "./workspace-sharing-dialog.js";
import { HarnessAuthenticationDialog } from "./harness-authentication-dialog.js";
import { useToast } from "./toast.js";

export interface ShellContext {
  actionError: string | null;
  /**
   * Quotes an update into Chat's composer and goes there. It never sends, and
   * never changes who the reply addresses: a report from Email is still
   * answered to Opensteer, in Chat.
   */
  askOpensteerAbout: (quote: ComposerQuote) => void;
  clearActionError: () => void;
  /** Taken once, by Home's composer, so a later visit starts from its own draft. */
  clearHomeHandoff: () => void;
  /**
   * What was written into Home before Home existed. Creation replaces one
   * composer with another; the words must not be what that costs.
   */
  homeDraft: string;
  setHomeDraft: (draft: string) => void;
  /**
   * The Home conversation, once the Host has one. Null before the first valid
   * execution choice creates it — the Home route then shows a real empty
   * composer, not a Thread that does not exist.
   */
  homeThreadId: string | null;
  /** Words or a quote handed to Home's composer from elsewhere, to land focused and unsent. */
  homeHandoff: {
    readonly key: number;
    readonly quote?: ComposerQuote;
    readonly text: string;
  } | null;
  /**
   * Writes a request into Home's composer and goes there. It never sends: the
   * person reads it, changes it if they like, and sends it themselves.
   */
  writeInChat: (text: string) => void;
  /**
   * Starts a Thread and keeps its first message, words and files, for that
   * Thread's composer to send when it opens. Null when either failed; the
   * reason is in `actionError`.
   */
  createThreadAndSend: (
    workspaceId: string,
    message: PendingSubmission,
    selection: ExecutionSelection,
    accessMode: ThreadAccessMode,
  ) => Promise<ThreadSummary | null>;
  defaultPlacement: ThreadPlacementOption | undefined;
  /**
   * The Desktop's deployment-access state, already filtered by one revision
   * guard at the app root. Every surface that needs it reads a selector from
   * this one value rather than opening its own subscription, so two sections of
   * one page can never disagree about which snapshot they are describing.
   * Null in a browser, where there is no Desktop to ask.
   */
  deploymentAccess: DeploymentAccessSnapshot | null;
  desktopBridge: OpensteerDesktopBridge | null;
  desktopDeployment: DesktopDeploymentSummary | null;
  /**
   * The one live read of the local execution preferences. Every surface that
   * seeds a selection from them or writes one back goes through this pair, so
   * two composers on one screen can never disagree about what was last used.
   */
  executionPreferences: ExecutionPreferences;
  hostClient: HostClient;
  localExecutionStatus: DesktopLocalExecutionStatus | null;
  localExecutionAction: LocalExecutionAction | null;
  localExecutionError: string | null;
  /** Returns from Settings to the workspace address left behind, or Home if opened there. */
  leaveSettings: () => void;
  openMobileNavigation: () => void;
  /** Opens the dialog that creates a specialist. */
  openNewWorkspace: () => void;
  /**
   * Runs one action against this computer's Runner slot. It records the
   * message in `localExecutionError` and then rejects, so a caller with a
   * decision to make about the failure can see it; a caller with none may
   * ignore the rejection and let the page render that error.
   */
  performLocalExecutionAction: (action: LocalExecutionAction) => Promise<void>;
  openHarnessAuthentication: ((placement: ThreadPlacementOption) => void) | null;
  refreshHarnessCatalog: (placement: ThreadPlacementOption) => Promise<void>;
  openSharing: (workspaceId: string) => void;
  placements: ThreadPlacementOption[];
  rememberExecution: (choice: ExecutionChoice) => void;
  reportActionError: (error: unknown) => void;
  /** Marks shared Done or reopens a task; a refusal is reported here. */
  setTaskDone: (threadId: string, done: boolean) => void;
  snapshot: HostSnapshot;
}

/**
 * The three things a person does to this computer's membership of the viewed
 * Deployment, and the PortableFS setup steps that sit beside them.
 *
 * Adding and removing are the only operations that touch identity; running
 * agents is a restart with the other module set, and never a second
 * enrollment. Each carries what it needs, so no caller has to remember which
 * of two positional arguments a given action reads.
 */
export type LocalExecutionAction =
  | { readonly kind: "acknowledge" | "install" | "open-setup" | "refresh" | "remove" }
  | { readonly kind: "add"; readonly name: string; readonly runAgents: boolean }
  | { readonly kind: "set-run-agents"; readonly runAgents: boolean };

/**
 * The Deployment whose local Runner slot this window supervises, if any.
 *
 * Every Deployment a desktop attaches to has a slot — a Personal one reached
 * over its access route can be joined as a reachable computer just like a
 * server. The one exception is the Personal Deployment hosted on this very
 * computer: there the local Runner is its Main, which the Deployment owns
 * rather than a computer anybody adds or removes.
 */
export function localRunnerSlotDeploymentId(input: {
  readonly desktopBridge: OpensteerDesktopBridge | null;
  readonly desktopDeployment: DesktopDeploymentSummary | null;
}): DesktopDeploymentSummary["id"] | null {
  const { desktopBridge, desktopDeployment } = input;
  if (desktopBridge === null || desktopDeployment === null) return null;
  if (desktopDeployment.kind === "personal" && desktopDeployment.onThisComputer) return null;
  return desktopDeployment.id;
}

/**
 * Takes this computer out of a Deployment, in the one order that is safe.
 *
 * The Host forgets it first, and closes its Runner's connection as revoked in
 * the same operation; only then does the desktop stop the Runner and clear the
 * slot. Stopping first would leave a computer that is still enrolled and no
 * longer running whenever the revoke is refused.
 *
 * Both steps throw rather than reporting a half-finished removal as a finished
 * one. A stop that fails after a successful revoke is still worth saying: the
 * desktop clears the slot itself once its Runner is refused as revoked, so
 * trying Remove again is the repair.
 */
export async function removeLocalComputer(input: {
  readonly bridge: Pick<OpensteerDesktopBridge, "stopLocalRunner">;
  readonly client: Pick<HostClient, "dispatch">;
  readonly deploymentId: DesktopDeploymentSummary["id"];
  /** Null while the slot holds no enrolled Runner, leaving only the stop. */
  readonly runnerId: string | null;
}): Promise<DesktopLocalExecutionStatus> {
  if (input.runnerId !== null) {
    const revoked = await input.client.dispatch({
      idempotencyKey: mutationIdempotencyKey("local-computer-remove"),
      machineId: input.runnerId,
      type: "machine.revoke",
    });
    if (revoked.type !== "machine.revoke") throw new Error("Computer removal did not complete.");
  }
  return input.bridge.stopLocalRunner({ deploymentId: input.deploymentId });
}

type ShellSharedContext = Omit<ShellContext, "snapshot">;

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

const sidebarCollapsedKey = "opensteer.sidebar-collapsed";
const sidebarWidthKey = "opensteer.sidebar-width";
const sidebarWidthRange: PaneSizeRange = {
  defaultValue: 248,
  max: 360,
  min: 224,
  step: 8,
};
const selectHostSnapshot = (snapshot: HostSnapshot) => snapshot;
/** Tasks that need the reader, each once: what the sidebar's count and the app's badge both say. */
const selectAttentionCount = (snapshot: HostSnapshot) => taskAttention(snapshot).length;

export function AppShell({
  deploymentAccess = null,
  desktopBridge: suppliedDesktopBridge = null,
  desktopDeployment = null,
  hostClient,
  loadError,
  onNotificationTargetOpened,
  notificationTarget = null,
}: {
  deploymentAccess?: DeploymentAccessSnapshot | null;
  desktopBridge?: OpensteerDesktopBridge | null;
  desktopDeployment?: DesktopDeploymentSummary | null;
  hostClient: HostClient;
  loadError: string | null;
  onNotificationTargetOpened?: (() => void) | undefined;
  /** A clicked Desktop notification, for this Deployment, waiting to be opened. */
  notificationTarget?: DesktopNotificationTarget | null;
}) {
  const snapshot = useHostSelector(hostClient, selectHostSnapshot, sameStableHostSnapshot);
  const attention = useHostSelector(hostClient, selectAttentionCount);
  const toast = useToast();
  const location = useLocation();
  const settingsMode = isSettingsPath(location.pathname);
  const nav = useWorkspaceNavigation(
    { deploymentId: snapshot.deploymentId, userId: snapshot.user?.id ?? null },
    snapshot.homeThreadId,
  );
  const openWebLink = useCallback(
    (address: string) => openWorkspaceWebLink(hostClient, nav, address, location.state),
    [hostClient, nav, location.state],
  );
  const routerNavigate = useNavigate();
  const { controller: dictation } = useDictation();
  const voicePlaces = useBrowserTabStrip(hostClient).ordered;
  const voice = useVoiceRuntime(
    hostClient,
    (target) => {
      if (target.kind === "back") void routerNavigate(-1);
      // Settings covers places, so a shown place opens over Chat instead.
      else if (target.kind === "place")
        if (settingsMode) nav.showPlaceWithConversation(target.destination, "/");
        else nav.showPlace(target.destination);
      else nav.openConversation(target.kind === "chat" ? "/" : nav.threadPath(target.threadId));
    },
    dictation,
    async () => {
      const selection = placeSelection(new URLSearchParams(location.search));
      const key = selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
      const part = await autoPlacePart(
        hostClient,
        voicePlaces.find((place) => place.key === key) ?? null,
      );
      return part ? [part] : [];
    },
    () => {
      // Pages such as Settings cover the conversation and any place behind them.
      if (settingsMode) return { title: "Settings" };
      const match = /^\/threads\/([^/]+)/.exec(location.pathname);
      if (!match && location.pathname !== "/")
        return { title: location.pathname.split("/")[1]?.replace(/-/g, " ") ?? "Opensteer" };
      const selection = placeSelection(new URLSearchParams(location.search));
      return {
        threadId: match ? decodeURIComponent(match[1]!) : (snapshot.homeThreadId ?? undefined),
        ...(selection.kind === "place" ? { destination: selection.destination } : {}),
      };
    },
  );
  useEffect(() => {
    voice?.refreshContext();
  }, [voice, location.key]);
  const webLinkNavigation = useRef(nav);
  webLinkNavigation.current = nav;
  const webLinkView = useRef({
    key: location.key,
    revision: 0,
    changedAt: 0,
    pendingBrowserTab: new URLSearchParams(location.search).get("pendingBrowserTab"),
  });
  if (webLinkView.current.key !== location.key)
    webLinkView.current = {
      key: location.key,
      revision: webLinkView.current.revision + 1,
      changedAt: Date.now(),
      pendingBrowserTab: new URLSearchParams(location.search).get("pendingBrowserTab"),
    };
  const [webLinkFailure, setWebLinkFailure] = useState<{
    message: string;
    actions: WebLinkFailureActions;
  } | null>(null);
  const webLinkReady = desktopWebLinksReady(desktopDeployment?.kind === "personal", snapshot);
  useEffect(() => {
    if (
      !webLinkReady ||
      !snapshot.deploymentId ||
      !snapshot.user ||
      !suppliedDesktopBridge?.webLinkDelivery
    )
      return;
    const deploymentId = DesktopWebLinkDeliverySchema.shape.deploymentId.parse(
      snapshot.deploymentId,
    );
    const userId = snapshot.user.id;
    const bridge = suppliedDesktopBridge;
    setWebLinkFailure(null);
    const selection = webLinkSelection(() => webLinkView.current);
    return receiveDesktopWebLinks(
      bridge,
      {
        deploymentId,
        userId,
        identity: () => lastBrowsingChoice({ deploymentId, userId }) ?? { kind: "guest" },
      },
      () => {
        let pendingKey: string | null = null;
        const select = selection(
          (destination: PendingBrowserTabDestination | WorkspaceSurfaceDestination) => {
            if (destination.kind === "pending-browser") {
              pendingKey = destination.idempotencyKey;
              webLinkNavigation.current.showPendingBrowserTab(pendingKey);
            } else if (pendingKey)
              webLinkNavigation.current.replacePendingBrowserTab(pendingKey, destination);
          },
        );
        return (link, acknowledge) =>
          openDesktopWebLink(
            link,
            hostClient,
            link.request!.identity,
            select(link.receivedAt),
            acknowledge,
          );
      },
      (error, actions) => {
        if (actions) setWebLinkFailure({ message: actionErrorMessage(error), actions });
        else toast.error(actionErrorMessage(error));
      },
    );
  }, [
    webLinkReady,
    suppliedDesktopBridge,
    snapshot.deploymentId,
    snapshot.user?.id,
    hostClient,
    toast,
  ]);
  // The remembered place reopens once per viewer for the shell's life: Settings
  // unmounts the workspace's keys, and coming back from it is not a launch.
  const placeRestored = useRef<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const mobileNavigation = useMediaQuery(drawerQuery);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(sidebarCollapsedKey) === "true",
  );
  const [sidebarWidth, setSidebarWidth, commitSidebarWidth] = usePersistedPaneSize(
    sidebarWidthKey,
    sidebarWidthRange,
  );
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [homeHandoff, setHomeHandoff] = useState<ShellContext["homeHandoff"]>(null);
  const [homeDraft, setHomeDraft] = useState("");
  const [sharingWorkspaceId, setSharingWorkspaceId] = useState<string | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [harnessAuthentication, setHarnessAuthentication] = useState<ThreadPlacementOption | null>(
    null,
  );
  const [localExecutionStatus, setLocalExecutionStatus] =
    useState<DesktopLocalExecutionStatus | null>(null);
  const [localExecutionAction, setLocalExecutionAction] = useState<LocalExecutionAction | null>(
    null,
  );
  const [localExecutionError, setLocalExecutionError] = useState<string | null>(null);
  const nativeDesktopBridge = useMemo(() => desktopBridge(), []);
  const localBridge = useMemo(
    () => suppliedDesktopBridge ?? nativeDesktopBridge,
    [nativeDesktopBridge, suppliedDesktopBridge],
  );
  const desktopWindowChrome = nativeDesktopBridge !== null;
  const localExecutionDeploymentId = localRunnerSlotDeploymentId({
    desktopBridge: localBridge,
    desktopDeployment,
  });
  const viewedLocalExecutionStatus =
    localExecutionStatus?.deploymentId === localExecutionDeploymentId ? localExecutionStatus : null;
  const localRunnerId = viewedLocalExecutionStatus?.runner.runnerId ?? null;
  // The durable name this computer enrolled under, which a restart has to
  // repeat. Before the inventory has caught up, the OS name it enrolled with.
  const localComputerName =
    snapshot.machines.find((machine) => machine.id === localRunnerId)?.name ??
    viewedLocalExecutionStatus?.computerName ??
    null;
  // The grant this computer would join under. A Personal Deployment admits
  // other computers only to be reached, so its grant is exactly `shell`.
  const localGrant = useMemo<readonly ["agents", "browser", "shell"] | readonly ["shell"]>(
    () =>
      snapshot.deploymentShape?.kind === "server" ? ["agents", "browser", "shell"] : ["shell"],
    [snapshot.deploymentShape?.kind],
  );
  // Every navigation closes the drawer; the destination is on screen now.
  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [location.pathname]);

  // Calling a work location "this computer" is an identity claim, so it is
  // made only from the Runner id the Desktop supervises here — and the label
  // it wears is the computer's own name, never the words "this computer".
  const localRunner = useMemo<LocalRunnerIdentity | null>(
    () =>
      localRunnerId === null || localComputerName === null
        ? null
        : { label: localComputerName, runnerId: localRunnerId },
    [localComputerName, localRunnerId],
  );
  // This Mac, as the Desktop's supervised Runner for the selected deployment
  // names it, never as a hostname or a guess. Its apps alone can be brought
  // forward, and only where the Desktop can verify and do it.
  // A Personal deployment hosted here has no slot Runner: this Mac is the
  // deployment's own Runner, the one in the environment this Desktop set up.
  const personalSetup = deploymentAccess?.personalSetup ?? null;
  const hostedEnvironmentId =
    localBridge !== null &&
    desktopDeployment?.kind === "personal" &&
    desktopDeployment.onThisComputer &&
    personalSetup?.deploymentId === snapshot.deploymentId
      ? personalSetup.environmentId
      : null;
  const hostingRunnerId =
    hostedEnvironmentId === null
      ? null
      : (snapshot.environments.find((environment) => environment.id === hostedEnvironmentId)
          ?.runnerId ?? null);
  const thisMachineId = localRunnerId ?? hostingRunnerId;
  const localActivationReady =
    hostingRunnerId !== null
      ? personalSetup?.state === "ready" && desktopDeployment?.access === "owner"
      : viewedLocalExecutionStatus?.available === true &&
        viewedLocalExecutionStatus.runner.state === "running";
  const useComputerViewOnThisMac = localBridge?.useComputerViewOnThisMac?.bind(localBridge) ?? null;
  const viewedDeploymentId = snapshot.deploymentId;
  const localMachine = useMemo<LocalMachine | null>(
    () =>
      thisMachineId === null
        ? null
        : {
            machineId: thisMachineId,
            useApp:
              useComputerViewOnThisMac && viewedDeploymentId && localActivationReady
                ? async (view, app) => {
                    return useComputerViewOnThisMac(
                      DesktopUseComputerViewInputSchema.parse({
                        ...view,
                        app,
                        deploymentId: viewedDeploymentId,
                        machineId: thisMachineId,
                      }),
                    );
                  }
                : null,
          },
    [thisMachineId, useComputerViewOnThisMac, viewedDeploymentId, localActivationReady],
  );
  const placements = useMemo(
    () => threadPlacementOptions(snapshot.environments, snapshot.harnesses, localRunner),
    [localRunner, snapshot.environments, snapshot.harnesses],
  );
  const defaultPlacement = useMemo(
    () => defaultThreadPlacement(snapshot.environments, snapshot.harnesses, localRunner),
    [localRunner, snapshot.environments, snapshot.harnesses],
  );

  const reportActionError = useCallback((error: unknown) => {
    setActionError(actionErrorMessage(error));
  }, []);
  const doneReview = useActionReview(hostClient);
  const setTaskDone = useCallback(
    (threadId: string, done: boolean) => {
      const thread = heldThread(hostClient.getSnapshot(), threadId);
      if (done && thread && taskUnderWay(thread))
        doneReview.ask({ kind: "task-done", threadId, done });
      else
        void reviewHostAction(hostClient, { kind: "task-done", threadId, done })
          ?.confirm()
          .catch(reportActionError);
    },
    [hostClient, reportActionError, doneReview.ask],
  );
  // The Host owns what this person chose last, for every app they open
  // against this Deployment; the snapshot is the only copy.
  const executionPreferences: ExecutionPreferences = snapshot.executionPreferences;
  const rememberExecution = useCallback(
    (choice: ExecutionChoice) => void hostClient.rememberExecution(choice).catch(reportActionError),
    [hostClient, reportActionError],
  );
  const clearActionError = useCallback(() => setActionError(null), []);
  const clearHomeHandoff = useCallback(() => setHomeHandoff(null), []);
  // Handing words to Chat changes only the conversation: the place stays.
  const { openConversation } = nav;
  const askOpensteerAbout = useCallback(
    (quote: ComposerQuote) => {
      setHomeHandoff((current) => ({ key: (current?.key ?? 0) + 1, quote, text: "" }));
      openConversation("/");
    },
    [openConversation],
  );
  const writeInChat = useCallback(
    (text: string) => {
      setHomeHandoff((current) => ({ key: (current?.key ?? 0) + 1, text }));
      openConversation("/");
    },
    [openConversation],
  );
  const closeMobileNavigation = useCallback(() => setMobileNavigationOpen(false), []);
  const openMobileNavigation = useCallback(() => setMobileNavigationOpen(true), []);
  const openNewWorkspace = useCallback(() => {
    setNewWorkspaceError(null);
    setNewWorkspaceOpen(true);
  }, []);
  const createWorkspace = useCallback(
    async (input: {
      readonly icon: WorkspaceIconName | null;
      readonly name: string;
      readonly storage: NewWorkspaceStorageChoice;
    }) => {
      setCreatingWorkspace(true);
      setNewWorkspaceError(null);
      try {
        const result = await hostClient.dispatch({
          ...(input.icon ? { icon: input.icon } : {}),
          idempotencyKey: mutationIdempotencyKey("workspace"),
          name: input.name,
          storage:
            input.storage.backing === "local-directory"
              ? {
                  backing: "local-directory",
                  environmentId: input.storage.environmentId ?? "",
                }
              : { backing: "portablefs" },
          type: "workspace.create",
        });
        if (result.type !== "workspace.create") throw new Error("Workspace command mismatch.");
        setNewWorkspaceOpen(false);
      } catch (error) {
        setNewWorkspaceError(actionErrorMessage(error));
      } finally {
        setCreatingWorkspace(false);
      }
    },
    [hostClient],
  );
  const openSharing = useCallback(
    (workspaceId: string) => {
      if (snapshot.workspaceSharingAvailable) setSharingWorkspaceId(workspaceId);
    },
    [snapshot.workspaceSharingAvailable],
  );
  // Who may sign in is the Host's call for each work location. Reading the
  // capability flag preserves owner-bound managed Runner authorization.
  const harnessAuthenticationEnvironmentIds = useMemo(
    () =>
      new Set(
        snapshot.environments
          .filter((environment) => environment.harnessAuthenticationAllowed)
          .map((environment) => environment.id),
      ),
    [snapshot.environments],
  );
  // A sign-in that cannot start says so. Dropping the request silently left the
  // reader clicking a control that appeared to do nothing.
  const openHarnessAuthentication = useCallback(
    (placement: ThreadPlacementOption) => {
      if (!harnessAuthenticationEnvironmentIds.has(placement.environmentId)) {
        toast.error(`${placement.whereLabel} does not allow signing AI engines in from here.`);
        return;
      }
      if (!placement.setupAvailable) {
        toast.error(
          `Sign in isn’t available for ${placement.accountName} on ${placement.whereLabel}: ${placement.detail}`,
        );
        return;
      }
      setHarnessAuthentication(placement);
    },
    [harnessAuthenticationEnvironmentIds, toast],
  );
  const refreshHarnessCatalog = useCallback(
    async (placement: ThreadPlacementOption) => {
      try {
        unwrapRpcResult(
          await hostClient.rpc["harness.catalog.refresh"]({
            environmentId: placement.environmentId,
            harnessInstanceId: placement.harnessInstanceId,
          }),
        );
        await hostClient.refresh();
      } catch (error) {
        reportActionError(error);
      }
    },
    [hostClient, reportActionError],
  );
  const closeHarnessAuthentication = useCallback(() => setHarnessAuthentication(null), []);

  const createThreadAndSend = useCallback(
    async (
      workspaceId: string,
      message: PendingSubmission,
      selection: ExecutionSelection,
      accessMode: ThreadAccessMode,
    ): Promise<ThreadSummary | null> => {
      setActionError(null);
      // The first message is kept before anything sends it, under the
      // deployment and user the Host confirmed; without either, no Thread is
      // started for a message that could not be kept.
      const { deploymentId, user } = hostClient.getSnapshot();
      if (!deploymentId || !user) {
        setActionError(pendingScopeUnavailable);
        return null;
      }
      if (!pendingStorageAvailable()) {
        setActionError(pendingStorageUnavailable);
        return null;
      }
      try {
        const thread = await hostClient.createThread({
          accessMode,
          environmentId: selection.environmentId,
          harnessInstanceId: selection.harnessInstanceId,
          modelSelection: selection.modelSelection,
          generateTitle: true,
          title: provisionalThreadTitle(message.body || message.attachments[0]?.name || ""),
          workspaceId,
        });
        // The new Thread's own composer sends it, exactly as kept, when it
        // opens: one path for the first try, a lost answer and a refusal.
        claimFirstMessage({ deploymentId, threadId: thread.id, userId: user.id }, message);
        return thread;
      } catch (error) {
        setActionError(actionErrorMessage(error));
        return null;
      }
    },
    [hostClient],
  );

  /* ---- Notifications ---- */

  // One subscription for this attached client. The Host has already decided
  // that this reader gets this notification — membership, mute and what they
  // have read; what is left to decide here is only whether they are looking at
  // that conversation right now.
  useEffect(() => {
    return hostClient.subscribeNotifications((notification) => {
      if (isReadingThread(notification.threadId)) return;
      // Parsed here because a notification addresses a destination: one that
      // does not name a Deployment is not worth interrupting anybody with.
      const target = DesktopNotificationTargetSchema.safeParse({
        body: notification.body,
        deploymentId: hostClient.getSnapshot().deploymentId,
        messageId: notification.messageId,
        notificationId: notification.id,
        requestId: notification.requestId,
        threadId: notification.threadId,
        title: notification.title,
      });
      if (!target.success) return;
      void showNotification(target.data).catch(() => {
        // A notification this browser or desktop declined to show is not
        // worth reporting: what it points at is unread in its Thread either way.
      });
    });
  }, [hostClient]);

  // Opening one notification: its conversation, at the exact message when it
  // names one. A request has no anchor of its own; its Thread shows it pending.
  // A notification for another Deployment never reaches here — in a browser
  // this client is the only Deployment there is, and on the Desktop the
  // surface that owns selection hands the target over once its own app is
  // attached.
  const deploymentId = snapshot.deploymentId;
  const homeThreadId = snapshot.homeThreadId;
  const openNotification = useCallback(
    (target: DesktopNotificationTarget) => {
      if (!deploymentId || target.deploymentId !== deploymentId) return;
      openConversation(
        conversationPath(target.threadId, homeThreadId),
        target.messageId ? { messageId: target.messageId } : undefined,
      );
    },
    [deploymentId, homeThreadId, openConversation],
  );
  useEffect(() => {
    // The Desktop's own activation is subscribed once, above the app; a second
    // subscription here would navigate the same click twice.
    if (nativeDesktopBridge) return;
    return onNotificationActivated(openNotification);
  }, [nativeDesktopBridge, openNotification]);
  useEffect(() => {
    if (!notificationTarget || notificationTarget.deploymentId !== deploymentId) return;
    openNotification(notificationTarget);
    onNotificationTargetOpened?.();
  }, [deploymentId, notificationTarget, onNotificationTargetOpened, openNotification]);

  // ⌘N / Ctrl+N starts a separate task. Home needs no shortcut to reach: it is
  // where the app opens, and where asking again needs nothing new.
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (fromLivePage(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        openConversation("/new");
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openConversation]);

  // Away from the window, the app's icon counts the questions waiting on this
  // person, as the collapsed sidebar does. Leaving this Deployment clears it.
  useEffect(() => {
    if (!localBridge) return;
    const show = (count: number) =>
      void localBridge.setBadgeCount({ count }).catch(() => {
        // A badge the operating system will not draw changes nothing the app shows.
      });
    show(attention);
    return () => show(0);
  }, [attention, localBridge]);

  useEffect(() => {
    if (!localBridge || !localExecutionDeploymentId) {
      setLocalExecutionStatus(null);
      return;
    }
    return observeLocalExecutionStatus(
      localBridge,
      localExecutionDeploymentId,
      setLocalExecutionStatus,
      (error) => setLocalExecutionError(actionErrorMessage(error)),
    );
  }, [localBridge, localExecutionDeploymentId]);

  const performLocalExecutionAction = useCallback(
    async (action: LocalExecutionAction) => {
      if (!localBridge || !desktopDeployment || localExecutionAction) return;
      const localExecutionInput = { deploymentId: desktopDeployment.id };
      setLocalExecutionAction(action);
      setLocalExecutionError(null);
      try {
        let status: DesktopLocalExecutionStatus;
        switch (action.kind) {
          case "add": {
            // The web app mints the grant, as this person's session: the
            // desktop never chooses one. Both facts normally start off — the
            // computer joins, and then a switch says what it may do — but a
            // Windows computer has no `shell` module to join with, so the
            // offer that reached here decided what it starts running.
            const enrollment = await hostClient.dispatch({
              allowedModules: [...localGrant],
              idempotencyKey: mutationIdempotencyKey("local-runner"),
              name: action.name,
              type: "runner.enrollment.createLocal",
            });
            if (enrollment.type !== "runner.enrollment.createLocal") {
              throw new Error("Computer connection did not complete.");
            }
            status = await localBridge.startLocalRunner({
              deploymentId: desktopDeployment.id,
              enrollmentToken: enrollment.token,
              runAgents: action.runAgents,
              runnerName: action.name,
            });
            await hostClient.refresh();
            break;
          }
          case "set-run-agents": {
            // An enrolled Runner already holds its credential, so this is a
            // restart with the other module set and carries no token.
            if (localComputerName === null) {
              throw new Error("This computer has not joined this deployment yet.");
            }
            status = await localBridge.startLocalRunner({
              deploymentId: desktopDeployment.id,
              runAgents: action.runAgents,
              runnerName: localComputerName,
            });
            await hostClient.refresh();
            break;
          }
          case "remove":
            status = await removeLocalComputer({
              bridge: localBridge,
              client: hostClient,
              deploymentId: desktopDeployment.id,
              runnerId: localRunnerId,
            });
            await hostClient.refresh();
            break;
          case "install": {
            status = await localBridge.installPortableFs(localExecutionInput);
            if (status.portableFs.state === "needs-user-approval") {
              status = await localBridge.openPortableFsSetup(localExecutionInput);
            }
            break;
          }
          case "open-setup":
            status = await localBridge.openPortableFsSetup(localExecutionInput);
            break;
          case "acknowledge":
            status = await localBridge.acknowledgePortableFsApproval(localExecutionInput);
            break;
          case "refresh":
            status = await localBridge.getLocalExecutionStatus(localExecutionInput);
            await hostClient.refresh();
            break;
        }
        setLocalExecutionStatus(status);
      } catch (error) {
        setLocalExecutionError(actionErrorMessage(error));
        const status = await localBridge
          .getLocalExecutionStatus(localExecutionInput)
          .catch(() => null);
        if (status) setLocalExecutionStatus(status);
        // Recorded, and then rethrown: a caller that has its own decision to
        // make about a failure — a page that would otherwise navigate away
        // from a computer that is still there — has to be able to see it.
        throw error;
      } finally {
        setLocalExecutionAction(null);
      }
    },
    [
      desktopDeployment,
      hostClient,
      localBridge,
      localComputerName,
      localExecutionAction,
      localGrant,
      localRunnerId,
    ],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem(sidebarCollapsedKey, String(!collapsed));
      return !collapsed;
    });
  }, []);

  const sharingWorkspace = snapshot.workspaceSharingAvailable
    ? (snapshot.workspaces.find((workspace) => workspace.id === sharingWorkspaceId) ?? null)
    : null;

  const context = useMemo<ShellSharedContext>(
    () => ({
      actionError,
      askOpensteerAbout,
      clearActionError,
      clearHomeHandoff,
      createThreadAndSend,
      defaultPlacement,
      deploymentAccess,
      desktopBridge: localBridge,
      desktopDeployment,
      executionPreferences,
      homeDraft,
      homeHandoff,
      homeThreadId: snapshot.homeThreadId,
      hostClient,
      setHomeDraft,
      localExecutionStatus: viewedLocalExecutionStatus,
      localExecutionAction,
      localExecutionError,
      leaveSettings: nav.leaveSettings,
      openMobileNavigation,
      openNewWorkspace,
      openHarnessAuthentication:
        harnessAuthenticationEnvironmentIds.size > 0 ? openHarnessAuthentication : null,
      performLocalExecutionAction,
      openSharing,
      placements,
      rememberExecution,
      refreshHarnessCatalog,
      reportActionError,
      setTaskDone,
      writeInChat,
    }),
    [
      actionError,
      askOpensteerAbout,
      clearActionError,
      clearHomeHandoff,
      createThreadAndSend,
      defaultPlacement,
      deploymentAccess,
      desktopDeployment,
      executionPreferences,
      harnessAuthenticationEnvironmentIds,
      homeDraft,
      homeHandoff,
      snapshot.homeThreadId,
      hostClient,
      localBridge,
      localExecutionAction,
      localExecutionError,
      nav.leaveSettings,
      viewedLocalExecutionStatus,
      openMobileNavigation,
      openNewWorkspace,
      openHarnessAuthentication,
      openSharing,
      placements,
      performLocalExecutionAction,
      rememberExecution,
      refreshHarnessCatalog,
      reportActionError,
      setTaskDone,
      writeInChat,
    ],
  );

  const drawerReady = useNativeBrowserOverlay(
    !settingsMode && mobileNavigation && mobileNavigationOpen,
    navigationDrawerElement,
  );
  const overlayOpen =
    harnessAuthentication !== null ||
    sharingWorkspace !== null ||
    (!settingsMode && mobileNavigation && mobileNavigationOpen);
  const shellClassName = settingsMode
    ? "app-shell app-shell--settings"
    : sidebarCollapsed
      ? "app-shell app-shell--sidebar-collapsed"
      : "app-shell";
  const chromeEnvironment = useChromeConnectEnvironment({
    desktopBridge: localBridge,
    hostHere: localBridge
      ? (selectedDeploymentFrom(deploymentAccess, desktopDeployment)?.onThisComputer ?? false)
      : null,
  });
  const hostOnline = canRespondToRequests(snapshot);
  const chromeSignIn = useMemo(
    () => ({ client: hostClient, environment: chromeEnvironment, online: hostOnline }),
    [chromeEnvironment, hostClient, hostOnline],
  );
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const routes = <ShellRouteOutlet context={context} hostClient={hostClient} />;

  return (
    <VoiceContext value={voice}>
      <WorkspaceProvider
        attention={attention}
        localMachine={localMachine}
        nav={nav}
        openDrawer={openMobileNavigation}
        openWebLink={openWebLink}
      >
        {webLinkFailure ? (
          <DesktopWebLinkFailureNotice
            {...webLinkFailure}
            onResolve={() => setWebLinkFailure(null)}
          />
        ) : null}
        {doneReview.review ? (
          <Dialog
            labelledBy="task-done-confirmation-title"
            title="Stop and mark Done?"
            onClose={doneReview.dismiss}
            footer={
              <>
                <button className="btn btn--ghost" onClick={doneReview.dismiss} type="button">
                  Keep working
                </button>
                <button
                  className="btn btn--danger"
                  type="button"
                  onClick={() => {
                    const result = doneReview.review?.confirm();
                    doneReview.dismiss();
                    void result?.catch(reportActionError);
                  }}
                >
                  Mark Done
                </button>
              </>
            }
          >
            This stops its work and the tasks it handed out, and pauses its schedules.
          </Dialog>
        ) : null}
        <DownloadFeedback />
        <AppIconProvider hostClient={hostClient}>
          <TabCloserProvider hostClient={hostClient}>
            <div
              className={shellClassName}
              style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
            >
              {!settingsMode && mobileNavigation && mobileNavigationOpen && drawerReady ? (
                <button
                  type="button"
                  className="sidebar-scrim"
                  aria-label="Close navigation"
                  onClick={closeMobileNavigation}
                />
              ) : null}
              {!settingsMode ? (
                <ShellSidebar
                  collapsed={!mobileNavigation && sidebarCollapsed}
                  deploymentAccess={deploymentAccess}
                  desktopDeployment={desktopDeployment}
                  desktopWindowChrome={desktopWindowChrome}
                  hostClient={hostClient}
                  mobile={mobileNavigation}
                  mobileOpen={mobileNavigation && mobileNavigationOpen && drawerReady}
                  onCloseMobile={closeMobileNavigation}
                  onLoadEarlierTasks={async () => {
                    try {
                      await hostClient.loadEarlierTasks();
                    } catch (error) {
                      reportActionError(error);
                      throw error;
                    }
                  }}
                  onSetTaskDone={setTaskDone}
                  onToggleCollapsed={toggleSidebar}
                />
              ) : null}
              {!settingsMode && !mobileNavigation && !sidebarCollapsed ? (
                <PaneResizeHandle
                  ariaControls="app-sidebar"
                  ariaLabel="Resize navigation sidebar"
                  max={sidebarWidthRange.max}
                  min={sidebarWidthRange.min}
                  onCommit={commitSidebarWidth}
                  onResize={setSidebarWidth}
                  range={sidebarWidthRange}
                  side="left"
                  value={sidebarWidth}
                />
              ) : null}
              <main className="app-shell__main" aria-hidden={overlayOpen} inert={overlayOpen}>
                {loadError || actionError ? (
                  <div className="notice notice--error shell-error" role="alert">
                    <span className="shell-error__message">{loadError ?? actionError}</span>
                    {!loadError ? (
                      <button
                        aria-label="Dismiss error"
                        className="icon-btn"
                        onClick={() => setActionError(null)}
                        type="button"
                      >
                        <Icon name="close" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {/* The one foreground operation, above whichever page is routed below
              it, because it outlives navigation and every mutating control on
              those pages is disabled while it runs. */}
                <DeploymentOperationBanner bridge={localBridge} snapshot={deploymentAccess} />
                <VoiceIsland />
                <SidebarChromeProvider
                  onRestore={toggleSidebar}
                  restoreVisible={!settingsMode && !mobileNavigation && sidebarCollapsed}
                >
                  {settingsMode ? (
                    routes
                  ) : (
                    <WorkspaceLayout
                      middle={
                        <PlaceStage
                          chromeSignIn={chromeSignIn}
                          hostClient={hostClient}
                          hostConnected={snapshot.connection === "connected"}
                          onReportError={reportActionError}
                        />
                      }
                    >
                      {routes}
                    </WorkspaceLayout>
                  )}
                </SidebarChromeProvider>
              </main>

              {sharingWorkspace && snapshot.user ? (
                <WorkspaceSharingDialog
                  client={hostClient}
                  currentUserId={snapshot.user.id}
                  onClose={() => setSharingWorkspaceId(null)}
                  workspace={sharingWorkspace}
                />
              ) : null}
              {newWorkspaceOpen ? (
                <NewWorkspaceDialog
                  creating={creatingWorkspace}
                  defaultBacking={
                    snapshot.deploymentShape?.defaultWorkspaceBacking ?? "local-directory"
                  }
                  environments={snapshot.environments}
                  error={newWorkspaceError}
                  onClose={() => {
                    if (!creatingWorkspace) setNewWorkspaceOpen(false);
                  }}
                  onCreate={(input) => void createWorkspace(input)}
                  sharedStorageAvailable={
                    snapshot.deploymentShape?.defaultWorkspaceBacking === "portablefs"
                  }
                />
              ) : null}
              {harnessAuthentication ? (
                <HarnessAuthenticationDialog
                  client={hostClient}
                  placement={harnessAuthentication}
                  onClose={closeHarnessAuthentication}
                  onReady={closeHarnessAuthentication}
                />
              ) : null}
              {shortcutsOpen ? (
                <ShortcutsHelp
                  desktop={desktopWindowChrome}
                  onClose={() => setShortcutsOpen(false)}
                />
              ) : null}
            </div>
            {settingsMode ? null : (
              <WorkspaceKeys
                desktop={desktopWindowChrome}
                hostClient={hostClient}
                onShowShortcuts={openShortcuts}
                restored={placeRestored}
              />
            )}
          </TabCloserProvider>
        </AppIconProvider>
      </WorkspaceProvider>
    </VoiceContext>
  );
}

/**
 * The sidebar repaints with the task list it draws, apart from the shell, so a
 * task changing never re-renders the routed page beside it.
 */
function ShellSidebar({
  hostClient,
  ...props
}: Omit<SidebarProps, "onNewTab"> & { readonly hostClient: HostClient }) {
  const newTab = useNewTab();
  return <Sidebar {...props} hostClient={hostClient} onNewTab={() => newTab()} />;
}

/**
 * The workspace's keys, and the only rewrites the address gets on its own,
 * each replacing itself once: an old or incomplete place address made
 * canonical, and a place that went away while shown handed to its successor.
 */
function WorkspaceKeys({
  desktop,
  hostClient,
  onShowShortcuts,
  restored,
}: {
  readonly desktop: boolean;
  readonly hostClient: HostClient;
  readonly onShowShortcuts: () => void;
  /** The viewer whose remembered place has been reopened, kept by the shell. */
  readonly restored: React.RefObject<string | null>;
}) {
  const newTab = useNewTab();
  useWorkspaceShortcuts({ desktop, hostClient, onNewTab: () => newTab(), onShowShortcuts });
  usePlaceSuccession(hostClient);
  const navigate = useNavigate();
  const { key, pathname, search } = useLocation();
  const sessions = useHostSelector(hostClient, selectBrowserSessions);
  const known = useHostSelector(hostClient, selectBrowsersKnown);
  const deploymentId = useHostSelector(hostClient, selectDeploymentId);
  const userId = useHostSelector(hostClient, selectUserId);
  const canonicalized = useRef<string | null>(null);
  const restoreVersion = useHostSelector(
    hostClient,
    (snapshot) => snapshot.workspaceTabRestoreVersion,
  );
  useEffect(() => {
    if (!known || !deploymentId || !userId || restoreVersion !== 1) return;
    const viewer = `${deploymentId}:${userId}`;
    if (restored.current === viewer) return;
    restored.current = viewer;
    if (
      pathname === "/live" ||
      new URLSearchParams(search).has("panel") ||
      new URLSearchParams(search).has("browser")
    )
      return;
    const scope = { deploymentId, userId };
    if (rememberedTalk(scope)) return;
    const remembered = rememberedPlace(scope);
    let cancelled = false;
    if (remembered?.kind === "browser") {
      void (async () => {
        const snapshot = hostClient.getSnapshot();
        let group = snapshot.workspaceTabs?.find(
          (group) =>
            group.id === remembered.sessionId ||
            group.session.id === remembered.sessionId ||
            group.tabs?.some((tab) => tab.id === remembered.tabId),
        );
        const legacy = snapshot.browserSessions.find(
          (session) =>
            session.id === remembered.sessionId &&
            session.workspaceTabRestoreVersion !== 1 &&
            session.state !== "closed" &&
            session.state !== "failed",
        );
        if (!group?.tabs && !legacy && hostClient.readWorkspaceTabs)
          group = (await hostClient.readWorkspaceTabs(remembered.sessionId)) ?? undefined;
        if (cancelled) return;
        const params = new URLSearchParams(search);
        params.set("panel", "browser");
        if (
          group?.tabs?.some((tab) => tab.id === remembered.tabId) ||
          legacy?.tabCatalog?.tabs.some((tab) => tab.id === remembered.tabId)
        ) {
          params.set("browser", group?.session.id ?? remembered.sessionId);
          params.set("browserTab", remembered.tabId ?? "");
        }
        void navigate({ pathname, search: `?${params}` }, { replace: true });
      })().catch(() => undefined);
    } else if (rememberedNewTab(scope)) {
      const params = new URLSearchParams(search);
      params.set("panel", "browser");
      void navigate({ pathname, search: `?${params}` }, { replace: true });
    }
    return () => {
      cancelled = true;
    };
  }, [deploymentId, hostClient, known, navigate, pathname, restoreVersion, search, userId]);
  useEffect(() => {
    // A redirect owns its own address change; nothing else rewrites it meanwhile.
    if (canonicalized.current === key || pathname === "/live") return;
    const next = canonicalPlaceSearch(search, (sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return known ? null : undefined;
      return session.tabs.find((tab) => tab.active)?.id ?? session.tabCatalog?.tabs[0]?.id ?? null;
    });
    if (next === null) return;
    canonicalized.current = key;
    void navigate({ pathname, search: next }, { replace: true });
  }, [key, known, navigate, pathname, search, sessions]);
  // The place the person put in the middle — by a row, a link, Back or a
  // typed address — is the one Show computer returns to.
  useEffect(() => {
    const selection = placeSelection(new URLSearchParams(search));
    if (selection.kind === "launcher") {
      rememberNewTab({ deploymentId, userId });
      return;
    }
    if (selection.kind !== "place") return;
    const { destination } = selection;
    if (destination.kind !== "browser" || destination.tabId)
      rememberPlace({ deploymentId, userId }, destination);
  }, [deploymentId, search, userId]);
  return null;
}

const selectBrowserSessions = (snapshot: HostSnapshot) => snapshot.browserSessions;
const selectBrowsersKnown = (snapshot: HostSnapshot) =>
  snapshot.deploymentShape !== null && snapshot.connection === "connected";
const selectDeploymentId = (snapshot: HostSnapshot) => snapshot.deploymentId;
const selectUserId = (snapshot: HostSnapshot) => snapshot.user?.id ?? null;

/**
 * Only the routed Thread trees — Home at the root and a Thread under
 * /threads — observe the full streaming snapshot. Other routes use the stable
 * projection, while the surrounding shell and dialogs remain outside this
 * subscription boundary.
 */
function ShellRouteOutlet({
  context,
  hostClient,
}: {
  readonly context: ShellSharedContext;
  readonly hostClient: HostClient;
}) {
  const { pathname } = useLocation();
  const snapshot = useHostSelector(
    hostClient,
    selectHostSnapshot,
    pathname === "/" || pathname.startsWith("/threads/") ? Object.is : sameStableHostSnapshot,
  );
  const outletContext = useMemo<ShellContext>(
    () => ({ ...context, snapshot }),
    [context, snapshot],
  );
  return <Outlet context={outletContext} />;
}

function navigationDrawerElement() {
  return document.getElementById("app-sidebar");
}

export function DesktopWebLinkFailureNotice({
  message,
  actions,
  onResolve,
}: {
  message: string;
  actions: WebLinkFailureActions;
  onResolve: () => void;
}) {
  return (
    <div className="notice" role="alert">
      <p>Could not open a web link. {message}</p>
      <button
        type="button"
        onClick={() => {
          onResolve();
          void actions.retry();
        }}
      >
        Retry
      </button>
      <button
        type="button"
        onClick={() => {
          onResolve();
          void actions.dismiss();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
