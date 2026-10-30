import { createExpoSavedViews } from "./platform/expo-saved-views.js";

import { DictationProvider } from "./dictation/context.js";
import * as Application from "expo-application";
import { OAuthDeepLinkBroker, type NativeOAuthIdentity } from "@opensteer/client/auth";
import {
  integrationAuthorizationError,
  parseNativeIntegrationAuthorizationCallback,
} from "@opensteer/client/integrations";
import { AccountNotificationDevicesClient } from "@opensteer/client/connections";
import {
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import Constants from "expo-constants";
import { getRandomValues } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import type { InitialState } from "@react-navigation/native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import type { MockHostClient } from "@opensteer/client/mock";
import { createNetworkHostPort } from "./client/host-port.js";
import { createMockHostPort } from "./client/mock-host-port.js";
import { MobileClient, operationDetail } from "./client/mobile-client.js";
import { mockDeploymentConnections } from "./client/mock-mode.js";
import { readMobileConfiguration } from "./config.js";
import { resolveThreadLink } from "./links.js";
import { Navigation, navigationTheme } from "./navigation.js";
import { navigationRef, resetToThread } from "./navigation-ref.js";
import {
  deploymentRoot,
  deploymentsRoot,
  linkedSelectionFailureIsCurrent,
  selectionMayReconcileLinkedRoot,
  selectionRootTransition,
  threadRoot,
  type ThreadDestination,
} from "./navigation-state.js";
import { MobileNotifications } from "./notifications/mobile-notifications.js";
import {
  createExpoNotificationPort,
  createExpoPushPermissions,
  createMockNotificationPort,
} from "./notifications/notification-port.js";
import { PushRegistration } from "./notifications/push-registration.js";
import {
  createAuthorizationBrowser,
  createIntegrationAuthorizationBrowser,
} from "./platform/authorization-browser.js";
import { createMobileLifecycle } from "./platform/lifecycle.js";
import { mobileHostFetch } from "./platform/expo-host-fetch.js";
import { createDocumentPrivateFilesystem } from "./platform/private-filesystem.js";
import { openReactNativeSocket } from "./platform/react-native-socket.js";
import { createSecureRecordStore } from "./platform/secure-record-store.js";
import { color, space } from "./theme.js";
import { IphoneApprovalPrompt } from "./iphone-apps/approval-prompt.js";
import { IphoneAppsProvider, useIphoneAppsState } from "./iphone-apps/context.js";
import { IphoneAppsController } from "./iphone-apps/controller.js";
import {
  createFakeIphoneApps,
  observeMockHostCommand,
  type FakeIphoneApps,
} from "./iphone-apps/fake-bridge.js";
import { iphoneNotTold, opensteerOn } from "./iphone-apps/model.js";
import { createShownApprovalsFile } from "./iphone-apps/shown-approvals-file.js";
import { iphoneApps } from "./platform/iphone-apps.js";
import { MobileClientProvider, useMobileState } from "./ui/mobile-client-context.js";
import { MobileNotificationsProvider } from "./ui/notifications-context.js";
import { AppText, Notice } from "./ui/primitives.js";

/**
 * The composition root, and the only place any of this is wired.
 *
 * Every platform capability the shared client needs is built here and injected:
 * protected storage, the private filesystem, the app's lifecycle, the system
 * authorization browser, the Host transport, and the phone's notifications.
 * Downstream of this file nothing constructs a Host client, opens a socket, or
 * reads a credential — screens read `MobileClient`'s snapshot and call its
 * methods, so there is exactly one attachment at a time and exactly one place
 * that owns it.
 */

// Each variable is named as its own member so Metro replaces it with a
// literal; see `readMobileConfiguration`. `__DEV__` is Metro's own bundle-time
// literal and is what says a development bundle from a shipped one.
const configuration = readMobileConfiguration(
  {
    EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN: process.env.EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN,
    EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: process.env.EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE,
    EXPO_PUBLIC_OPENSTEER_MOCK: process.env.EXPO_PUBLIC_OPENSTEER_MOCK,
    EXPO_PUBLIC_OPENSTEER_MOCK_HOME: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_HOME,
  },
  { development: __DEV__ },
);

// Keep the native launch screen up while the catalog and remembered selection
// hydrate. The navigator's first frame is therefore the real root rather than
// a catalog that immediately slides away.
void SplashScreen.preventAutoHideAsync();

const oauthIdentity: NativeOAuthIdentity = {
  accountCallback: opensteerMobileAccountOAuthCallback,
  application: "mobile",
  clientId: opensteerMobileOAuthClientId,
  hostCallback: opensteerMobileHostOAuthCallback,
};

/**
 * Mock mode keeps its own catalog file and its own credential namespace, so a
 * development run can never write into, or read, what a real sign-in left on
 * the device.
 */
const storeName = configuration.mock ? "mock" : "opensteer";

interface MobileRoot {
  readonly broker: OAuthDeepLinkBroker;
  readonly client: MobileClient;
  readonly iphone: IphoneAppsController;
  readonly notifications: MobileNotifications;
}

let singleton: MobileRoot | null = null;

function mobileClient(): MobileRoot {
  if (singleton !== null) return singleton;
  const root = Paths.document.uri.endsWith("/") ? Paths.document.uri : `${Paths.document.uri}/`;
  const privateFiles = createDocumentPrivateFilesystem({
    root,
    directory: (uri) => new Directory(uri),
    file: (uri) => new File(uri),
    // The adapter only ever moves onto a path it has just freed, which is the
    // one case where Expo's move is a single rename rather than a delete
    // followed by one.
    replace: (sourceUri, targetUri) => new File(sourceUri).moveSync(new File(targetUri)),
  });
  const broker = new OAuthDeepLinkBroker(oauthIdentity);
  // This iPhone's own apps. Mock mode's iPhone is the JS fake, joined to the
  // in-memory Host of the Deployment it is added to; a shipped build has only
  // the native module, which is a static unsupported stub where it is absent.
  const mockHosts = new Map<string, MockHostClient>();
  let fakeIphone: FakeIphoneApps | null = null;
  if (configuration.mock) {
    fakeIphone = createFakeIphoneApps({
      host: (deploymentId) => mockHosts.get(deploymentId) ?? null,
      supported: Platform.OS === "ios",
    });
  }
  const iphone = new IphoneAppsController({
    bridge: fakeIphone?.bridge ?? iphoneApps,
    shownApprovals: createShownApprovalsFile({
      filePath: `${root}${storeName}/iphone-approvals-shown.json`,
      privateFiles,
    }),
  });
  const client = new MobileClient({
    ...(!configuration.mock ? { savedViewStore: createExpoSavedViews(storeName) } : {}),
    accountOrigin: configuration.accountOrigin,
    catalogFilePath: `${root}${storeName}/deployments.json`,
    doneShelfFilePath: `${root}${storeName}/done-shelf.json`,
    draftsFilePath: `${root}${storeName}/drafts-v3.json`,
    sidebarFilePath: `${root}${storeName}/sidebar.json`,
    fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
    hostPort: configuration.mock
      ? createMockHostPort({
          hosts: mockHosts,
          initialHome: configuration.mockHome,
          onCommand: (command) => {
            if (fakeIphone !== null) void observeMockHostCommand(fakeIphone, command);
          },
        })
      : createNetworkHostPort({
          fetch: mobileHostFetch,
          lifecycle: createMobileLifecycle({ appState: AppState, network: Network }),
          now: () => new Date(),
          openWebSocket: openReactNativeSocket,
        }),
    iphoneApps: iphone.owner,
    oauthIdentity,
    openAuthorization: createAuthorizationBrowser({
      broker,
      browser: WebBrowser,
      oauth: oauthIdentity,
    }),
    openIntegrationAuthorization: createIntegrationAuthorizationBrowser({ browser: WebBrowser }),
    privateFiles,
    randomBytes: (size) => getRandomValues(new Uint8Array(size)),
    records: createSecureRecordStore({
      keyPrefix: `${storeName}.auth`,
      secureStore: SecureStore,
    }),
    ...(configuration.mock ? { seed: mockDeploymentConnections() } : {}),
    selectionFilePath: `${root}${storeName}/selection.json`,
    signedOutFilePath: `${root}${storeName}/signed-out.json`,
  });
  const platform = Platform.OS === "android" ? "android" : "ios";
  const port = configuration.mock
    ? createMockNotificationPort({ permissions: createExpoPushPermissions(Notifications) })
    : createExpoNotificationPort({
        application: Application,
        // Stated by `app.config.ts` from the build's
        // `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE`; a manifest without the fact
        // is a build made before it existed, and an Android token it cannot
        // mint is the honest reading.
        androidPushConfigured: Constants.expoConfig?.extra?.["androidPushConfigured"] === true,
        brandColor: color.ember,
        channelName: "Opensteer",
        notifications: Notifications,
        platform,
        registry: new AccountNotificationDevicesClient({
          accountOrigin: configuration.accountOrigin,
          authorization: client.oauth,
          fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
        }),
        signedInSubject: async () => (await client.oauth.state()).account.identity?.subject ?? null,
      });
  const notifications = new MobileNotifications({
    port,
    registration: new PushRegistration({
      // A build with no Account service has nobody to register with, and mock
      // mode's Account is the port's own: both are settled answers, not
      // failures, and the Notifications settings says which.
      accountConfigured: configuration.mock || configuration.accountOrigin !== null,
      filePath: `${root}${storeName}/notifications.json`,
      permissions: port.permissions,
      platform,
      privateFiles,
      randomBytes: (size) => getRandomValues(new Uint8Array(size)),
      registry: port.registry,
      signedInSubject: port.signedInSubject,
      tokens: port.tokens,
    }),
  });
  singleton = { broker, client, iphone, notifications };
  return singleton;
}

/** Why there is no app on screen, in the two words above the sentence. */
interface StartupFailure {
  readonly detail: string;
  readonly title: string;
}

const startupRefusal: StartupFailure | null =
  configuration.refusal === null
    ? null
    : { detail: configuration.refusal, title: "This build cannot run" };

export function App(): ReactNode {
  const [{ broker, client, iphone, notifications }] = useState(mobileClient);
  const [startupFailure, setStartupFailure] = useState<StartupFailure | null>(startupRefusal);
  const [initialNavigationState, setInitialNavigationState] = useState<InitialState | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState<{
    readonly detail: string;
    readonly title: string;
  } | null>(null);
  /**
   * Links can arrive before either storage or the navigator is ready. One URL
   * waits for storage; after it is validated, one destination waits for the
   * navigator. Neither can make the catalog flash as an intermediate root.
   */
  const waiting = useRef<ThreadDestination | null>(null);
  const waitingUrl = useRef<string | null>(null);
  const initialized = useRef(false);
  const observedRootSelection = useRef<string | null | undefined>(undefined);
  const deferredRootSelection = useRef<string | null | undefined>(undefined);
  // A Thread link owns the visible stack until its named Deployment becomes
  // the client's published local selection. A remembered selection may still
  // be visible briefly while MobileClient serializes an earlier attachment;
  // letting that stale value reconcile would erase the linked Thread route.
  const linkedDeployment = useRef<string | null>(null);
  const linkedSelectionAttempt = useRef(0);

  const applyRootSelection = useCallback((deploymentId: string | null): boolean => {
    if (!navigationRef.isReady()) return false;
    const state = navigationRef.getRootState();
    if (state === undefined) return false;
    const active = state.routes[state.index];
    const base = state.routes[0];
    let baseDeploymentId: string | null = null;
    if (
      base?.name === "Home" &&
      base.params !== undefined &&
      "deploymentId" in base.params &&
      typeof base.params.deploymentId === "string"
    ) {
      baseDeploymentId = base.params.deploymentId;
    }
    const transition = selectionRootTransition({
      activeRouteName: active?.name ?? null,
      baseDeploymentId,
      baseRouteName: base?.name ?? null,
      deploymentId,
    });
    if (transition === "defer") return false;
    if (transition !== null) navigationRef.resetRoot(transition);
    return true;
  }, []);

  const observeRootSelection = useCallback(() => {
    const selection = client.getSnapshot().selection;
    if (selection.status !== "ready") return;
    const linked = linkedDeployment.current;
    if (
      !selectionMayReconcileLinkedRoot({
        linkedDeploymentId: linked,
        selectionDeploymentId: selection.deploymentId,
      })
    ) {
      observedRootSelection.current = selection.deploymentId;
      deferredRootSelection.current = undefined;
      return;
    }
    if (linked !== null && linked === selection.deploymentId) {
      linkedDeployment.current = null;
      deferredRootSelection.current = undefined;
    }
    if (observedRootSelection.current === selection.deploymentId) return;
    observedRootSelection.current = selection.deploymentId;
    deferredRootSelection.current = applyRootSelection(selection.deploymentId)
      ? undefined
      : selection.deploymentId;
  }, [applyRootSelection, client]);

  const syncDeferredRootSelection = useCallback(() => {
    const deploymentId = deferredRootSelection.current;
    if (deploymentId === undefined) return;
    if (applyRootSelection(deploymentId)) deferredRootSelection.current = undefined;
  }, [applyRootSelection]);

  const handleNavigatorReady = (): void => {
    const destination = waiting.current;
    if (destination !== null) {
      waiting.current = null;
      resetToThread(destination);
      return;
    }
    observeRootSelection();
    syncDeferredRootSelection();
  };

  useEffect(() => {
    // A build that may not run does not read this device's storage, does not
    // open a socket and does not register for anything: it says why and stops.
    if (startupRefusal !== null) return;
    const detachBroker = broker.attach((url) => client.oauth.handleCallback(url));

    /**
     * One reader for everything the scheme delivers. The broker accepts only
     * this build's two token callbacks; the integration reader accepts only a
     * Deployment and durable attempt id; `resolveThreadLink` accepts only a
     * Thread link naming a Deployment this phone already holds. Anything else
     * is dropped, because a link is a destination, never an authority.
     */
    const openApplicationLink = async (url: string): Promise<void> => {
      if (parseNativeIntegrationAuthorizationCallback(url) !== null) {
        setIntegrationNotice(null);
        const result = await client.handleIntegrationAuthorizationCallback(url);
        if (result === null) return;
        if (result.status === "completed") {
          await client.getSnapshot().selection.hostClient?.load();
          setIntegrationNotice({
            detail: "The provider account is ready to use.",
            title: "Integration connected",
          });
        } else {
          setIntegrationNotice({
            detail:
              integrationAuthorizationError(result.status, result.failureCode) ??
              "The provider did not complete authorization. Try again.",
            title: "Integration was not connected",
          });
        }
        setLinkFailure(null);
        return;
      }
      const catalog = await client.catalog.load();
      const outcome = resolveThreadLink(
        url,
        catalog.deployments.map(({ authority }) => authority.document.deploymentId),
      );
      if (outcome.kind === "unknown-deployment") {
        // A link this phone cannot act on is said where the person is. Taking
        // them to the Deployments list would abandon whatever they were doing
        // to answer a link that goes nowhere.
        setLinkFailure(outcome.detail);
        return;
      }
      if (outcome.kind !== "open") return;
      setLinkFailure(null);
      const destination: ThreadDestination = {
        deploymentId: outcome.deploymentId,
        threadId: outcome.threadId,
        // A link that names the exact update opens at it, rather than at
        // whatever happens to be newest by the time the app gets there.
        ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
        ...(outcome.requestId === null ? {} : { requestId: outcome.requestId }),
      };
      linkedDeployment.current = outcome.deploymentId;
      const selectionAttempt = linkedSelectionAttempt.current + 1;
      linkedSelectionAttempt.current = selectionAttempt;
      deferredRootSelection.current = undefined;
      // Release the old attachment immediately, then let the destination show
      // the selected Host's honest connecting/offline/sign-in state while its
      // probe finishes. A dead Host must not hold the launch screen up.
      void client.select(outcome.deploymentId).catch((error: unknown) => {
        if (
          !linkedSelectionFailureIsCurrent({
            currentAttempt: linkedSelectionAttempt.current,
            failedAttempt: selectionAttempt,
            failedDeploymentId: outcome.deploymentId,
            linkedDeploymentId: linkedDeployment.current,
          })
        ) {
          return;
        }
        linkedDeployment.current = null;
        observedRootSelection.current = undefined;
        setLinkFailure(
          operationDetail(error, "That deployment could not be opened. You can try again there."),
        );
        observeRootSelection();
      });
      if (navigationRef.isReady()) resetToThread(destination);
      else waiting.current = destination;
    };

    const accept = (url: string): void => {
      // OAuth must be delivered immediately even while the catalog is loading.
      // Thread routing waits because an unloaded catalog cannot say whether the
      // link names a Deployment this phone holds.
      broker.accept(url);
      if (!initialized.current) {
        waitingUrl.current = url;
        return;
      }
      void openApplicationLink(url).catch((error: unknown) => {
        setLinkFailure(
          operationDetail(error, "That link could not be read. Try opening it again."),
        );
      });
    };

    const subscription = Linking.addEventListener("url", ({ url }) => {
      accept(url);
    });

    /**
     * A notification tap is the same event as a link: its validated deep link
     * goes through the one reader above, so a notification can reach exactly
     * the Threads a typed URL could and nothing it carries is ever an
     * instruction to act on a Request.
     */
    const detachOpened = notifications.onOpened((destination) => {
      accept(destination.deepLink);
    });

    void client
      .initialize()
      .then(async () => {
        initialized.current = true;
        // A cold start is read only after the catalog is in memory, so a link
        // is never refused for a Deployment this phone has simply not loaded.
        const initialUrl = await Linking.getInitialURL();
        const queuedUrl = waitingUrl.current;
        const url = queuedUrl ?? initialUrl;
        waitingUrl.current = null;
        if (url !== null) {
          // An event was accepted by the broker when it arrived. A cold-start
          // URL has not crossed that reader yet.
          if (queuedUrl === null) broker.accept(url);
          await openApplicationLink(url);
        }

        const destination = waiting.current;
        const selected = client.getSnapshot().selection.deploymentId;
        setInitialNavigationState(
          destination !== null
            ? threadRoot(destination)
            : selected === null
              ? deploymentsRoot()
              : deploymentRoot(selected),
        );
        // The initial state already contains this destination. A later URL can
        // fill the ref again before onReady and will then replace this stack.
        waiting.current = null;
        await notifications.start();
      })
      .catch((error: unknown) => {
        setStartupFailure({
          detail: operationDetail(error, "Opensteer could not read this device's storage."),
          title: "This device's storage did not answer",
        });
      });

    return () => {
      subscription.remove();
      detachOpened();
      detachBroker();
      notifications.stop();
    };
  }, [broker, client, notifications, observeRootSelection]);

  useEffect(() => {
    /**
     * The registration is re-checked whenever something that decides it may
     * have changed: a return to the foreground, where a permission can have
     * been granted or revoked in the system's own Settings, and a change of
     * signed-in Account. Both are cheap — a pass that would register the same
     * tuple again sends nothing.
     */
    const { registration } = notifications;
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void registration.sync();
      // A Deployment created on the web or on another device reaches this phone
      // only through a directory sync, and coming back to the app is when it is
      // worth asking. The refresh service's own cooldown bounds it.
      void client.foregrounded();
    });
    let subject = client.getSnapshot().account.account.identity?.subject ?? null;
    const detachClient = client.subscribe(() => {
      const next = client.getSnapshot().account.account.identity?.subject ?? null;
      if (next === subject) return;
      subject = next;
      void registration.sync();
    });
    return () => {
      appState.remove();
      detachClient();
    };
  }, [client, notifications]);

  useEffect(() => {
    observeRootSelection();
    return client.subscribe(observeRootSelection);
  }, [client, observeRootSelection]);

  useEffect(() => {
    if (startupRefusal !== null) return;
    void iphone.load().catch(() => undefined);
    // The open Deployment's session is the one this iPhone's controller may
    // use. Opening another Deployment changes that session, never the
    // Deployment the iPhone was added to.
    const attach = (): void => {
      const { selection } = client.getSnapshot();
      iphone.attachHost(
        selection.deploymentId === null || selection.hostClient === null
          ? null
          : { deploymentId: selection.deploymentId, hostClient: selection.hostClient },
      );
    };
    attach();
    return client.subscribe(attach);
  }, [client, iphone]);

  useEffect(() => {
    if (initialNavigationState !== null || startupFailure !== null) {
      void SplashScreen.hideAsync();
    }
  }, [initialNavigationState, startupFailure]);

  if (startupFailure !== null) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View style={styles.failure}>
          <AppText role="displaySmall">Opensteer could not start</AppText>
          <Notice detail={startupFailure.detail} title={startupFailure.title} tone="neutral" />
        </View>
      </SafeAreaProvider>
    );
  }

  if (initialNavigationState === null) return null;

  // The gesture root encloses the navigator, so the sidebar's drag — which
  // lives inside the stack as its layout — is recognised on the UI thread.
  return (
    <GestureHandlerRootView style={styles.root}>
      <DictationProvider>
        <MobileClientProvider client={client}>
          <IphoneAppsProvider controller={iphone}>
            <MobileNotificationsProvider notifications={notifications}>
              <SafeAreaProvider>
                <StatusBar style="light" />
                <IphoneAppsNotice controller={iphone} />
                {linkFailure === null ? null : (
                  <LinkFailure detail={linkFailure} onDismiss={() => setLinkFailure(null)} />
                )}
                {integrationNotice === null ? null : (
                  <IntegrationNotice
                    detail={integrationNotice.detail}
                    onDismiss={() => setIntegrationNotice(null)}
                    title={integrationNotice.title}
                  />
                )}
                <Navigation
                  initialState={initialNavigationState}
                  onReady={handleNavigatorReady}
                  onStateChange={syncDeferredRootSelection}
                  ref={navigationRef}
                  theme={navigationTheme}
                />
                <IphoneAppsPrompt controller={iphone} />
              </SafeAreaProvider>
            </MobileNotificationsProvider>
          </IphoneAppsProvider>
        </MobileClientProvider>
      </DictationProvider>
    </GestureHandlerRootView>
  );
}

/** Names a Deployment the way its row does, for `{Opensteer}`. */
function useOpensteerFor(controller: IphoneAppsController): (deploymentId: string) => string {
  const { rows } = useMobileState();
  const enrollment = useIphoneAppsState(controller).snapshot.enrollment;
  return (deploymentId) =>
    opensteerOn(
      rows.find((row) => row.deploymentId === deploymentId)?.name ??
        (enrollment?.deploymentId === deploymentId ? enrollment.deploymentName : "Opensteer"),
    );
}

/** A request waiting on this iPhone, over whatever is open. */
function IphoneAppsPrompt(props: { readonly controller: IphoneAppsController }): ReactNode {
  const opensteerFor = useOpensteerFor(props.controller);
  return <IphoneApprovalPrompt controller={props.controller} opensteerFor={opensteerFor} />;
}

/** The iPhone stopped sharing, but the Host it was added to could not be told. */
function IphoneAppsNotice(props: { readonly controller: IphoneAppsController }): ReactNode {
  const notice = useIphoneAppsState(props.controller).notice;
  const { rows } = useMobileState();
  if (notice === null) return null;
  const words = iphoneNotTold(
    notice.name,
    opensteerOn(
      rows.find((row) => row.deploymentId === notice.deploymentId)?.name ??
        notice.deploymentName ??
        "this deployment",
    ),
  );
  return (
    <IntegrationNotice
      detail={words.detail}
      onDismiss={() => props.controller.dismissNotice()}
      title={words.title}
    />
  );
}

function IntegrationNotice(props: {
  readonly detail: string;
  readonly onDismiss: () => void;
  readonly title: string;
}): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.linkFailure,
        {
          paddingLeft: space[16] + insets.left,
          paddingRight: space[16] + insets.right,
          paddingTop: insets.top + space[8],
        },
      ]}
    >
      <Notice
        action={{ label: "Dismiss", onPress: props.onDismiss }}
        detail={props.detail}
        title={props.title}
        tone="neutral"
      />
    </View>
  );
}

/**
 * A link this app was handed and could not act on. It sits above the whole
 * navigator, so it takes the safe area itself rather than borrowing a screen's.
 */
function LinkFailure(props: {
  readonly detail: string;
  readonly onDismiss: () => void;
}): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.linkFailure,
        {
          paddingLeft: space[16] + insets.left,
          paddingRight: space[16] + insets.right,
          paddingTop: insets.top + space[8],
        },
      ]}
    >
      <Notice
        action={{ label: "Dismiss", onPress: props.onDismiss }}
        detail={props.detail}
        title="That link could not be opened"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: color.background, flex: 1 },
  linkFailure: { backgroundColor: color.background, paddingBottom: space[8] },
  failure: {
    backgroundColor: color.background,
    flex: 1,
    gap: space[16],
    justifyContent: "center",
    padding: space[24],
  },
});
