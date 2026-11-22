import { openInChrome } from "./app/open-in-chrome.js";
import { IphoneService } from "./iphone/iphone-service.js";
import { IphoneStore } from "./iphone/iphone-store.js";
import { IphoneSetup } from "./iphone/iphone-setup.js";
import { iphoneMacSupport } from "./iphone/mac-support.js";
import { IphoneBridgeClient } from "./iphone/bridge-client.js";
import {
  bundledIphoneBridgePath,
  verifyIphoneBridge,
  iphoneOwnershipRoot,
} from "./iphone/bridge-paths.js";
import { forwardMedia } from "./app/media-protocol.js";
import { forwardHostRoute } from "./app/host-route.js";
import { PersonalDataReset } from "./supervisor/personal-data-reset.js";
import { desktopPersonalDataReset } from "./app/personal-data-reset.js";
import { resetFileWrites } from "./secrets/reset-file-writes.js";
import { desktopNativeAuthSecretsPath } from "./app/application-paths.js";
import { DesktopBrowserProfileErasure } from "./supervisor/browser-profile-erasure.js";
import { electronProfileRootReleaseState } from "./browser/electron-local-profile.js";
import { DesktopSupervisor } from "./connections/desktop-supervisor.js";
import { DesktopUpdateExecutor } from "./connections/desktop-update-executor.js";
import { DesktopIntegrationAuthorizations } from "./app/integration-authorizations.js";
import { desktopBridgeChannels } from "./bridge/desktop-bridge-channels.js";
import { McpAuthorizationLinks } from "./app/mcp-authorization-links.js";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { autoUpdater } from "electron-updater";
import { loadDesktopUpdatePreference } from "./app/desktop-update-preference.js";
import { DesktopUpdater } from "./app/desktop-updater.js";
import { offerMoveToApplications } from "./app/move-to-applications.js";
import { DesktopWebLinks, routeDesktopUrl } from "./app/web-links.js";
import { DesktopPasskeyRequests } from "./passkeys/passkey-requests.js";
import { createMacosNativePasskeys } from "./passkeys/macos-native-passkeys.js";
import { DesktopDownloads } from "./downloads/desktop-downloads.js";

import { DesktopBrowserPresentationManager } from "./browser/browser-presentation.js";
import { randomBytes } from "node:crypto";
import { ComputerAppSetupGuide, dataGrantSettingsUrls } from "./computer-app-setup-guide.js";
import { homedir, release } from "node:os";
import { DictationService } from "./dictation/dictation-service.js";
import { NativeDictationHelperClient } from "./dictation/helper-client.js";
import { bundledDictationBrokerPath } from "./dictation/paths.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopHostApi } from "./connections/desktop-host-api.js";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  systemPreferences,
  Tray,
} from "electron";
import {
  acquireDesktopApplicationLock,
  configureDesktopApplicationPaths,
  desktopDeploymentCatalogPath,
  prepareDesktopApplicationDirectories,
} from "./app/application-paths.js";
import type { DeploymentAccessUnavailable } from "@opensteer/protocol/desktop";
import { passwordsBrokerProtocolVersion } from "@opensteer/protocol/passwords-broker";
import { DeploymentIdSchema } from "@opensteer/core";
import { AccountDeploymentDirectoryService } from "@opensteer/client/connections";
import { AccountDirectoryRefreshService } from "@opensteer/client/connections";
import { installPublishedAppProtocol } from "./app/published-app-protocol.js";
import { installDesktopAppProtocol, registerDesktopAppScheme } from "./app/app-protocol.js";
import {
  desktopApplicationName,
  readDesktopConfiguration,
  readEmbeddedDesktopRelease,
  type DesktopMode,
  type LoadedDesktopConfiguration,
} from "./config.js";
import { ensureConfiguredDeployment } from "@opensteer/client/connections";
import { DesktopLocalVisibility } from "./app/local-visibility.js";
import { DesktopLoginSession } from "./app/login-session.js";
import { DesktopShutdown } from "./app/desktop-shutdown.js";
import { DesktopMainProcess } from "./app/desktop-main-process.js";
import { registerDesktopBridge } from "./bridge/registration.js";
import { DeploymentAccessService } from "./connections/deployment-access-service.js";
import { DesktopAccessProjection } from "./connections/access-projection.js";
import { DesktopDeploymentProbe } from "./connections/deployment-probe.js";
import { DeploymentCatalogStore, DesktopUpdatesService } from "@opensteer/client/connections";
import type { DeploymentId } from "@opensteer/core";
import { resolveDesktopAppBranding } from "@opensteer/protocol/desktop";
import { desktopLocalHostRuntime } from "./connections/access-projection.js";
import { ElectronHostNetwork } from "./app/electron-host-network.js";
import { ElectronServiceNetwork } from "./app/electron-service-network.js";
import {
  configureDesktopSession,
  desktopWebPreferences,
  desktopWindowForContents,
  ElectronWindowFactory,
} from "./app/electron-window.js";
import { createDesktopApplicationMenu, showDesktopUpdateMenuItem } from "./app/application-menu.js";
import { AgentPhoneAdbServer } from "./app/agent-phone-adb-server.js";
import { DesktopUsbDeviceAccess } from "./app/usb-device-access.js";
import {
  bundledAgentPhoneDirectory,
  readBundledAgentPhoneArtifact,
} from "./agent-phone/agent-phone-artifact.js";
import { keepDesktopAliveWithoutWindows } from "./app/window-lifecycle.js";
import { startLocalBrowserRuntime } from "./supervisor/local-browser-runtime.js";
import {
  electronUtilityProcessFork,
  LocalRunnerService,
} from "./supervisor/local-runner-service.js";
import { DesktopLocalRunnerTargetResolver } from "./supervisor/local-runner-authority.js";
import {
  openAtLoginChoiceFileStore,
  OpenAtLoginPolicy,
  OpenAtLoginService,
  shouldOpenDesktopWindowAtLaunch,
} from "./supervisor/open-at-login.js";
import { attachedHostOrigin, DesktopAppOriginPolicy } from "./app/navigation-policy.js";
import { DesktopHostTransport } from "./connections/host-transport.js";
import { HostSessionExchange } from "@opensteer/client/auth";
import { AccountBrokeredHostSessions, HostSession } from "@opensteer/client/auth";
import { DirectHostRouteService } from "@opensteer/client/connections";
import { NativeOAuthManager } from "@opensteer/client/auth";
import { OAuthDeepLinkBroker } from "@opensteer/client/auth";
import { registerDesktopOAuthProtocolClient } from "./account/oauth-protocol-client.js";
import { DesktopProtectedAuthStore } from "./secrets/protected-auth-store.js";
import { assertDesktopLaunch } from "./app/launch-policy.js";
import { NativePersonalDeploymentCredentials } from "./secrets/personal-deployment-credentials.js";
import {
  NativePersonalDeploymentFilesystem,
  defaultPersonalDeploymentName,
} from "./secrets/personal-deployment-store.js";
import { PersonalDeploymentSupervisor } from "./supervisor/personal-deployment-supervisor.js";
import { NativePersonalUserEnvironment } from "./supervisor/personal-user-environment.js";
import {
  NodePersonalProcessPort,
  readPersonalProcessSupervisorRelease,
  RotatingPersonalLog,
} from "./supervisor/personal-process-port.js";
import {
  NativePersonalHostControl,
  NativePersonalRemoteHostControl,
} from "./supervisor/personal-host-control.js";
import { PrivateDeploymentConnectionService } from "@opensteer/client/connections";
import { DesktopPersonalAccountLinkStore } from "./account/personal-account-link-store.js";
import { DesktopPersonalAccountLinkCoordinator } from "./account/personal-account-link.js";
import { DesktopPersonalAccountService } from "./account/personal-account-service.js";
import { DesktopPersonalAccountMutationCoordinator } from "./account/personal-account-mutation.js";
import { DesktopPersonalDirectoryProjection } from "./account/personal-directory-projection.js";
import { DesktopPersonalHostRemoteAdapter } from "./supervisor/personal-host-remote-adapter.js";
import {
  accountLinkProgressDetail,
  DesktopRemoteAdministrationExecutor,
  remoteAccessProgressDetail,
} from "./connections/remote-administration-executor.js";
import { ConnectOperationIdSchema } from "@opensteer/control-plane-protocol";
import { DesktopPersonalRemoteAccessService } from "./connections/personal-remote-access.js";
import { TailscaleShare, tailscaleCommand } from "./connections/tailscale.js";
import { DesktopConnectCredentialStore } from "./secrets/connect-credential-store.js";
import { VerifiedDesktopSecretCryptography } from "./secrets/verified-secret-cryptography.js";
import { AccountCloudComputerClient, AccountConnectClient } from "@opensteer/client/connections";
import { CloudflaredConnectorSupervisor } from "./supervisor/cloudflared-connector-supervisor.js";
import {
  PersonalHostConnectOrchestrator,
  PersonalHostConnectTeardownCoordinator,
} from "./supervisor/personal-host-connect-orchestrator.js";
import {
  openDesktopPrivateFilesystem,
  openDesktopPrivateFilesystemSync,
} from "./secrets/desktop-private-files.js";
import type { DesktopPrivateFilesystem } from "./secrets/desktop-private-files.js";
import type { PersonalLocalRuntimePort } from "./supervisor/personal-local-runtime.js";
import { probeFullDiskAccess } from "./full-disk-access/full-disk-access-probe.js";
import { FullDiskAccessPanel } from "./full-disk-access/full-disk-access-panel.js";
import { ComputerUseService } from "./computer-use/computer-use-service.js";
import { ComputerUsePermissionsPanel } from "./computer-use/computer-use-permissions-panel.js";
import { ComputerAppSetupPanel } from "./computer-use/computer-app-setup-panel.js";
import {
  bundledComputerUseHelperPath,
  computerUseHelperAppPath,
} from "./computer-use/helper-paths.js";
import { computerName } from "./supervisor/computer-name.js";
import { desktopComputerUseTeamId } from "./computer-use/release-identity.js";
import { bundledPasswordsBrokerPath } from "./passwords/paths.js";
import { PasswordsService } from "./passwords/passwords-service.js";
import { OpensteerOwnOrigins } from "./passwords/own-origins.js";
import { PasswordsLoginAuthority } from "./passwords/login-authority.js";
import { AgentBrowserGate } from "./browser/agent-browser-gate.js";
import { DesktopLocalStop, localStopFileStore } from "./app/local-stop.js";
import { parentedQuitQuestion, quitQuestionParentOptions } from "./app/quit-question.js";
import { activityIdle, DesktopActivity } from "./app/desktop-activity.js";
import { DesktopQuitRouting } from "./app/quit-routing.js";
import { appRoutes, appRouteScript, taskPath } from "./app/app-route.js";
import {
  backgroundNoticeBody,
  backgroundNoticeFileStore,
  backgroundNoticeTitle,
  DesktopBackgroundMode,
} from "./app/background-mode.js";
import {
  DesktopBackgroundUpdate,
  forgetHiddenRelaunch,
  rememberHiddenRelaunch,
  takeHiddenRelaunch,
} from "./app/background-update.js";
import { DesktopMenuBarService } from "./app/menu-bar-service.js";
import { DesktopMenuBar } from "./app/menu-bar.js";
import { createForwardedHostApi } from "./connections/desktop-host-api.js";

registerDesktopAppScheme(protocol);
keepDesktopAliveWithoutWindows(app);
const embeddedRelease = readEmbeddedDesktopRelease(
  fileURLToPath(new URL("./desktop-release.json", import.meta.url)),
);
const oauthDeepLinks = new OAuthDeepLinkBroker({
  ...embeddedRelease.oauth,
  application: "desktop",
});
let openIntegrationReturn: ((deploymentId: string) => Promise<void>) | null = null;
const integrationAuthorizations = new DesktopIntegrationAuthorizations(
  { ...embeddedRelease.oauth, application: "desktop" },
  (deploymentId) => {
    void openIntegrationReturn?.(deploymentId).catch(() =>
      reportEvent("desktop.integration-return.failed", {}),
    );
  },
);
const desktopOAuthLinks = {
  accept: (url: string) => integrationAuthorizations.accept(url) || oauthDeepLinks.accept(url),
};
const mcpAuthorizationLinks = new McpAuthorizationLinks(
  new URL(embeddedRelease.oauth.hostCallback).protocol.slice(0, -1),
);
const webLinks = new DesktopWebLinks((message) => {
  void app
    .whenReady()
    .then(() => {
      activeMainProcess?.focus();
      return dialog.showMessageBox({ type: "info", title: "Opening web links", message });
    })
    .catch(reportFatal);
});
app.once("will-quit", () => webLinks.dispose());
app.once("will-quit", () => void integrationAuthorizations.close());
let activeMainProcess: DesktopMainProcess | null = null;
let desktopLog: RotatingPersonalLog | null = null;
const shutdown = new DesktopShutdown({
  application: app,
  power: powerMonitor,
  log: reportEvent,
  hideWindow: () => activeMainProcess?.hideWindow(),
});
const confirmQuit = parentedQuitQuestion({
  focus: () => app.focus({ steal: true }),
  createParent: () => new BrowserWindow(quitQuestionParentOptions(app.getName())),
  showMessageBox: (parent, options) => dialog.showMessageBox(parent as BrowserWindow, options),
});
const quitRouting = new DesktopQuitRouting({
  shutdown,
  confirm: confirmQuit,
  hideWindows: () => {
    for (const window of BaseWindow.getAllWindows()) window.hide();
  },
  log: reportEvent,
});
quitRouting.installAtReady(app, (quit) =>
  Menu.setApplicationMenu(createDesktopApplicationMenu({ quit, workspaceContents: () => null })),
);
app.on("open-url", (event, url) => {
  if (mcpAuthorizationLinks.accept(url)) {
    event.preventDefault();
    if (!shutdown.requested) void activeMainProcess?.activate().catch(reportFatal);
    return;
  }
  if (desktopOAuthLinks.accept(url)) {
    event.preventDefault();
    return;
  }
  if (!webLinks.accept(url)) return;
  if (!shutdown.requested) void activeMainProcess?.activate().catch(reportFatal);
  event.preventDefault();
});
app.on("second-instance", (_event, argv) => {
  for (const url of argv)
    if (!mcpAuthorizationLinks.accept(url)) routeDesktopUrl(url, desktopOAuthLinks, webLinks);
  if (!shutdown.requested) void activeMainProcess?.activate().catch(reportFatal);
});

if (acceptLaunch()) {
  app.setName(
    desktopApplicationName(
      app.isPackaged,
      embeddedRelease.application.name,
      process.env.OPENSTEER_DESKTOP_MODE?.trim() === "test" ? "test" : defaultMode(),
    ),
  );
  app.setAboutPanelOptions({
    applicationName: resolveDesktopAppBranding(app.getVersion()).displayName,
  });
  app.enableSandbox();
  void startDesktop().catch((error: unknown) => {
    if (shutdown.requested) return;
    reportFatal(error);
    shutdown.request("startup-failed");
  });
}

async function startDesktop(): Promise<void> {
  const loaded = readDesktopConfiguration({
    appDataDirectory: app.getPath("appData"),
    defaultMode: defaultMode(),
    packaged: app.isPackaged,
    resourcesDirectory: process.resourcesPath,
  });
  const privateFiles = openDesktopPrivateFilesystemSync({
    binary: loaded.config.localExecution.nativeFsHelperBinary,
    root: loaded.config.dataDirectory,
  });
  prepareDesktopApplicationDirectories(privateFiles);
  configureDesktopApplicationPaths(app, loaded.config.dataDirectory);
  if (!acquireDesktopApplicationLock(app)) {
    process.stdout.write(`${JSON.stringify({ event: "desktop.already_running" })}\n`);
    app.quit();
    return;
  }
  desktopLog = new RotatingPersonalLog(
    path.join(loaded.config.dataDirectory, "logs", "desktop.log"),
  );
  app.once("will-quit", () => desktopLog?.close());
  await app.whenReady();
  await privateFiles
    .removeFile(path.join(loaded.config.dataDirectory, "computer-use-approval-key.v1.json"))
    .catch(() => undefined);
  shutdown.signal.throwIfAborted();
  // Only a build that updates itself needs to live in Applications.
  if (loaded.config.updates && (await offerMoveToApplications(reportEvent))) return;
  shutdown.signal.throwIfAborted();
  for (const url of process.argv)
    if (!mcpAuthorizationLinks.accept(url)) routeDesktopUrl(url, desktopOAuthLinks, webLinks);
  await runDesktop(loaded, privateFiles);
}

async function runDesktop(
  loaded: LoadedDesktopConfiguration,
  privateFiles: DesktopPrivateFilesystem,
): Promise<void> {
  await app.whenReady();
  shutdown.signal.throwIfAborted();
  const profileErasure = new DesktopBrowserProfileErasure(
    loaded.config.dataDirectory,
    electronProfileRootReleaseState,
  );
  await profileErasure.finishPending();
  registerDesktopOAuthProtocolClient({
    application: app,
    defaultApp: process.defaultApp,
    entryArgument: process.argv[1],
    executablePath: process.execPath,
    scheme: new URL(loaded.config.release.oauth.accountCallback).protocol.slice(0, -1),
  });
  const uninstallAppProtocol = installDesktopAppProtocol(
    protocol,
    path.join(import.meta.dirname, "web"),
    (request) => reportEvent("desktop.app-protocol.slow", request),
    {
      host: (request) => forwardHostRoute(request, hostTransport),
      media: (request) => forwardMedia(request, (id) => hostTransport.mediaTransport(id)),
    },
  );
  const updater = new DesktopUpdater({
    updates: loaded.config.updates,
    log: reportEvent,
    preference: await loadDesktopUpdatePreference(loaded.config.dataDirectory, reportEvent),
  });
  const downloads = new DesktopDownloads({
    directory: () => app.getPath("downloads"),
    staging: path.join(loaded.config.dataDirectory, "partial-downloads"),
  });
  shutdown.add({
    component: "downloads",
    step: "close",
    order: 5,
    timeoutMs: 3_000,
    stop: () => downloads.close(),
  });
  const usbDevices = new DesktopUsbDeviceAccess();
  const phoneAdb = new AgentPhoneAdbServer({ isGranted: (device) => usbDevices.isGranted(device) });
  const detachPhoneAdb = usbDevices.onRevoked((device) => phoneAdb.revoke(device));
  const appOriginPolicy = new DesktopAppOriginPolicy();
  configureDesktopSession(session.defaultSession, appOriginPolicy, usbDevices, downloads, () =>
    attachedHostOrigin(hostTransport),
  );
  const detachUsbDevices = usbDevices.attach(session.defaultSession);

  let fatal = false;
  let mainProcess: DesktopMainProcess;
  let background: DesktopBackgroundMode | null = null;
  let backgroundUpdate: DesktopBackgroundUpdate | null = null;
  let appWindow: import("./app/electron-window.js").ElectronAppWindow | null = null;
  const windowVisible = () =>
    appWindow !== null &&
    !appWindow.isDestroyed() &&
    appWindow.isVisible() &&
    !appWindow.isMinimized();
  const browserPagePolicyPreloadPath = path.join(import.meta.dirname, "browser-page-preload.cjs");
  const resetWrites = resetFileWrites(privateFiles, [
    desktopDeploymentCatalogPath(loaded.config.dataDirectory),
    desktopNativeAuthSecretsPath(loaded.config.dataDirectory),
    path.join(loaded.config.dataDirectory, "personal-deployment.v1.json"),
  ]);
  const personalFiles = new NativePersonalDeploymentFilesystem({
    dataDirectory: loaded.config.dataDirectory,
    privateFiles: resetWrites.files,
  });
  const deploymentCatalog = new DeploymentCatalogStore({
    filePath: desktopDeploymentCatalogPath(loaded.config.dataDirectory),
    localPersonalManifest: personalFiles,
    privateFiles: resetWrites.files,
  });
  const hostNetwork = new ElectronHostNetwork();
  const serviceNetwork = new ElectronServiceNetwork();
  const protectedStorage = new VerifiedDesktopSecretCryptography(safeStorage, {
    onVerificationFailure: ({ error, phase }) =>
      reportNonFatal(
        "desktop.protected-storage.verification-failed",
        new Error(`${phase}: ${safeErrorMessage(error)}`),
      ),
  });
  const dataReset = new PersonalDataReset({
    dataDirectory: loaded.config.dataDirectory,
    cryptography: protectedStorage,
  });
  const pendingReset = await dataReset.pending();
  if (pendingReset) await dataReset.execute(pendingReset);
  if (loaded.config.hostUrl) {
    await ensureConfiguredDeployment({
      catalog: deploymentCatalog,
      hostUrl: loaded.config.hostUrl,
      personalDeploymentName: defaultPersonalDeploymentName(),
    });
  }
  const resourcesDirectory = path.dirname(loaded.config.personal.releaseDirectory);
  const personalUserEnvironment = new NativePersonalUserEnvironment();
  const hostControl = new NativePersonalHostControl({
    fetch: (deploymentId, input, init) => hostNetwork.partitionFetch(deploymentId, input, init),
  });
  // Computer use owns the helper for every supervised slot on this Mac, so it
  // is built before anything that supervises one.
  const iphoneFiles =
    process.platform === "darwin"
      ? await openDesktopPrivateFilesystem({
          binary: loaded.config.localExecution.nativeFsHelperBinary,
          root: iphoneOwnershipRoot(loaded.config.dataDirectory),
        })
      : privateFiles;
  const iphoneBridgeLog = new RotatingPersonalLog(
    path.join(loaded.config.dataDirectory, "logs", "iphone-bridge.log"),
    false,
  );
  app.once("will-quit", () => iphoneBridgeLog.close());
  const iphone = new IphoneService({
    store: new IphoneStore(privateFiles, iphoneFiles),
    supported: process.platform === "darwin",
    mac: iphoneMacSupport,
    startNative: async () => {
      const binary = await verifyIphoneBridge({
        binary: bundledIphoneBridgePath({
          developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        }),
        packaged: app.isPackaged,
      });
      return IphoneBridgeClient.start({
        binary,
        log: (line) => iphoneBridgeLog.append("stderr", line),
        supervisorExecutable: readPersonalProcessSupervisorRelease(resourcesDirectory),
        privateRoot: iphoneFiles.root,
        imageRoots: (await iphoneMacSupport.inspect()).imageRoots,
        environment: {
          [processSupervisorExecutableVariable]:
            readPersonalProcessSupervisorRelease(resourcesDirectory),
        },
      });
    },
  });
  const iphoneSetup = new IphoneSetup(iphone);
  shutdown.add({
    component: "iphone",
    step: "stop",
    order: 49,
    timeoutMs: 5000,
    stop: async () => {
      try {
        await iphoneSetup.stop();
      } finally {
        await iphone.stop();
      }
    },
  });
  let iphoneSuspension = Promise.resolve();
  let iphonePowerRevision = 0;
  const suspendIphones = () => {
    iphonePowerRevision++;
    iphoneSuspension = iphoneSuspension
      .then(() => iphoneSetup.stop())
      .finally(() => iphone.suspend())
      .catch(() => undefined);
  };
  powerMonitor.on("suspend", suspendIphones);
  shutdown.add({
    component: "iphone",
    step: "detach-power",
    order: 1,
    timeoutMs: 1000,
    stop: () => {
      powerMonitor.removeListener("suspend", suspendIphones);
    },
  });
  void iphone.start().catch(() => reportEvent("desktop.iphone.unavailable"));
  const computerUse = new ComputerUseService({
    appBundleId: loaded.config.release.id,
    appVersion: app.getVersion(),
    bundledHelperPath: () =>
      bundledComputerUseHelperPath({
        developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    log: (event, fields) => reportEvent(event, fields),
    teamId: desktopComputerUseTeamId(app.isPackaged),
  });
  shutdown.add({
    component: "computer-use",
    step: "stop",
    order: 50,
    timeoutMs: 2_000,
    stop: () => computerUse.stop(),
  });
  // One Opensteer Passwords connection for this desktop. A development build
  // talks only to the development broker, whose vault holds test data.
  const dictation = new DictationService({
    platform: process.platform,
    arch: process.arch,
    osMajor: Number(release().split(".")[0]),
    translated: app.runningUnderARM64Translation,
    openSettings: () =>
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      ),
    client: new NativeDictationHelperClient({
      development: !app.isPackaged,
      bundledAppPath: bundledDictationBrokerPath({
        developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    }),
  });
  const interruptDictation = () => dictation.interrupt();
  powerMonitor.on("suspend", interruptDictation);
  powerMonitor.on("lock-screen", interruptDictation);
  app.once("before-quit", () => {
    dictation.close();
    powerMonitor.removeListener("suspend", interruptDictation);
    powerMonitor.removeListener("lock-screen", interruptDictation);
  });
  const passwords = new PasswordsService({
    appVersion: app.getVersion(),
    bundledBrokerPath: () =>
      bundledPasswordsBrokerPath({
        developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    development: !app.isPackaged,
    protocolVersion: passwordsBrokerProtocolVersion,
    log: (event, fields) => reportEvent(event, fields),
  });
  const ownOrigins = new OpensteerOwnOrigins({
    accountUrl: loaded.config.accountUrl,
    catalog: deploymentCatalog,
  });
  const passwordsLoginAuthority =
    process.platform === "darwin"
      ? new PasswordsLoginAuthority({
          broker: passwords.broker(),
          ownOrigins: ownOrigins.current,
          observeStatus: (listener) => passwords.onStatusChanged(listener),
        })
      : undefined;
  shutdown.add({
    component: "passwords",
    step: "stop",
    order: 60,
    timeoutMs: 2_000,
    stop: async () => {
      await Promise.allSettled([passwordsLoginAuthority?.close(), passwords.stop()]);
    },
  });
  await ownOrigins.refresh();
  shutdown.signal.throwIfAborted();
  const unsubscribeOwnOrigins = deploymentCatalog.subscribe(() => {
    ownOrigins
      .refresh()
      .catch((error: unknown) => reportNonFatal("desktop.passwords.own-origins-failed", error));
  });
  const bridgeToken = randomBytes(32).toString("base64url");
  const preloadPath = path.join(import.meta.dirname, "preload.cjs");
  const panelWebPreferences = desktopWebPreferences(loaded.config, bridgeToken, preloadPath);
  const agentBrowserGate = new AgentBrowserGate();
  const personalLocalRuntimes: PersonalLocalRuntimePort = {
    startBrowser: (input) =>
      startLocalBrowserRuntime({
        downloads,
        logPath: path.join(loaded.config.dataDirectory, "logs", "personal-browser.log"),
        pagePolicyPreloadPath: browserPagePolicyPreloadPath,
        registerPresentationSource: (source) => browserPresentation.registerSource(source),
        profileRoot: input.paths.browserProfileRoot,
        runtimeId: input.runtimeId,
        agentGate: agentBrowserGate,
        ...(passwordsLoginAuthority ? { loginAuthority: passwordsLoginAuthority } : {}),
      }),
  };
  const processSupervisorExecutable = readPersonalProcessSupervisorRelease(resourcesDirectory);
  const computerUseForSlots = {
    startForSlot: (
      id: string,
      owner: { deploymentId: string; hostInstanceId: string; runnerId: string },
    ) => computerUse.startForSlot(id, passwordsLoginAuthority, iphone.forSlot(owner)),
    workerDisconnected: (id: string) => computerUse.workerDisconnected(id),
    stopForSlot: async (id: string) => {
      try {
        await iphoneSetup.stopForSlot(id);
      } finally {
        try {
          await iphone.stopForSlot(id);
        } finally {
          await computerUse.stopForSlot(id);
        }
      }
    },
  };
  const localStopPath = path.join(loaded.config.dataDirectory, "local-stop.json");
  const personal = new PersonalDeploymentSupervisor({
    agentsStoppedSince: () => localStop.agentsStoppedSince,
    onContainedBoot: (mode: string) => localStop.noteContainedBoot(mode),
    onUncontainedBoot: (mode: string) => localStop.noteUncontainedBoot(mode),
    userDataDirectory: app.getPath("userData"),
    accountIssuer: loaded.config.accountUrl,
    extraCertificateAuthorities: loaded.config.extraCertificateAuthorities,
    catalog: deploymentCatalog,
    computerUse: computerUseForSlots,
    credentials: new NativePersonalDeploymentCredentials(protectedStorage, { privateFiles }),
    dataReset,
    files: personalFiles,
    host: hostControl,
    localRuntimes: personalLocalRuntimes,
    processes: new NodePersonalProcessPort({
      logsDirectory: path.join(loaded.config.dataDirectory, "logs"),
      supervisorExecutable: processSupervisorExecutable,
    }),
    passkeys: loaded.config.personal.passkeys === true,
    portalOrigin: loaded.config.portalUrl,
    releaseDirectory: loaded.config.personal.releaseDirectory,
    userEnvironment: personalUserEnvironment,
    log: reportEvent,
  });
  shutdown.add({
    component: "personal",
    step: "stop",
    order: 40,
    timeoutMs: 22_000,
    stop: (signal) => personal.stop(signal),
  });
  shutdown.signal.addEventListener("abort", () => personal.quiesce(), { once: true });
  const protectedAuthStore = new DesktopProtectedAuthStore({
    cryptography: protectedStorage,
    dataDirectory: loaded.config.dataDirectory,
    privateFiles: resetWrites.files,
  });
  const personalRemoteHost = new NativePersonalRemoteHostControl({
    executorAuthorization: (runtime) => personal.executorAuthorization(runtime),
    fetch: (deploymentId, input, init) => {
      shutdown.signal.throwIfAborted();
      return hostNetwork.partitionFetch(deploymentId, input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([shutdown.signal, init.signal]) : shutdown.signal,
      });
    },
  });
  let deviceLifecycle: LocalRunnerService | undefined;
  const sessionOwners = new Set<HostSession>();
  const accountBrokeredHostSessions = new AccountBrokeredHostSessions({
    catalog: deploymentCatalog,
    clearDeploymentSession: (deploymentId) => hostNetwork.clearDeploymentSession(deploymentId),
  });
  const nativeAuth = new NativeOAuthManager({
    beforeHostChange: async (connection) => {
      hostTransport.closeDeploymentConnections(connection.authority.document.deploymentId);
    },
    beforeAccountIdentityChange: async (next) => {
      if (!deviceLifecycle) throw new Error("Device membership is still loading.");
      await deviceLifecycle.leaveAccountMemberships(next ?? undefined);
    },
    accountOrigin: loaded.config.accountUrl,
    accountSessions: accountBrokeredHostSessions,
    catalog: deploymentCatalog,
    fetch: serviceNetwork.fetch.bind(serviceNetwork),
    openExternal: async (url) => {
      await shell.openExternal(url, { activate: true });
    },
    oauth: loaded.config.release.oauth,
    store: protectedAuthStore,
  });
  await nativeAuth.initialize();
  shutdown.signal.throwIfAborted();
  await nativeAuth.reconcileCatalog();
  shutdown.signal.throwIfAborted();
  const personalAccountLinks = new DesktopPersonalAccountLinkStore({
    cryptography: protectedStorage,
    dataDirectory: loaded.config.dataDirectory,
    privateFiles,
  });
  const personalAccountMutations = new DesktopPersonalAccountMutationCoordinator();
  const personalDirectoryProjection = new DesktopPersonalDirectoryProjection({
    host: personalRemoteHost,
    links: personalAccountLinks,
    manifest: personalFiles,
    mutations: personalAccountMutations,
    runtime: personal,
  });
  const accountDirectory = new AccountDeploymentDirectoryService({
    accountOrigin: loaded.config.accountUrl,
    authorization: nativeAuth,
    catalog: deploymentCatalog,
    fetch: serviceNetwork.fetch.bind(serviceNetwork),
    personalProjection: (deployment, source, signal) =>
      personalDirectoryProjection.project(deployment, source, signal),
  });
  const hostSessionExchange = new HostSessionExchange({
    account: accountDirectory,
    application: loaded.config.release.oauth.application,
    fetch: (deploymentId, input, init) => hostNetwork.partitionFetch(deploymentId, input, init),
  });
  const accessProjection = new DesktopAccessProjection({
    catalog: deploymentCatalog,
    localRuntime: personal,
    supervisedDeploymentId: async () => (await personalFiles.load())?.deploymentId ?? null,
  });
  const deviceSessionOptions = {
    assertSessionAllowed: async (deploymentId: string) => {
      if (!deviceLifecycle) throw new Error("Device membership is still loading.");
      await deviceLifecycle.assertSessionAllowed(deploymentId);
    },
    onSessionEnded: async (attachment: import("@opensteer/client/auth").SelectedAttachment) => {
      if (attachment.resolved.access !== "owner")
        await deviceLifecycle?.sessionLost(attachment.resolved.deploymentId);
    },
    onUnauthorized: async (attachment: import("@opensteer/client/auth").SelectedAttachment) => {
      if (attachment.resolved.access !== "owner")
        await deviceLifecycle?.sessionLost(attachment.resolved.deploymentId);
    },
  };
  const sessionsForAttachment = (attachment: import("@opensteer/client/auth").HostAttachment) => {
    const sessions: HostSession = new HostSession({
      ...deviceSessionOptions,
      attachment,
      onDispose: () => sessionOwners.delete(sessions),
      clearDeploymentSession: (id) => hostNetwork.clearDeploymentSession(id),
      exchange: hostSessionExchange,
      localOwner: personal,
      oauth: nativeAuth,
    });
    sessionOwners.add(sessions);
    return sessions;
  };
  const hostSessions = new HostSession({
    ...deviceSessionOptions,
    accountCredentialRejected: () =>
      nativeAuth
        .notifyAccountCredentialRejected()
        .catch((error: unknown) => reportNonFatal("desktop.account.rejected", error)),
    // The transport owns the one resolution and the one fence, so the session
    // reads it rather than resolving the catalog a second time. The closure
    // breaks the construction cycle between the two.
    attachment: {
      current: () => hostTransport.current(),
      currentKey: () => hostTransport.currentKey(),
    },
    clearDeploymentSession: (deploymentId) => hostNetwork.clearDeploymentSession(deploymentId),
    exchange: hostSessionExchange,
    localOwner: personal,
    oauth: nativeAuth,
  });
  sessionOwners.add(hostSessions);
  const hostTransport = new DesktopHostTransport({
    withPreparedEnrollment: (deploymentId, command, operation) => {
      if (!deviceLifecycle) throw new Error("Device membership is still loading.");
      return deviceLifecycle.withPreparedEnrollment(deploymentId, command, operation);
    },
    observeCommand: async (deploymentId, command, result) =>
      deviceLifecycle?.observeHostCommand(deploymentId, command, result),
    catalog: deploymentCatalog,
    log: reportEvent,
    credentials: nativeAuth,
    localRuntime: personal,
    network: hostNetwork,
    projection: accessProjection,
    sessions: hostSessions,
    pinnedSessions: sessionsForAttachment,
  });
  hostTransport.onAttachmentInvalidated(() => appOriginPolicy.setAttachedHost(null));
  const deploymentUpdates = new Map<DeploymentId, DesktopUpdatesService>();
  const deploymentUpdatesFor = (deploymentId: DeploymentId): DesktopUpdatesService => {
    const existing = deploymentUpdates.get(deploymentId);
    if (existing) return existing;
    const created = new DesktopUpdatesService({
      catalog: deploymentCatalog,
      credentials: nativeAuth,
      deploymentId,
      localRuntime: { current: async () => desktopLocalHostRuntime(await personal.current()) },
      network: hostNetwork,
      sessions: (attachment) => {
        const sessions = sessionsForAttachment(attachment);
        return {
          assertSessionAllowed: (deploymentId) => sessions.assertSessionAllowed(deploymentId),
          sessionEnded: (selected) => sessions.sessionEnded(selected),
          recoverUnauthorized: async (selected) => {
            const outcome = await sessions.recoverUnauthorized(selected);
            if (outcome === "account-required") await nativeAuth.notifyAccountCredentialRejected();
            return outcome;
          },
        };
      },
    });
    deploymentUpdates.set(deploymentId, created);
    return created;
  };
  const uninstallPublishedAppProtocol = installPublishedAppProtocol(protocol, hostTransport);
  const nativePasskeys = createMacosNativePasskeys();
  const browserPresentation = new DesktopBrowserPresentationManager({
    transport: hostTransport,
    autofillPreload: path.join(import.meta.dirname, "autofill-preload.cjs"),
    glassPreload: path.join(import.meta.dirname, "glass-preload.cjs"),
    onError: (error) => reportNonFatal("desktop.browser.presentation-failed", error),
    quit: () => quitRouting.actions.hide(),
  });
  const passkeys = new DesktopPasskeyRequests({
    presentations: browserPresentation,
    native: nativePasskeys,
    ownOrigins: ownOrigins.current,
    refreshOwnOrigins: () => ownOrigins.refresh(),
    transport: hostTransport,
    windowForContents: desktopWindowForContents,
  });
  const closeClearedAccountSockets = accountBrokeredHostSessions.subscribe((deploymentIds) => {
    for (const deploymentId of deploymentIds)
      hostTransport.closeDeploymentConnections(DeploymentIdSchema.parse(deploymentId));
  });
  const localRunner = new LocalRunnerService(loaded.config, {
    agentsStoppedSince: () => localStop.agentsStoppedSince,
    onUncontainedBoot: (mode: string) => localStop.noteUncontainedBoot(mode),
    assertAccountSource: (source) => nativeAuth.assertAccountSource(source),
    fenceDeployment: (deploymentId) => {
      for (const sessions of sessionOwners) sessions.blockDeployment(deploymentId);
      hostTransport.closeDeploymentConnections(deploymentId);
    },
    allowDeployment: async (deploymentId) => {
      await Promise.all(
        [...sessionOwners].map((sessions) => sessions.allowDeployment(deploymentId)),
      );
    },
    clearDeploymentSession: (deploymentId) => hostNetwork.clearDeploymentSession(deploymentId),
    leaveFetch: serviceNetwork.fetch.bind(serviceNetwork),
    hostApi: (deploymentId, origin) =>
      createDesktopHostApi({
        origin,
        fetch: (input, init) => hostNetwork.partitionFetch(deploymentId, input, init),
      }),
    profileErasure,
    log: reportEvent,
    browser: (input) =>
      startLocalBrowserRuntime({
        downloads,
        logPath: input.logPath,
        pagePolicyPreloadPath: browserPagePolicyPreloadPath,
        registerPresentationSource: (source) => browserPresentation.registerSource(source),
        profileRoot: input.profileRoot,
        runtimeId: input.runtimeId,
        agentGate: agentBrowserGate,
      }),
    computerUse: computerUseForSlots,
    fork: (module, args, options) =>
      electronUtilityProcessFork(utilityProcess.fork)(module, args, {
        ...options,
        env: { ...options.env, [processSupervisorExecutableVariable]: processSupervisorExecutable },
      }),
    targets: new DesktopLocalRunnerTargetResolver({
      catalog: deploymentCatalog,
      supervisedDeploymentId: async () => (await personalFiles.load())?.deploymentId ?? null,
    }),
    userEnvironment: personalUserEnvironment,
  });
  shutdown.signal.addEventListener("abort", () => localRunner.quiesce(), { once: true });
  deviceLifecycle = localRunner;
  shutdown.add({
    component: "local-runners",
    step: "stop",
    order: 30,
    timeoutMs: 8_000,
    stop: (signal) => localRunner.shutdown(signal),
  });
  const localStop = new DesktopLocalStop({
    restart: async () => {
      const results = await Promise.allSettled([
        personal.restartForAgentMode(),
        localRunner.restartForAgentMode(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : "Couldn't confirm that everything stopped.",
            ]
          : [],
      );
      if (errors.length) throw new Error(errors.join(" "));
    },
    confirm: (stoppedSince, signal) => personal.waitForStopProof(stoppedSince, signal),
    store: localStopFileStore(localStopPath),
    log: reportEvent,
  });
  shutdown.signal.addEventListener("abort", () => localStop.dispose(), { once: true });
  // Before any Runner starts: a Stop the person left in place still holds.
  await localStop.restore();
  shutdown.signal.throwIfAborted();
  const openAtLogin = new OpenAtLoginPolicy({
    service: new OpenAtLoginService({
      applicationName: app.getName(),
      environment: process.env,
      executablePath: process.execPath,
      homeDirectory: homedir(),
      packaged: app.isPackaged,
      platform: process.platform,
      setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    }),
    choices: openAtLoginChoiceFileStore(
      path.join(loaded.config.dataDirectory, "open-at-login.json"),
    ),
    systemEnabled: () =>
      app.isPackaged && process.platform === "darwin"
        ? app.getLoginItemSettings().openAtLogin
        : null,
  });
  const openAtLoginEligibility = async () => ({
    hostsHome: (await personalFiles.load()) !== null,
    enrolledRunners: await localRunner.hasEnrolledRunners(),
  });
  let openAtLoginTail = Promise.resolve();
  const syncOpenAtLogin = () => {
    if (shutdown.requested) return;
    openAtLoginTail = openAtLoginTail
      .then(async () => {
        const eligibility = await openAtLoginEligibility();
        if (!shutdown.requested) await openAtLogin.sync(eligibility);
      })
      .catch((error: unknown) => reportNonFatal("desktop.open-at-login.failed", error));
  };
  const chooseOpenAtLogin = (on: boolean): Promise<void> => {
    const choosing = openAtLoginTail.then(async () => {
      await openAtLogin.choose(on, await openAtLoginEligibility());
    });
    openAtLoginTail = choosing.catch((error: unknown) =>
      reportNonFatal("desktop.open-at-login.failed", error),
    );
    return choosing;
  };
  const detachOpenAtLogin = localRunner.subscribe(syncOpenAtLogin);
  let openAtLoginHome = personal.status.deploymentId;
  const detachOpenAtLoginHome = personal.subscribe((status) => {
    if (status.deploymentId === openAtLoginHome) return;
    openAtLoginHome = status.deploymentId;
    syncOpenAtLogin();
  });
  syncOpenAtLogin();
  // Deployments are created away from this device, so the catalog is kept as a
  // projection of the Account directory: the app syncs when it becomes active
  // again rather than polling, and one cooldown covers every trigger.
  const accountDirectoryRefresh = new AccountDirectoryRefreshService<
    Awaited<ReturnType<DesktopHostTransport["selection"]>>
  >({
    eligible: async () =>
      accountDirectory.accountOrigin !== null &&
      (await nativeAuth.state()).account.status === "signed-in",
    observe: (event) => {
      // Background freshness is best effort and never interrupts the user.
      if (event.outcome !== "failed") return;
      reportEvent("desktop.account-directory.refresh-failed", {
        message: safeErrorMessage(event.error),
        trigger: event.trigger,
      });
    },
  });
  const personalAccountLink = new DesktopPersonalAccountLinkCoordinator({
    account: accountDirectory,
    host: personalRemoteHost,
    manifest: personalFiles,
    mutations: personalAccountMutations,
    runtime: personal,
    store: personalAccountLinks,
  });
  const personalHostRemote = new DesktopPersonalHostRemoteAdapter({
    host: personalRemoteHost,
    runtime: personal,
  });
  const personalConnectStore = new DesktopConnectCredentialStore({
    cryptography: protectedStorage,
    dataDirectory: loaded.config.dataDirectory,
    privateFiles,
  });
  const accountConnect = loaded.config.accountUrl
    ? new AccountConnectClient({
        accountOrigin: loaded.config.accountUrl,
        authorization: nativeAuth,
        fetch: serviceNetwork.fetch.bind(serviceNetwork),
      })
    : null;
  const personalRemote = new DesktopPersonalRemoteAccessService({
    connectFactory: (runtime) => {
      const supervisor = new CloudflaredConnectorSupervisor({
        fetch: serviceNetwork.fetch.bind(serviceNetwork),
        privateFiles,
        resourcesDirectory,
        runtime: personal,
      });
      const teardown = new PersonalHostConnectTeardownCoordinator({
        deploymentId: runtime.discovery.deploymentId,
        projection: personalHostRemote,
        revocation: personalHostRemote,
        runtime: personal,
        store: personalConnectStore,
        supervisor,
      });
      return {
        management: accountConnect
          ? new PersonalHostConnectOrchestrator({
              controlPlane: {
                provision: (_deploymentId, request) =>
                  personalRemoteHost.connectCredential(runtime, request, false),
                rotate: (_deploymentId, request) =>
                  personalRemoteHost.connectCredential(runtime, request, true),
              },
              deploymentId: runtime.discovery.deploymentId,
              projection: personalHostRemote,
              routes: personalHostRemote,
              runtime: personal,
              store: personalConnectStore,
              supervisor,
              teardown,
            })
          : null,
        teardown,
      };
    },
    connectUnavailableDetail: loaded.config.accountUrl
      ? null
      : "Opensteer Connect isn't available yet.",
    host: personalHostRemote,
    log: reportNonFatal,
    mutations: personalAccountMutations,
    runtime: personal,
    tailscale: new TailscaleShare({
      // The person's login PATH, where a Homebrew or package-manager CLI lives.
      command: tailscaleCommand(async () => {
        const login = await personalUserEnvironment.resolve().catch(() => null);
        return { ...process.env, ...(login?.PATH ? { PATH: login.PATH } : {}) };
      }),
      files: privateFiles,
      recordPath: path.join(loaded.config.dataDirectory, "tailscale-share.json"),
    }),
  });
  shutdown.add({
    component: "remote-access",
    step: "stop",
    order: 20,
    timeoutMs: 5_000,
    stop: (signal) => personalRemote.shutdown(signal),
  });
  const personalAccount = new DesktopPersonalAccountService({
    account: accountDirectory,
    host: personalHostRemote,
    link: personalAccountLink,
    links: personalAccountLinks,
    manifest: personalFiles,
    mutations: personalAccountMutations,
    remote: personalRemote,
    runtime: personal,
  });
  let desktopUpdateExecutor: DesktopUpdateExecutor | null = null;
  let desktopSupervisorReady = false;
  const desktopSupervisor = new DesktopSupervisor({
    state: () => updater.state(),
    authorization: (runtime) => personal.executorAuthorization(runtime),
    network: hostNetwork,
    runtime: personal,
  });
  const remoteAdministrationExecutor = new DesktopRemoteAdministrationExecutor({
    supervisor: desktopSupervisor,
    execute: async (operation, progress) => {
      const report = (detail: string | null) => {
        if (detail) progress(detail);
      };
      const detachRemote = personalRemote.subscribe((status) =>
        report(remoteAccessProgressDetail(status.phase)),
      );
      const detachAccount = personalAccount.subscribe((status) =>
        report(accountLinkProgressDetail(status)),
      );
      try {
        const intent = operation.intent;
        // Recover reuses the failed action's execution ID while issuing a new operation ID.
        if (intent.action === "recover" || operation.executionId !== operation.id)
          await personalAccount.recover();
        if (intent.action === "configure") {
          await personalRemote.configure({
            mode: intent.mode,
            privateOrigin: intent.privateOrigin,
          });
        } else if (intent.action === "rotate") {
          await personalRemote.rotate(
            ConnectOperationIdSchema.parse(`cop_${operation.executionId}`),
          );
        } else if (intent.action === "unlink") {
          await personalAccount.unlink();
        } else {
          await personalRemote.initialize();
        }
      } finally {
        detachRemote();
        detachAccount();
      }
    },
    report: (error) => reportNonFatal("desktop.personal.remote-access.change-failed", error),
  });
  shutdown.add({
    component: "remote-access-intents",
    step: "stop",
    order: 19,
    timeoutMs: 1000,
    stop: async () => {
      remoteAdministrationExecutor.stop();
      desktopUpdateExecutor?.stop();
      desktopSupervisor.stop();
    },
  });
  let personalAccountLinkResumeAttempted = false;
  // Remote access is brought up once each time this Mac's Home becomes ready, not again on
  // every later status change: a helper that can't start says so where the person turns
  // Remote access on, instead of failing over and over in the log.
  let personalWasReady = false;
  const detachPersonalRemoteInitialization = personal.subscribe((status) => {
    const becameReady = status.state === "ready" && !personalWasReady;
    personalWasReady = status.state === "ready";
    if (shutdown.requested || status.state !== "ready") return;
    if (desktopSupervisorReady) void desktopSupervisor.connect();
    if (!becameReady) return;
    void personalRemote
      .initialize()
      .catch((error: unknown) =>
        reportNonFatal("desktop.personal.remote-access.initialize-failed", error),
      );
    // An Account link the last run left activating is finished here rather
    // than waiting for the owner to notice a half-linked computer. Exactly one
    // attempt per launch: a failure is recorded and the link is left alone.
    if (personalAccountLinkResumeAttempted) return;
    personalAccountLinkResumeAttempted = true;
    void personalAccount
      .resumeActivatingLink()
      .catch((error: unknown) =>
        reportNonFatal("desktop.personal.account-link.resume-failed", error),
      )
      .then(async () => personalAccount.adoptComputerName(await computerName()))
      .catch((error: unknown) =>
        reportNonFatal("desktop.personal.adopt-computer-name-failed", error),
      );
  });
  const directRoutes = new DirectHostRouteService({
    catalog: deploymentCatalog,
    fetch: serviceNetwork.fetch.bind(serviceNetwork),
  });
  const privateConnections = new PrivateDeploymentConnectionService({
    catalog: deploymentCatalog,
    fetch: serviceNetwork.fetch.bind(serviceNetwork),
    sessions: hostSessionExchange,
  });
  // The unreachable half of a directory sync has no catalog entry to live in, so
  // the most recent one is held here and handed to the access service on every
  // sync — including the syncs that changed nothing, which is exactly when an
  // unreachable Deployment is the only thing worth saying.
  let lastDirectoryUnavailable: readonly DeploymentAccessUnavailable[] = [];
  const detachAccountDirectoryRefresh = accountDirectoryRefresh.attach(async () => {
    const sync = await accountDirectory.sync();
    lastDirectoryUnavailable = sync.unavailable.map(
      ({ accountAccess, deploymentId, name, reason }) => ({
        accountAccess,
        deploymentId,
        name,
        reason,
      }),
    );
    await nativeAuth.reconcileCatalog();
    return hostTransport.selection();
  });
  const readAccessCatalog = () => accessProjection.read();
  const deploymentProbe = new DesktopDeploymentProbe({
    catalog: deploymentCatalog,
    fetch: serviceNetwork.fetch.bind(serviceNetwork),
    localRuntime: personal,
  });
  const access = new DeploymentAccessService({
    account: {
      available: loaded.config.accountUrl !== null,
      portalOrigin: loaded.config.portalUrl?.origin ?? null,
      beginReauthorization: () => nativeAuth.beginAccountReauthorization(),
      beginSignIn: () => nativeAuth.beginAccountSignIn(),
      currentState: () => nativeAuth.state(),
      signOut: () => nativeAuth.signOutAccount(),
      subscribe: (listener) => nativeAuth.subscribe(listener),
    },
    catalog: {
      read: readAccessCatalog,
      select: async (deploymentId) => {
        await hostTransport.select({ deploymentId });
        return readAccessCatalog();
      },
      subscribe: (listener) => hostTransport.subscribe(listener),
    },
    devices: {
      joinedDeploymentIds: () => localRunner.joinedDeploymentIds(),
      subscribe: (listener) => localRunner.subscribe(listener),
    },
    direct: {
      addRoute: async (input) => {
        await directRoutes.add(input);
        await hostTransport.setRoute({ deploymentId: input.deploymentId, origin: input.origin });
        return readAccessCatalog();
      },
      connect: async (input) => {
        await privateConnections.connect(input);
        await nativeAuth.reconcileCatalog();
        return readAccessCatalog();
      },
    },
    directory: {
      removeFromAccount: (deploymentId) =>
        accountDirectory.removeFromAccount(DeploymentIdSchema.parse(deploymentId)),
      syncAccountDeployments: async (mode, trigger) => {
        if (mode === "required") {
          await accountDirectoryRefresh.refreshNow(
            trigger === "startup" || trigger === "account-change" ? "account-state" : "renderer",
          );
          return { changed: true, unavailable: lastDirectoryUnavailable };
        }
        const outcome = await accountDirectoryRefresh.request(
          trigger === "wake" ? "system-resume" : "app-focus",
        );
        return {
          changed: outcome === "refreshed",
          unavailable: lastDirectoryUnavailable,
        };
      },
    },
    hostSession: {
      abandonAuthorization: (deploymentId) => hostSessions.abandonAuthorization(deploymentId),
      closeCurrent: async () => hostTransport.closeAllConnections(),
      establish: (deploymentId, interactive) => hostSessions.establish(deploymentId, interactive),
      subscribe: (listener) => hostSessions.subscribe(listener),
    },
    personal: {
      start: (input) => personal.start(input),
      // Read through, not copied: a status captured at wiring time would be
      // the supervisor's answer from before this app finished starting.
      get status() {
        return personal.status;
      },
      subscribe: (listener) => personal.subscribe(listener),
    },
    personalAccount: {
      link: () => personalAccount.link(),
      resetJournal: () => personalAccount.resetLinkJournal(),
      status: () => personalAccount.status(),
      subscribe: (listener) => personalAccount.subscribe(listener),
      unlink: () => personalAccount.unlink(),
    },
    places: {
      online: () => net.isOnline(),
      probe: (deploymentId, signal) => deploymentProbe.probe(deploymentId, signal),
    },
  });
  await access.initialize();
  shutdown.signal.throwIfAborted();
  const computerUsePermissionsPanel = new ComputerUsePermissionsPanel({
    openExternal: (url, options) => shell.openExternal(url, options),
    screen,
    webPreferences: panelWebPreferences,
    windowFactory: (options) => new BrowserWindow(options),
  });
  // Every macOS step for the apps the helper serves happens in one panel on
  // this Mac: after an approval, from the computer's page, or when an agent's
  // call finds a grant missing.
  const computerAppSetupPanel = new ComputerAppSetupPanel({
    onClosed: () => void computerAppSetup.dismiss(),
    screen,
    webPreferences: panelWebPreferences,
    windowFactory: (options) => new BrowserWindow(options),
  });
  const computerAppSetup = new ComputerAppSetupGuide({
    appIcon: (bundleId) => computerUse.appIcon(bundleId),
    appName: app.getName(),
    dataGrants: () => computerUse.dataGrants(),
    helperAppPath: computerUseHelperAppPath(),
    log: (event, fields) => reportEvent(event, fields),
    openSettings: (grant) => shell.openExternal(dataGrantSettingsUrls[grant], { activate: true }),
    ownFullDiskAccess: () => probeFullDiskAccess(loaded.config.localExecution.nativeFsHelperBinary),
    panel: computerAppSetupPanel,
    requestDataGrant: (grant) => computerUse.requestDataGrant(grant),
  });
  const detachSetupOffers = computerUse.supported
    ? computerUse.attachDataPermissionOffers((input) => computerAppSetup.offerForAgent(input))
    : () => undefined;
  const fullDiskAccessPanel = new FullDiskAccessPanel({
    appName: app.getName(),
    openExternal: (url, options) => shell.openExternal(url, options),
    screen,
    webPreferences: panelWebPreferences,
    windowFactory: (options) => new BrowserWindow(options),
  });
  const localVisibility = new DesktopLocalVisibility(
    powerMonitor,
    systemPreferences,
    process.platform,
  );
  const loginSession = new DesktopLoginSession(powerMonitor, process.platform);
  const detachLoginSession = integrationAuthorizations.useLoginSession(loginSession);
  let workspaceContents: Electron.WebContents | null = null;
  let noteBadgeCount: (count: number, deploymentId?: string) => void = () => undefined;
  const unregisterBridge = registerDesktopBridge({
    updates: {
      state: () => updater.state(),
      subscribe: (listener) => updater.subscribe(listener),
      download: () => updater.download(),
      setChannel: (channel) => updater.setChannel(channel),
      restart: () => restartToUpdate(),
    },
    webLinks,
    cloudComputers: new AccountCloudComputerClient({
      transport: loaded.config.accountUrl ? accountDirectory : null,
    }),
    personalDataReset: desktopPersonalDataReset({
      personal,
      quiesce: async () => {
        access.dispose();
        detachAccountDirectoryRefresh();
        nativeAuth.dispose();
        for (const sessions of sessionOwners) sessions.dispose();
        hostTransport.dispose();
        await resetWrites.quiesce();
      },
      clearSession: async (deploymentId) => {
        await hostNetwork
          .clearDeploymentSession(deploymentId)
          .catch((error: unknown) =>
            reportNonFatal("desktop.personal.reset-session-failed", error),
          );
      },
      restart: () => {
        app.relaunch();
        shutdown.request("start-fresh");
      },
    }),
    integrationAuthorizations,
    mcpAuthorizationLinks,
    isWorkspaceContents: (sender) => sender === workspaceContents,
    passkeys,
    localVisibility,
    access,
    iphone: { service: iphone, setup: iphoneSetup },
    agentPhone: {
      adb: phoneAdb,
      chooseUsbDevice: (input, frame) => usbDevices.choose(input, frame),
      readArtifact: () =>
        readBundledAgentPhoneArtifact(
          bundledAgentPhoneDirectory({
            developmentRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
            packaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
          }),
        ),
    },
    bridgeToken,
    accountLinkCourier: accountDirectory,
    fullDiskAccess: {
      check: () => probeFullDiskAccess(loaded.config.localExecution.nativeFsHelperBinary),
      closePanel: async () => fullDiskAccessPanel.close(),
      request: async () => {
        await fullDiskAccessPanel.open();
      },
    },
    computerApps: {
      dragIcon: (file) => app.getFileIcon(file, { size: "normal" }),
      setup: {
        begin: (input) => computerAppSetup.begin(input),
        close: (input) => computerAppSetup.dismiss(input),
        dragItem: () => computerAppSetup.dragItem(),
        open: (input) => computerAppSetup.open(input),
        showAgain: () => computerAppSetup.openSettings(),
        status: () => computerAppSetup.status(),
      },
    },
    computerUse: {
      onActivationError: (error) => reportNonFatal("desktop.computer-use.activation-failed", error),
      checkLocalComputerViewTarget: (deploymentId, machineId) =>
        (personal.status.deploymentId === deploymentId
          ? personal
          : localRunner
        ).checkComputerUseRunnerTarget(deploymentId, machineId),
      useComputerViewOnThisMac: (input) => computerUse.useComputerViewOnThisMac(input),
      closePermissionsPanel: async () => computerUsePermissionsPanel.close(),
      openPermissionsPanel: async () => {
        await computerUsePermissionsPanel.open();
      },
      verifyBundledHelper: () => computerUse.verifyBundledHelper(),
      openSystemSettings: (pane) => computerUsePermissionsPanel.openSystemSettings(pane),
      permissions: () => computerUse.permissions(),
      requestPermissions: (pane) => computerUse.requestPermissions(pane),
    },
    browserPresentation,
    deploymentUpdates: deploymentUpdatesFor,
    hostTransport,
    log: reportEvent,
    ipcMain,
    downloads,
    dictation,
    passwords: {
      open: () => passwords.open(),
      status: () => passwords.status(),
      subscribe: (listener) => passwords.onStatusChanged(listener),
    },
    notifications: {
      openSettings: async () => {
        if (process.platform !== "darwin") return;
        await shell.openExternal(
          `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(loaded.config.release.id)}`,
          { activate: true },
        );
      },
      badgeCount: (count, deploymentId) => noteBadgeCount(count, deploymentId),
    },
    tailscale: {
      share: () => personalRemote.shareOverTailscale(),
      status: () => personalRemote.tailscaleStatus(),
    },
    portal: {
      openExternal: async (url) => {
        await shell.openExternal(url, { activate: true });
      },
      openInChrome: (url) => openInChrome(url),
      pickFolder: async () => {
        const chosen = await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
      },
    },
    runner: localRunner,
  });
  void personal
    .resumeIfConfigured()
    .catch((error) => reportNonFatal("desktop.personal.resume-failed", error));
  const mainWindows = new ElectronWindowFactory(loaded.config, {
    log: reportEvent,
    policy: appOriginPolicy,
    onCreated: (window) => {
      workspaceContents = window.webContents;
      appWindow = window;
      for (const event of ["show", "hide", "minimize", "restore"] as const)
        window.on(event as "show", () => {
          background?.windowVisibility(windowVisible());
          if (!windowVisible()) backgroundUpdate?.evaluate();
        });
      let detachMcpAuthorization = () => {};
      window.webContents.on("did-finish-load", () => {
        detachMcpAuthorization();
        detachMcpAuthorization = mcpAuthorizationLinks.attach((target) => {
          if (!window.webContents.isDestroyed())
            window.webContents.send(desktopBridgeChannels.mcpAuthorization, target);
        });
      });
      window.webContents.once("destroyed", () => detachMcpAuthorization());
      // Electron never tells main's Host route its page went away, so neither does the page's
      // cancel; what that page asked for ends with it. The bundled app runs in this one window,
      // and `did-navigate` is a committed main-frame document, never a blocked navigation.
      const abandonHostRequests = () => hostTransport.cancelForwardedRequests();
      window.webContents.on("did-navigate", abandonHostRequests);
      window.webContents.on("render-process-gone", abandonHostRequests);
      window.webContents.once("destroyed", abandonHostRequests);
      browserPresentation.attachWindow(window);
      passkeys.attachWindow(window);
      window.on("focus", () => {
        if (shutdown.requested) return;
        access.networkChanged();
        computerUse.announceGrantsChanged();
      });
    },
    bridgeToken,
    preloadPath,
    quit: () => quitRouting.actions.hide(),
  });
  let updateReady = false;
  const installUpdate = () => {
    if (!updateReady) throw new Error("The desktop update is no longer ready.");
    for (const window of BaseWindow.getAllWindows()) window.destroy();
    autoUpdater.quitAndInstall();
  };
  shutdown.setUpdateRecovery(() => {
    autoUpdater.autoInstallOnAppQuit = false;
    app.relaunch();
  });
  const hiddenRelaunchPath = path.join(loaded.config.dataDirectory, "relaunch-hidden.json");
  // The new version comes back the way this one was left: in the menu bar, or showing.
  // `stillDue` is the background install's last look, right before the handoff.
  const requestInstall = async (
    stillDue?: () => Promise<boolean>,
    holdsCurrent?: () => boolean,
  ) => {
    const hidden = !windowVisible();
    if (hidden)
      await rememberHiddenRelaunch(hiddenRelaunchPath).catch((error: unknown) =>
        reportNonFatal("desktop.update.hidden-relaunch-failed", error),
      );
    if (stillDue && (!(await stillDue()) || !holdsCurrent?.())) {
      if (hidden) await forgetHiddenRelaunch(hiddenRelaunchPath).catch(() => undefined);
      throw new Error("Agent work started before the update could install.");
    }
    await shutdown.requestUpdate(installUpdate);
  };
  desktopUpdateExecutor = new DesktopUpdateExecutor({
    supervisor: desktopSupervisor,
    updater,
    install: () => requestInstall(),
  });
  const restartToUpdate = () => updater.restart(() => requestInstall());
  const restartFromMenu = () => {
    void restartToUpdate().catch(() => reportEvent("desktop.update.restart-refused", {}));
  };
  const checkForUpdates = async () => {
    const state = await updater.check();
    // The window's update button carries an offer from here.
    if (state.status === "available") return mainProcess.activate();
    const name = app.getName();
    const result =
      state.status === "ahead"
        ? {
            message: `${state.channel === "stable" ? "Stable" : "Beta"} selected`,
            detail: `You’re on ${state.currentVersion}; latest is ${state.latestVersion}. Updates resume after it passes your version.`,
          }
        : state.status === "up-to-date"
          ? {
              message: "You're up to date",
              detail: `${name} ${state.currentVersion} is the newest version.`,
            }
          : state.status === "error"
            ? {
                message: "Couldn't check for updates",
                detail: "Check your internet connection, then try again.",
              }
            : state.status === "unavailable"
              ? {
                  message: "Updates unavailable",
                  detail: `Move ${name} to your Applications folder to get updates.`,
                }
              : null;
    if (result)
      await dialog.showMessageBox({
        type: state.status === "error" ? "warning" : "info",
        buttons: ["OK"],
        ...result,
      });
  };
  const hostedHome = async () => {
    const manifest = await personalFiles.load();
    return manifest
      ? {
          deploymentId: manifest.deploymentId,
          name: personal.status.name ?? (await computerName()),
          state: personal.status.state,
          runnerId: manifest.runnerId,
        }
      : null;
  };
  const deviceHomes = async () => {
    const snapshot = access.snapshot();
    return await Promise.all(
      [...(await localRunner.joinedDeploymentIds())].map(async (deploymentId) => {
        const status = await localRunner.status(deploymentId);
        return {
          deploymentId,
          name:
            snapshot.deployments.find((deployment) => deployment.id === deploymentId)?.name ??
            "your Home",
          runner: status.runner.state,
          signedOut: status.membership?.sessionState === "sign-in-again",
          runnerId: status.runner.runnerId,
        };
      }),
    );
  };
  const selectedHome = () => {
    const snapshot = access.snapshot();
    return (
      snapshot.deployments.find((deployment) => deployment.id === snapshot.selectedDeploymentId) ??
      null
    );
  };
  // Main reads each Home under that Home's own owner session, selected or not.
  const ownerHost = (deploymentId: string) =>
    createForwardedHostApi(hostTransport, DeploymentIdSchema.parse(deploymentId), {
      anyHome: true,
    });
  const localActivity = () => ({
    appSessions: computerUse.agentSessions,
    browserTabs: agentBrowserGate.agentTabs,
    runs: localRunner.localActivity().length,
  });
  const menuBarService = new DesktopMenuBarService({
    hostedHome,
    deviceHomes,
    selected: () => {
      const selected = selectedHome();
      return selected
        ? {
            deploymentId: selected.id,
            devicesAvailable: selected.capabilities?.includes("devices-v1") === true,
          }
        : null;
    },
    host: ownerHost,
    local: () => ({
      apps: computerUse.agentSessionDetails(),
      tabs: agentBrowserGate.agentTabDetails(),
      runs: localRunner.localActivity().map((run) => ({ ...run, threadId: run.threadId ?? null })),
    }),
    stop: () => ({
      phase: localStop.phase,
      stoppedAt: localStop.stoppedAt,
      problem: localStop.problem,
      confirming: localStop.confirming,
      confirmOverdue: localStop.confirmOverdue,
    }),
    openAtLogin: async () => openAtLogin.effective(await openAtLoginEligibility()),
    log: reportEvent,
  });
  // A count is the Home's that sent it, never whichever Home is selected when it lands.
  noteBadgeCount = (count, deploymentId) => {
    if (deploymentId) menuBarService.noteNeedsYou(deploymentId, count);
  };
  // Quitting and updating read what is using this Mac fresh, from one place.
  const activity = new DesktopActivity({
    hostedHome,
    deviceHomes,
    host: ownerHost,
    local: localActivity,
  });
  const backgroundNotice = backgroundNoticeFileStore(
    path.join(loaded.config.dataDirectory, "menu-bar-notice.json"),
  );
  const dock = process.platform === "darwin" ? app.dock : undefined;
  background = new DesktopBackgroundMode({
    shutdown,
    window: { hide: () => appWindow?.hide() },
    ...(dock
      ? {
          dock: {
            hide: () => dock.hide(),
            show: () => dock.show(),
            isVisible: () => dock.isVisible(),
          },
        }
      : {}),
    notice: {
      ...backgroundNotice,
      show: () => {
        if (Notification.isSupported())
          new Notification({
            title: backgroundNoticeTitle,
            body: backgroundNoticeBody,
            silent: true,
          }).show();
      },
    },
    work: () => activity.snapshot(),
    confirm: confirmQuit,
    log: reportEvent,
  });
  quitRouting.attach(background);
  Menu.setApplicationMenu(
    createDesktopApplicationMenu({
      quit: quitRouting.actions,
      displayName: resolveDesktopAppBranding(app.getVersion()).displayName,
      workspaceContents: (window) => (mainWindows.owns(window) ? window.webContents : null),
      browserKey: (key) => browserPresentation.menuKey(key),
      ...(loaded.config.updates
        ? {
            updates: {
              check: () =>
                void checkForUpdates().catch((error: unknown) =>
                  reportNonFatal("desktop.update.menu-check-failed", error),
                ),
              download: () =>
                void updater
                  .download()
                  .catch(() => reportEvent("desktop.update.download-refused", {})),
              restart: restartFromMenu,
            },
          }
        : {}),
    }),
  );
  const updateReopenMenu = (snapshot: ReturnType<typeof access.snapshot>) => {
    const available =
      snapshot.deployments
        .find((deployment) => deployment.id === snapshot.selectedDeploymentId)
        ?.capabilities?.includes("tab-reopen-v1") === true;
    const item = Menu.getApplicationMenu()?.getMenuItemById("reopen-closed-tab");
    if (item) {
      item.visible = available;
      item.enabled = available;
    }
  };
  updateReopenMenu(access.snapshot());
  const detachReopenMenu = access.subscribe(updateReopenMenu);
  mainProcess = new DesktopMainProcess({
    onServiceError: (error) => reportNonFatal("desktop.local-services.failed", error),
    services: {
      start: async () => {
        void localRunner
          .startIfEnabled()
          .catch((error: unknown) => reportNonFatal("desktop.local-runner.start-failed", error));
      },
      stop: async () => undefined,
    },
    windows: {
      create: (onClosed, options) => mainWindows.create(onClosed, options),
    },
  });
  activeMainProcess = mainProcess;
  openIntegrationReturn = async (deploymentId) => {
    if (shutdown.requested) return;
    if (access.snapshot().selectedDeploymentId !== deploymentId) await access.select(deploymentId);
    await mainProcess.activate();
  };

  updater.subscribe((state) => {
    showDesktopUpdateMenuItem(Menu.getApplicationMenu(), state);
    updateReady = state.status === "downloaded";
  });
  updater.start(shutdown.signal);
  shutdown.signal.throwIfAborted();
  backgroundUpdate = new DesktopBackgroundUpdate({
    updater,
    install: (stillDue) =>
      localStop.whileModeStable(async () => {
        const held: { current(): boolean; release(): Promise<void> }[] = [];
        try {
          await requestInstall(
            async () => {
              const results = await Promise.allSettled([
                personal.holdIdleForUpdate(),
                localRunner.holdIdleForUpdate(),
              ]);
              for (const result of results)
                if (result.status === "fulfilled" && result.value) held.push(result.value);
              return held.length === results.length && (await stillDue());
            },
            () => held.every((hold) => hold.current()),
          );
        } catch (error) {
          await Promise.allSettled(held.map((hold) => hold.release()));
          throw error;
        }
      }),
    windowVisible,
    idle: async () => activityIdle(await activity.snapshot()),
    stopping: () => shutdown.requested,
    log: reportEvent,
  });
  backgroundUpdate.start(shutdown.signal);
  const openAppAt = async (route: Parameters<typeof appRouteScript>[0], deploymentId?: string) => {
    if (deploymentId && access.snapshot().selectedDeploymentId !== deploymentId)
      await access.select(deploymentId);
    app.focus({ steal: true });
    await mainProcess.activate();
    const contents = workspaceContents;
    if (contents && !contents.isDestroyed())
      await contents.executeJavaScript(appRouteScript(route)).catch(() => undefined);
  };
  const menuBarChanged = () => menuBarService.changed();
  const detachMenuBarSources = [
    agentBrowserGate.subscribe(() => {
      menuBarChanged();
      backgroundUpdate?.evaluate();
    }),
    localStop.subscribe(menuBarChanged),
    computerUse.onAgentSessionsChanged(menuBarChanged),
    localRunner.subscribe(menuBarChanged),
    personal.subscribe(menuBarChanged),
    access.subscribe(menuBarChanged),
  ];
  const menuBar = new DesktopMenuBar({
    service: menuBarService,
    actions: {
      stop: () => localStop.stop(),
      resume: () => localStop.resume(),
      setOpenAtLogin: chooseOpenAtLogin,
      openApp: async () => {
        app.focus({ steal: true });
        await mainProcess.activate();
      },
      openRow: ({ deploymentId, threadId }) => openAppAt(taskPath(threadId), deploymentId),
      openNeedsYou: (deploymentId) => openAppAt(appRoutes.needsYou, deploymentId),
      openSettings: () => openAppAt(appRoutes.settings),
      quitCompletely: async () => {
        await background?.quitCompletely();
      },
    },
    ipcMain,
    screen,
    createTray: (image) => new Tray(image),
    createImage: (bitmap, scaleFactor) =>
      nativeImage.createFromBitmap(bitmap, {
        width: 32,
        height: 32,
        scaleFactor,
      }),
    createWindow: (options) => new BrowserWindow(options),
    webPreferences: {
      ...desktopWebPreferences(
        loaded.config,
        bridgeToken,
        path.join(import.meta.dirname, "menu-bar-preload.cjs"),
      ),
      additionalArguments: [],
    },
    log: reportEvent,
  });
  menuBar.start();
  const detachOAuthDeepLinks = oauthDeepLinks.attach(async (url) => {
    const handled = await nativeAuth.handleCallback(url);
    if (handled && !shutdown.requested) {
      mainProcess.focus();
    }
    return handled;
  });

  // Returning to the app, or waking the machine, is when a Deployment created
  // on the portal should already be there. Both are throttled by the service.
  // Returning is also when a grant switched on in System Settings should show.
  const refreshOnSystemResume = () => {
    if (shutdown.requested) return;
    localRunner.notifyAwake();
    access.wake();
    const iphoneResumeRevision = ++iphonePowerRevision;
    void iphoneSuspension
      .then(async () => {
        if (!shutdown.requested && iphoneResumeRevision === iphonePowerRevision)
          await iphone.resume();
      })
      .catch(() => reportEvent("desktop.iphone.resume-failed"));
    void localRunner
      .reconcile()
      .catch((error: unknown) => reportNonFatal("desktop.local-runner.resume-failed", error));
  };
  const notifyRunnersSleeping = () => {
    if (shutdown.requested) return;
    localRunner.notifySleeping();
  };
  powerMonitor.on("suspend", notifyRunnersSleeping);
  powerMonitor.on("resume", refreshOnSystemResume);

  app.on("activate", () => {
    if (!shutdown.requested) void mainProcess.activate().catch(handleAsyncFatal);
  });
  shutdown.add({
    component: "desktop",
    step: "stop-window",
    order: 70,
    timeoutMs: 1_000,
    stop: () => mainProcess.stop(),
  });
  shutdown.add({
    component: "desktop",
    step: "stop-browser-presentation",
    order: 75,
    timeoutMs: 1_000,
    stop: () => {
      passkeys.dispose();
      browserPresentation.dispose();
    },
  });
  shutdown.add({
    component: "desktop",
    step: "close-network",
    order: 80,
    timeoutMs: 1_000,
    stop: () => serviceNetwork.close(),
  });
  shutdown.add({
    component: "desktop",
    step: "stop-admission",
    order: 0,
    timeoutMs: 1_000,
    stop: () => {
      browserPresentation.endAll();
      powerMonitor.off("suspend", notifyRunnersSleeping);
      powerMonitor.off("resume", refreshOnSystemResume);
      detachPersonalRemoteInitialization();
      detachAccountDirectoryRefresh();
      detachOpenAtLogin();
      detachReopenMenu();
      detachSetupOffers();
      computerAppSetup.close();
      fullDiskAccessPanel.close();
      computerUsePermissionsPanel.close();
      unsubscribeOwnOrigins();
      access.dispose();
      for (const sessions of sessionOwners) sessions.dispose();
      closeClearedAccountSockets();
      hostTransport.dispose();
      unregisterBridge();
      localVisibility.dispose();
      detachLoginSession();
      loginSession.dispose();
      phoneAdb.dispose();
      detachPhoneAdb();
      detachUsbDevices();
      if (activeMainProcess === mainProcess) activeMainProcess = null;
      for (const detach of detachMenuBarSources) detach();
      detachOpenAtLoginHome();
      menuBar.dispose();
      detachOAuthDeepLinks();
      nativeAuth.dispose();
      uninstallPublishedAppProtocol();
      uninstallAppProtocol();
      localRunner.dispose();
    },
  });

  desktopSupervisorReady = true;
  if (!shutdown.requested) void desktopSupervisor.connect();
  const relaunchedHidden = await takeHiddenRelaunch(hiddenRelaunchPath);
  const openWindow =
    !relaunchedHidden &&
    !quitRouting.quitBeforeStart &&
    shouldOpenDesktopWindowAtLaunch({
      arguments: process.argv,
      wasOpenedAtLogin:
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin,
    });
  // Opened at login or back from a background update: straight to the menu bar.
  if (!openWindow) background.windowVisibility(false);
  const starting = mainProcess.start({ openWindow });
  if (webLinks.pending || mcpAuthorizationLinks.pending) mainProcess.focus();
  await starting;

  function handleAsyncFatal(error: unknown): void {
    if (shutdown.requested || fatal) return;
    fatal = true;
    reportFatal(error);
    shutdown.request("fatal");
  }
}

function defaultMode(): DesktopMode {
  return app.isPackaged ? "production" : "development";
}

function reportFatal(error: unknown): void {
  const message = safeErrorMessage(error);
  writeDiagnostic("stderr", { event: "desktop.failed", message });
}

/** Diagnostic main-process record. It never reaches the window or the user. */
function reportEvent(
  event: string,
  fields: Readonly<Record<string, string | number | boolean>> = {},
): void {
  writeDiagnostic("stdout", { event, ...fields });
}

function reportNonFatal(event: string, error: unknown): void {
  writeDiagnostic("stderr", { event, message: safeErrorMessage(error) });
}

function writeDiagnostic(
  stream: "stdout" | "stderr",
  record: Readonly<Record<string, string | number | boolean>>,
): void {
  const line = JSON.stringify(record);
  process[stream].write(`${line}\n`);
  desktopLog?.append(stream, line);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The desktop app failed.";
  return message
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]")
    .slice(0, 2_000);
}

function acceptLaunch(): boolean {
  try {
    assertDesktopLaunch({
      argv: process.argv,
      callbackScheme: new URL(embeddedRelease.oauth.accountCallback).protocol.slice(0, -1),
      environment: process.env,
      packaged: app.isPackaged,
    });
    return true;
  } catch (error) {
    reportFatal(error);
    // A refused launch must not leave a modal process intercepting later quits.
    app.exit(1);
    return false;
  }
}
