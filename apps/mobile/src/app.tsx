import { signInStorage } from "./platform/sign-in-storage.js";
import { thisPhoneNoun } from "./computers/phone-noun.js";
import { createPersonalStreamCache, personalCacheFormat } from "@opensteer/client/host";
import {
  dropEarlierCheckpointFormats,
  fileCheckpointStorage,
  personalSessionLabel,
} from "./client/personal-checkpoint-files.js";
import { AiSharing } from "@opensteer/client/ai-sharing";
import { AiSharingProvider } from "./ui/ai-sharing.js";
import { readAiSharing } from "./client/ai-sharing-storage.js";
import { createBrowsingChoiceStorage } from "./client/browsing-choice-storage.js";
import { notificationPreviewNative } from "../modules/notification-preview/index.js";
import { NotificationPreviews } from "./notifications/notification-preview.js";
import { createExpoSavedViews } from "./platform/expo-saved-views.js";
import { ConnectionPill } from "./ui/connection-shell.js";
import { VoiceOverlay } from "./voice/controls.js";
import { VoiceProvider } from "./voice/context.js";

import { DictationProvider } from "./dictation/context.js";
import * as Application from "expo-application";
import { OAuthDeepLinkBroker, type NativeOAuthIdentity } from "@opensteer/client/auth";
import { parseNativeIntegrationAuthorizationCallback } from "@opensteer/client/integrations";
import { pluginSignInEnd } from "@opensteer/client/plugins";
import { AccountNotificationDevicesClient } from "@opensteer/client/connections";
import {
  buildMobilePairingDeepLink,
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Dimensions, Platform, StyleSheet, View } from "react-native";
import { NavigationContainerRefContext, type InitialState } from "@react-navigation/native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  MockCloudComputerAccount,
  mockIphoneRunnerId,
  type MockHostClient,
} from "@opensteer/client/mock";
import { createNetworkHostPort } from "./client/host-port.js";
import { createMockHostPort } from "./client/mock-host-port.js";
import { OpenComputer } from "./screens/open-computer.js";
import { MobileClient } from "./client/mobile-client.js";
import { forgetDraftFiles } from "./thread/draft-attachments.js";
import {
  mockDeploymentConnections,
  mockIntegrationAuthorizationBrowser,
  mockDeploymentId,
  mockSignedOutDeploymentId,
} from "./client/mock-mode.js";
import { readMobileConfiguration } from "./config.js";
import { resolveRefreshedApplicationLink, routeComputerLink } from "./links.js";
import { PendingDestination } from "./pending-destination.js";
import { Navigation, navigationTheme } from "./navigation.js";
import { sideMemory } from "./side-memory.js";
import { enterSide, navigationRef, reconcileRootSelection, resetRoot } from "./navigation-ref.js";
import { sidebarRef } from "./sidebar/sidebar-context.js";
import { applicationLinkState, deploymentRoot, deploymentsRoot } from "./navigation-state.js";
import { MobileNotifications } from "./notifications/mobile-notifications.js";
import {
  createNotificationsIntroFile,
  NotificationsIntro,
} from "./notifications/notifications-intro.js";
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
import { createPhoneSetupFile } from "./phone-setup/setup-file.js";
import { createRemovedFile } from "./iphone-apps/removed-file.js";
import { networkLeaveDelivery } from "./platform/phone-leave.js";
import { startPhoneBrowserRuntime } from "./phone-browser/runtime.js";
import { createIphoneBrowserPlatform } from "./phone-browser/iphone-platform.js";
import { createAndroidBrowserPlatform } from "./phone-browser/android-platform.js";
import { androidPhoneBridge, enrollAndroidPhone } from "./platform/phone-connection.js";
import { createFakeIphoneApps, type FakeIphoneApps } from "./iphone-apps/fake-bridge.js";
import { iphoneNotTold, opensteerOn } from "./iphone-apps/model.js";
import { createShownApprovalsFile } from "./iphone-apps/shown-approvals-file.js";
import { iphoneApps } from "./platform/iphone-apps.js";
import { AppLinksProvider, type AppLinks } from "./ui/app-links-context.js";
import { MobileClientProvider, useMobileState } from "./ui/mobile-client-context.js";
import { MobileNotificationsProvider } from "./ui/notifications-context.js";
import { Notice } from "./ui/primitives.js";
import { StartupFailureView } from "./startup-failure.js";
import { failureWords } from "./ui/client-feedback.js";
import {
  subscribeToDraftPastes,
  supportsDraftPastes,
} from "../modules/composer-editor/paste-events.js";
import { receiveNativeDraftPastes } from "./thread/draft-attachments.js";

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
    EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN: process.env.EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN,
    EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN: process.env.EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN,
    EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: process.env.EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE,
    EXPO_PUBLIC_OPENSTEER_MOCK: process.env.EXPO_PUBLIC_OPENSTEER_MOCK,
    EXPO_PUBLIC_OPENSTEER_MOCK_SUBAGENTS: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_SUBAGENTS,
    EXPO_PUBLIC_OPENSTEER_MOCK_PLUGINS: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_PLUGINS,
    EXPO_PUBLIC_OPENSTEER_MOCK_AGENTS: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_AGENTS,
    EXPO_PUBLIC_OPENSTEER_MOCK_WORK: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_WORK,
    EXPO_PUBLIC_OPENSTEER_MOCK_CLOUD: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_CLOUD,
    EXPO_PUBLIC_OPENSTEER_MOCK_PHONE: process.env.EXPO_PUBLIC_OPENSTEER_MOCK_PHONE,
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
    const android = Platform.OS === "android";
    fakeIphone = createFakeIphoneApps({
      browser: configuration.mockPhone !== "no-browser",
      erasesOnRestart: android,
      host: (deploymentId) => mockHosts.get(deploymentId) ?? null,
      ...(android
        ? { deviceName: "Pixel 9", offers: [], platform: "android" as const }
        : { runnerId: mockIphoneRunnerId }),
      scenario:
        configuration.mockPhone === "away" || configuration.mockPhone === "needs-update"
          ? configuration.mockPhone
          : null,
    });
    // The mock world's own iPhone, which lends a browser there, is this phone.
    const scene = configuration.mockPhone;
    if (!android && (scene === null || scene === "removed"))
      fakeIphone.device.enrolledTo({ deploymentId: mockDeploymentId, name: "Alex's iPhone" });
    if (!android && scene === "elsewhere")
      fakeIphone.device.enrolledTo({
        deploymentId: mockSignedOutDeploymentId,
        name: "Alex's iPhone",
      });
    if (scene === "removed") {
      const removed = fakeIphone;
      setTimeout(() => removed.device.removedByHost(), 4_000);
    }
  }
  const iphone = new IphoneAppsController({
    bridge: fakeIphone?.bridge ?? androidPhoneBridge ?? iphoneApps,
    deliverLeave: configuration.mock
      ? async (leave) => {
          const host = mockHosts.get(leave.deploymentId);
          if (host === undefined) return "unreachable";
          await host.dispatch({
            idempotencyKey: `leave:${leave.runnerId}`,
            machineId: leave.runnerId,
            type: "machine.revoke",
          });
          return "removed";
        }
      : networkLeaveDelivery((input, init) => mobileHostFetch(input, init)),
    setupFile: createPhoneSetupFile({
      filePath: `${root}${storeName}/phone-setup.json`,
      privateFiles,
    }),
    removedFile: createRemovedFile({
      filePath: `${root}${storeName}/device-removed.json`,
      privateFiles,
    }),
    ...(Platform.OS === "android" && !configuration.mock && androidPhoneBridge !== null
      ? { enrollNative: enrollAndroidPhone }
      : {}),
    shownApprovals: createShownApprovalsFile({
      filePath: `${root}${storeName}/iphone-approvals-shown.json`,
      privateFiles,
    }),
  });
  if (!configuration.mock) {
    const phoneBrowserPlatform =
      Platform.OS === "android"
        ? createAndroidBrowserPlatform()
        : createIphoneBrowserPlatform(iphoneApps);
    if (phoneBrowserPlatform) startPhoneBrowserRuntime(phoneBrowserPlatform);
  }
  const lifecycle = createMobileLifecycle({ appState: AppState, network: Network });
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
          authorization: {
            accountAuthorizationLease: () => client.oauth.accountAuthorizationLease(),
          },
          fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
        }),
        signedInSubject: async () => (await client.oauth.state()).account.identity?.subject ?? null,
      });
  const registration = new PushRegistration({
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
  });
  const notifications = new MobileNotifications({
    intro: new NotificationsIntro({
      file: createNotificationsIntroFile({
        filePath: `${root}${storeName}/notifications-intro.json`,
        privateFiles,
      }),
      registration,
    }),
    port,
    registration,
  });
  const previews = configuration.mock
    ? null
    : new NotificationPreviews(
        notificationPreviewNative,
        notifications.registration,
        port.signedInSubject,
      );
  // Saved state of earlier formats is dropped, not read.
  void dropEarlierCheckpointFormats(privateFiles, `${root}${storeName}`, personalCacheFormat).catch(
    () => undefined,
  );
  const personalStreamCache = createPersonalStreamCache(
    fileCheckpointStorage(
      privateFiles,
      `${root}${storeName}/personal-stream-v${personalCacheFormat}`,
      // Read only once the client exists: saved state lives exactly as long as its session.
      (deploymentId) => personalSessionLabel(client.sessions, () => new Date())(deploymentId),
    ),
  );
  const client: MobileClient = new MobileClient({
    afterMessageSent: () => {
      void notifications.registration.sync();
    },
    notificationPreviews: previews,
    lifecycle,
    ...(!configuration.mock ? { savedViewStore: createExpoSavedViews(storeName) } : {}),
    portalOrigin: configuration.portalOrigin,
    accountOrigin: configuration.accountOrigin,
    ...(configuration.mock
      ? { cloudComputers: new MockCloudComputerAccount(configuration.mockCloud ?? "none") }
      : {}),
    catalogFilePath: `${root}${storeName}/deployments.json`,
    quietSeenFilePath: `${root}${storeName}/quiet-seen.json`,
    draftsFilePath: `${root}${storeName}/drafts-v3.json`,
    forgetDraftFiles,
    forgetMessageFiles: forgetDraftFiles,
    usageNoticesFilePath: `${root}${storeName}/usage-notices.json`,
    fetch: (input, init) => globalThis.fetch(input as RequestInfo, init),
    hostPort: configuration.mock
      ? createMockHostPort({
          hosts: mockHosts,
          subagents: configuration.mockSubagents,
          plugins: configuration.mockPlugins,
          agents: configuration.mockAgents,
          work: configuration.mockWork,
        })
      : createNetworkHostPort({
          browserPreferencesStorage: createBrowsingChoiceStorage(
            new File(`${root}${storeName}/browsing-choices.json`),
          ),
          streamCache: () => personalStreamCache,
          fetch: mobileHostFetch,
          lifecycle,
          now: () => new Date(),
          openWebSocket: openReactNativeSocket,
          origin: {
            app: Platform.OS === "ios" ? "ios" : "android",
            // Android names no tablet; 600dp is its own large-screen breakpoint.
            device: (
              Platform.OS === "ios"
                ? Platform.isPad
                : Math.min(Dimensions.get("screen").width, Dimensions.get("screen").height) >= 600
            )
              ? "tablet"
              : "phone",
          },
        }),
    iphoneApps: iphone.owner,
    oauthIdentity,
    openAuthorization: createAuthorizationBrowser({
      broker,
      browser: WebBrowser,
      oauth: oauthIdentity,
    }),
    openIntegrationAuthorization: configuration.mock
      ? mockIntegrationAuthorizationBrowser()
      : createIntegrationAuthorizationBrowser({ browser: WebBrowser }),
    privateFiles,
    randomBytes: (size) => getRandomValues(new Uint8Array(size)),
    records: createSecureRecordStore({
      keyPrefix: `${storeName}.auth`,
      // Sign-in's Keychain: a refused call reads as one sentence, its exception logged.
      secureStore: signInStorage(SecureStore, thisPhoneNoun),
    }),
    ...(configuration.mock && configuration.mockPhone !== "first-run"
      ? { seed: mockDeploymentConnections() }
      : {}),
    selectionFilePath: `${root}${storeName}/selection.json`,
    signedOutFilePath: `${root}${storeName}/signed-out.json`,
  });
  if (previews) {
    void previews.start().catch(() => {});
    notifications.registration.subscribe(() => {
      void previews.reconcile().catch(() => {});
    });
  }
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
  useEffect(() => {
    if (supportsDraftPastes())
      return receiveNativeDraftPastes(client.drafts, subscribeToDraftPastes);
    return undefined;
  }, [client]);
  const [startupFailure, setStartupFailure] = useState<StartupFailure | null>(startupRefusal);
  const [initialNavigationState, setInitialNavigationState] = useState<InitialState | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState<{
    readonly detail: string;
    readonly title: string;
  } | null>(null);
  const destinations = useMemo(
    () =>
      new PendingDestination({
        receive: (url) => {
          setLinkFailure(null);
          if (broker.accept(url)) return "callback";
          // Connect intent must exist before initialization's singleton-computer shortcut.
          return routeComputerLink(url, (id) => client.openComputer(id));
        },
        resolve: async (url, current, release) => {
          if (parseNativeIntegrationAuthorizationCallback(url) !== null) {
            release();
            setIntegrationNotice(null);
            const result = await client.handleIntegrationAuthorizationCallback(url);
            if (!current() || result === null) return null;
            const end = pluginSignInEnd(result);
            await client.getSnapshot().selection.hostClient?.refresh();
            if (!current()) return null;
            setIntegrationNotice(
              end.kind === "completed"
                ? { detail: "The plugin can use it now.", title: "Account connected" }
                : { detail: end.message, title: "Account wasn't connected" },
            );
            return null;
          }
          const outcome = await resolveRefreshedApplicationLink(url, {
            knownDeployments: async () =>
              (await client.catalog.load()).deployments.map(
                ({ authority }) => authority.document.deploymentId,
              ),
            refreshDirectory: () => {
              release();
              return client.refreshDirectory();
            },
          });
          if (!current() || outcome.kind === "ignore") return null;
          if (outcome.kind === "unknown-deployment") {
            setLinkFailure(outcome.detail);
            return null;
          }
          if (outcome.kind === "pairing" && client.getSnapshot().pendingComputer !== null)
            client.cancelOpenComputer();
          return applicationLinkState(outcome, {
            selectedDeploymentId: client.getSnapshot().selection.deploymentId,
            select: (id) =>
              client.select(id).catch((error: unknown) => {
                if (!current()) return;
                destinations.selectionFailed();
                setLinkFailure(
                  failureWords(
                    error,
                    { label: "open that computer", done: "opened" },
                    "That computer could not be opened. You can try again there.",
                  ) ?? "",
                );
                observeRootSelection();
              }),
          });
        },
        present: (state) => {
          sidebarRef.current?.close();
          const target = state.routes[1];
          const base = state.routes[0];
          const shown = navigationRef.getRootState()?.routes[0];
          if (
            target !== undefined &&
            base?.name === "Home" &&
            shown?.name === "Home" &&
            base.params &&
            "deploymentId" in base.params &&
            shown.params &&
            "deploymentId" in shown.params &&
            base.params.deploymentId === shown.params.deploymentId
          )
            enterSide({ name: target.name, params: target.params ?? {} });
          else resetRoot(state);
        },
        failed: (error) =>
          setLinkFailure(
            failureWords(
              error,
              { label: "open that link", done: "opened" },
              "That link could not be opened. Try opening it again.",
            ) ?? "",
          ),
        settled: () => observeRootSelection(),
      }),
    [broker, client],
  );

  const appLinks = useMemo<AppLinks>(
    () => ({
      openComputer: (id) => {
        void destinations
          .submit(`com.opensteer.mobile:/open?d=${encodeURIComponent(id)}`)
          .catch(() => undefined);
      },
      offerPairing: (offer) => {
        void destinations.submit(buildMobilePairingDeepLink(offer)).catch(() => undefined);
      },
      captureNavigationIntent: destinations.capture,
    }),
    [destinations],
  );

  const observeRootSelection = useCallback((): void => {
    reconcileRootSelection({ destinations, selection: client.getSnapshot().selection });
  }, [client, destinations]);

  const recordNavigation = (): void => {
    const state = navigationRef.getRootState();
    if (state !== undefined) sideMemory.record(state);
    observeRootSelection();
  };

  useEffect(() => {
    if (startupRefusal !== null) return;
    const detachBroker = broker.attach((url) => client.oauth.handleCallback(url));
    const accept = (url: string): Promise<void> => destinations.submit(url);
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void accept(url).catch(() => undefined);
    });
    const detachOpened = notifications.onOpened(({ deepLink }) => accept(deepLink));
    void Linking.getInitialURL()
      .then(async (url) => {
        if (!destinations.received && url !== null) void accept(url).catch(() => undefined);
        await client.initialize();
        destinations.hydrated();
        setInitialNavigationState(
          await destinations.initialState(() => {
            const id = client.getSnapshot().selection.deploymentId;
            return id === null ? deploymentsRoot() : deploymentRoot(id);
          }),
        );
        await notifications.start();
      })
      .catch((error: unknown) => {
        setStartupFailure({
          detail:
            failureWords(
              error,
              { label: "read this device's storage" },
              "Opensteer could not read this device's storage.",
            ) ?? "Opensteer could not read this device's storage.",
          title: "This device's storage did not answer",
        });
      });
    return () => {
      subscription.remove();
      detachOpened();
      detachBroker();
      notifications.stop();
    };
  }, [broker, client, destinations, notifications]);

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
    const sync = (): void => {
      const snapshot = client.getSnapshot();
      const subject = snapshot.account.account.identity?.subject ?? null;
      sideMemory.account(subject);
      if (
        destinations.account(subject) &&
        navigationRef.isReady() &&
        destinations.mayReconcileSelection(snapshot.selection.deploymentId)
      ) {
        const id = snapshot.selection.deploymentId;
        resetRoot(id === null ? deploymentsRoot() : deploymentRoot(id));
      }
      observeRootSelection();
    };
    sync();
    return client.subscribe(sync);
  }, [client, destinations, observeRootSelection]);

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
        <StartupFailureView detail={startupFailure.detail} title={startupFailure.title} />
      </SafeAreaProvider>
    );
  }

  if (initialNavigationState === null) return null;

  // The gesture root encloses the navigator, so the sidebar's drag — which
  // lives inside the stack as its layout — is recognised on the UI thread.
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
        <DictationProvider>
          <MobileClientProvider client={client}>
            <AiSharingProvider
              create={(confirm) => {
                const file = new File(Paths.document, `${storeName}-ai-sharing.json`);
                return new AiSharing({
                  records: readAiSharing(file),
                  confirm,
                  now: () => new Date().toISOString(),
                  save: (records) => {
                    if (!file.exists) file.create({ intermediates: true });
                    file.writeSync(JSON.stringify(records));
                  },
                });
              }}
            >
              <VoiceProvider>
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
                      <AppLinksProvider value={appLinks}>
                        <Navigation
                          initialState={initialNavigationState}
                          onReady={() => {
                            destinations.ready();
                            recordNavigation();
                          }}
                          onStateChange={recordNavigation}
                          ref={navigationRef}
                          theme={navigationTheme}
                        />
                        <ConnectionPill />
                      </AppLinksProvider>
                      <OpenComputer />
                      {/* Outside the navigator: a Request card on the bar still navigates. */}
                      <NavigationContainerRefContext value={navigationRef}>
                        <VoiceOverlay />
                      </NavigationContainerRefContext>
                      <IphoneAppsPrompt controller={iphone} />
                    </SafeAreaProvider>
                  </MobileNotificationsProvider>
                </IphoneAppsProvider>
              </VoiceProvider>
            </AiSharingProvider>
          </MobileClientProvider>
        </DictationProvider>
      </KeyboardProvider>
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
});
