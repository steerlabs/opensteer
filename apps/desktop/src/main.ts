import { autoUpdater } from "electron-updater";
import { startDesktopUpdater } from "./app/desktop-updater.js";
import { offerMoveToApplications } from "./app/move-to-applications.js";
import { DesktopWebLinks, routeDesktopUrl } from "./app/web-links.js";
import { DesktopPasskeyRequests } from "./passkeys/passkey-requests.js";
import { createMacosNativePasskeys } from "./passkeys/macos-native-passkeys.js";
import { DesktopDownloads } from "./downloads/desktop-downloads.js";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { DesktopBrowserPresentationManager } from "./browser/browser-presentation.js";
import { randomBytes } from "node:crypto";
import { ComputerAppApprovalService } from "./computer-app-approval-service.js";
import { ComputerAppSetupGuide, dataGrantSettingsUrls } from "./computer-app-setup-guide.js";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { homedir, release } from "node:os";
import { DictationService } from "./dictation/dictation-service.js";
import { NativeDictationHelperClient } from "./dictation/helper-client.js";
import { bundledDictationBrokerPath } from "./dictation/paths.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  systemPreferences,
} from "electron";
import {
  acquireDesktopApplicationLock,
  configureDesktopApplicationPaths,
  desktopDeploymentCatalogPath,
  prepareDesktopApplicationDirectories,
} from "./app/application-paths.js";
import type { DeploymentAccessUnavailable } from "@opensteer/protocol/desktop";
import { passwordsBrokerLatestProtocolVersion } from "@opensteer/protocol/passwords-broker";
import { DeploymentIdSchema } from "@opensteer/core";
import { AccountDeploymentDirectoryService } from "@opensteer/client/connections";
import { AccountDirectoryRefreshService } from "@opensteer/client/connections";
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
import { DesktopShutdown } from "./app/desktop-shutdown.js";
import { DesktopMainProcess } from "./app/desktop-main-process.js";
import { registerDesktopBridge } from "./bridge/registration.js";
import { DeploymentAccessService } from "./connections/deployment-access-service.js";
import { DesktopAccessProjection } from "./connections/access-projection.js";
import { DesktopDeploymentProbe } from "./connections/deployment-probe.js";
import { DeploymentCatalogStore } from "@opensteer/client/connections";
import { ElectronHostNetwork } from "./app/electron-host-network.js";
import { ElectronServiceNetwork } from "./app/electron-service-network.js";
import {
  configureDesktopSession,
  desktopWebPreferences,
  desktopWindowForContents,
  ElectronWindowFactory,
} from "./app/electron-window.js";
import { createDesktopApplicationMenu } from "./app/application-menu.js";
import { DesktopTrayService } from "./app/desktop-tray.js";
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
import { OpenAtLoginService, shouldOpenDesktopWindowAtLaunch } from "./supervisor/open-at-login.js";
import { DesktopAppOriginPolicy } from "./app/navigation-policy.js";
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
import {
  FixedPersonalUserEnvironment,
  NativePersonalUserEnvironment,
} from "./supervisor/personal-user-environment.js";
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
import { DesktopPersonalRemoteAccessService } from "./connections/personal-remote-access.js";
import { DesktopConnectCredentialStore } from "./secrets/connect-credential-store.js";
import { VerifiedDesktopSecretCryptography } from "./secrets/verified-secret-cryptography.js";
import { AccountConnectClient } from "@opensteer/client/connections";
import { CloudflaredConnectorSupervisor } from "./supervisor/cloudflared-connector-supervisor.js";
import {
  PersonalHostConnectOrchestrator,
  PersonalHostConnectTeardownCoordinator,
} from "./supervisor/personal-host-connect-orchestrator.js";
import { openDesktopPrivateFilesystemSync } from "./secrets/desktop-private-files.js";
import type { DesktopPrivateFilesystem } from "./secrets/desktop-private-files.js";
import type { PersonalLocalRuntimePort } from "./supervisor/personal-local-runtime.js";
import { probeFullDiskAccess } from "./full-disk-access/full-disk-access-probe.js";
import { FullDiskAccessPanel } from "./full-disk-access/full-disk-access-panel.js";
import { ComputerUseService } from "./computer-use/computer-use-service.js";
import { ComputerUseApprovalPanel } from "./computer-use/computer-use-approval-panel.js";
import { ComputerUseApprovalKey } from "./computer-use/approval-key.js";
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
import { PasswordsSignInOperations } from "./passwords/sign-in-operations.js";
import { PasswordsLoginAuthority } from "./passwords/login-authority.js";

registerDesktopAppScheme(protocol);
keepDesktopAliveWithoutWindows(app);
const embeddedRelease = readEmbeddedDesktopRelease(
  fileURLToPath(new URL("./desktop-release.json", import.meta.url)),
);
const oauthDeepLinks = new OAuthDeepLinkBroker({
  ...embeddedRelease.oauth,
  application: "desktop",
});
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
let activeMainProcess: DesktopMainProcess | null = null;
let desktopLog: RotatingPersonalLog | null = null;
const shutdown = new DesktopShutdown({ application: app, power: powerMonitor, log: reportEvent });
app.on("open-url", (event, url) => {
  if (oauthDeepLinks.accept(url)) {
    event.preventDefault();
    return;
  }
  if (!webLinks.accept(url)) return;
  if (!shutdown.requested) void activeMainProcess?.activate().catch(reportFatal);
  event.preventDefault();
});
app.on("second-instance", (_event, argv) => {
  for (const url of argv) routeDesktopUrl(url, oauthDeepLinks, webLinks);
  if (!shutdown.requested) void activeMainProcess?.activate().catch(reportFatal);
});

const releaseSmoke = process.env.OPENSTEER_DESKTOP_RELEASE_SMOKE === "1";

if (acceptLaunch()) {
  app.setName(desktopApplicationName(app.isPackaged, embeddedRelease.application.name));
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
  shutdown.signal.throwIfAborted();
  if (app.isPackaged && embeddedRelease.application.stage === "alpha") {
    app.setAboutPanelOptions({
      applicationName: embeddedRelease.application.name,
      applicationVersion: `${app.getVersion()} (Alpha)`,
      version: "",
    });
  }
  // Only a build that updates itself needs to live in Applications.
  if (!releaseSmoke && loaded.config.updates && (await offerMoveToApplications(reportEvent)))
    return;
  shutdown.signal.throwIfAborted();
  for (const url of process.argv) routeDesktopUrl(url, oauthDeepLinks, webLinks);
  await runDesktop(loaded, privateFiles);
}

async function runDesktop(
  loaded: LoadedDesktopConfiguration,
  privateFiles: DesktopPrivateFilesystem,
): Promise<void> {
  await app.whenReady();
  shutdown.signal.throwIfAborted();
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
  );
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
  configureDesktopSession(
    session.defaultSession,
    new DesktopAppOriginPolicy(),
    usbDevices,
    downloads,
  );
  const detachUsbDevices = usbDevices.attach(session.defaultSession);

  let fatal = false;
  let mainProcess: DesktopMainProcess;
  const browserPagePolicyPreloadPath = path.join(import.meta.dirname, "browser-page-preload.cjs");
  const personalFiles = new NativePersonalDeploymentFilesystem({
    dataDirectory: loaded.config.dataDirectory,
    privateFiles,
  });
  const deploymentCatalog = new DeploymentCatalogStore({
    filePath: desktopDeploymentCatalogPath(loaded.config.dataDirectory),
    localPersonalManifest: personalFiles,
    privateFiles,
  });
  if (loaded.config.hostUrl) {
    await ensureConfiguredDeployment({
      catalog: deploymentCatalog,
      hostUrl: loaded.config.hostUrl,
      personalDeploymentName: defaultPersonalDeploymentName(),
    });
  }
  const hostNetwork = new ElectronHostNetwork();
  const serviceNetwork = new ElectronServiceNetwork();
  const protectedStorage = new VerifiedDesktopSecretCryptography(safeStorage, {
    onVerificationFailure: ({ error, phase }) =>
      reportNonFatal(
        "desktop.protected-storage.verification-failed",
        new Error(`${phase}: ${safeErrorMessage(error)}`),
      ),
  });
  const resourcesDirectory = path.dirname(loaded.config.personal.releaseDirectory);
  const personalUserEnvironment = releaseSmoke
    ? new FixedPersonalUserEnvironment(process.env)
    : new NativePersonalUserEnvironment();
  const hostControl = new NativePersonalHostControl({
    fetch: (deploymentId, input, init) => hostNetwork.partitionFetch(deploymentId, input, init),
  });
  // Computer use owns the helper for every supervised slot on this Mac, so it
  // is built before anything that supervises one.
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
    protocolVersion: passwordsBrokerLatestProtocolVersion,
    log: (event, fields) => reportEvent(event, fields),
  });
  const passwordsSignIns = new PasswordsSignInOperations();
  const ownOrigins = new OpensteerOwnOrigins({
    accountUrl: loaded.config.accountUrl,
    catalog: deploymentCatalog,
  });
  const passwordsLoginAuthority =
    process.platform === "darwin"
      ? new PasswordsLoginAuthority({
          broker: passwords.broker(),
          legacyBroker: passwords.broker(4),
          operations: passwordsSignIns,
          ownOrigins: ownOrigins.current,
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
  const personalLocalRuntimes: PersonalLocalRuntimePort = {
    startBrowser: (input) =>
      startLocalBrowserRuntime({
        downloads,
        logPath: path.join(loaded.config.dataDirectory, "logs", "personal-browser.log"),
        pagePolicyPreloadPath: browserPagePolicyPreloadPath,
        registerPresentationSource: (source) => browserPresentation.registerSource(source),
        profileRoot: input.paths.browserProfileRoot,
        runtimeId: input.runtimeId,
        ...(passwordsLoginAuthority ? { loginAuthority: passwordsLoginAuthority } : {}),
      }),
  };
  const processSupervisorExecutable = readPersonalProcessSupervisorRelease(resourcesDirectory);
  const personal = new PersonalDeploymentSupervisor({
    accountIssuer: loaded.config.accountUrl,
    catalog: deploymentCatalog,
    computerUse: {
      startForSlot: (id) => computerUse.startForSlot(id, passwordsLoginAuthority),
      stopForSlot: (id) => computerUse.stopForSlot(id),
    },
    credentials: new NativePersonalDeploymentCredentials(protectedStorage, { privateFiles }),
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
    workspaceRoot: loaded.config.personal.workspaceRoot,
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
    privateFiles,
  });
  const personalRemoteHost = new NativePersonalRemoteHostControl({
    fetch: (deploymentId, input, init) => {
      shutdown.signal.throwIfAborted();
      return hostNetwork.partitionFetch(deploymentId, input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([shutdown.signal, init.signal]) : shutdown.signal,
      });
    },
  });
  const accountBrokeredHostSessions = new AccountBrokeredHostSessions({
    catalog: deploymentCatalog,
    clearDeploymentSession: (deploymentId) => hostNetwork.clearDeploymentSession(deploymentId),
  });
  const nativeAuth = new NativeOAuthManager({
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
  const hostSessions = new HostSession({
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
  const hostTransport = new DesktopHostTransport({
    catalog: deploymentCatalog,
    log: reportEvent,
    credentials: nativeAuth,
    localRuntime: personal,
    network: hostNetwork,
    projection: accessProjection,
    sessions: hostSessions,
  });
  const nativePasskeys = createMacosNativePasskeys();
  const browserPresentation = new DesktopBrowserPresentationManager({
    transport: hostTransport,
    glassPreload: path.join(import.meta.dirname, "glass-preload.cjs"),
    onError: (error) => reportNonFatal("desktop.browser.presentation-failed", error),
    quit: () => app.quit(),
  });
  const passkeys = new DesktopPasskeyRequests({
    presentations: browserPresentation,
    native: nativePasskeys,
    ownOrigins: ownOrigins.current,
    refreshOwnOrigins: () => ownOrigins.refresh(),
    transport: hostTransport,
    windowForContents: desktopWindowForContents,
  });
  const closeClearedAccountSockets = accountBrokeredHostSessions.subscribe(() =>
    hostTransport.closeAllSockets(),
  );
  const localRunner = new LocalRunnerService(loaded.config, {
    log: reportEvent,
    browser: (input) =>
      startLocalBrowserRuntime({
        downloads,
        logPath: input.logPath,
        pagePolicyPreloadPath: browserPagePolicyPreloadPath,
        registerPresentationSource: (source) => browserPresentation.registerSource(source),
        profileRoot: input.profileRoot,
        runtimeId: input.runtimeId,
      }),
    computerUse,
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
  shutdown.add({
    component: "local-runners",
    step: "stop",
    order: 30,
    timeoutMs: 8_000,
    stop: (signal) => localRunner.shutdown(signal),
  });
  const openAtLogin = new OpenAtLoginService({
    applicationName: app.getName(),
    environment: process.env,
    executablePath: process.execPath,
    homeDirectory: homedir(),
    packaged: app.isPackaged,
    platform: process.platform,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  });
  let openAtLoginTail = Promise.resolve();
  const syncOpenAtLogin = () => {
    if (shutdown.requested) return;
    openAtLoginTail = openAtLoginTail
      .then(async () => {
        const enrolled = await localRunner.hasEnrolledRunners();
        if (!shutdown.requested) await openAtLogin.sync(enrolled);
      })
      .catch((error: unknown) => reportNonFatal("desktop.open-at-login.failed", error));
  };
  const detachOpenAtLogin = localRunner.subscribe(syncOpenAtLogin);
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
    auth: nativeAuth,
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
              controlPlane: accountConnect,
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
    link: personalAccountLink,
    mutations: personalAccountMutations,
    runtime: personal,
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
  let personalAccountLinkResumeAttempted = false;
  const detachPersonalRemoteInitialization = personal.subscribe((status) => {
    if (shutdown.requested || status.state !== "ready") return;
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
      closeCurrent: async () => hostTransport.closeAllSockets(),
      establish: (deploymentId) => hostSessions.establish(deploymentId),
      subscribe: (listener) => hostSessions.subscribe(listener),
    },
    personal: {
      start: () => personal.start(),
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
  const resumePersonalRemote = nativeAuth.subscribe((state) => {
    if (!shutdown.requested && state.account.status === "signed-in") {
      void personalRemote.resumeDesiredConnect().catch(() => undefined);
    }
  });
  const computerUseApprovalPanel = new ComputerUseApprovalPanel({
    screen,
    webPreferences: panelWebPreferences,
    windowFactory: (options) => new BrowserWindow(options),
  });
  const computerUsePermissionsPanel = new ComputerUsePermissionsPanel({
    openExternal: (url, options) => shell.openExternal(url, options),
    screen,
    webPreferences: panelWebPreferences,
    windowFactory: (options) => new BrowserWindow(options),
  });
  // The person's approvals are signed with this desktop's own key, kept in
  // the keychain, never with a Runner's.
  const computerUseApprovalKey = new ComputerUseApprovalKey({
    cryptography: protectedStorage,
    dataDirectory: loaded.config.dataDirectory,
    privateFiles,
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
  const computerAppApprovals = new ComputerAppApprovalService({
    appIcon: (bundleId) => computerUse.appIcon(bundleId),
    approvalKey: computerUseApprovalKey,
    catalog: deploymentCatalog,
    confirm: (presentation, signal) => computerUseApprovalPanel.ask(presentation, signal),
    definitions: integrationDefinitions,
    ...(computerUse.supported
      ? {
          setUp: (input) =>
            void computerAppSetup
              .open(input)
              .catch((error: unknown) =>
                reportNonFatal("desktop.computer-app.setup-open-failed", error),
              ),
        }
      : {}),
    local: localRunner,
    log: (event, fields) => reportEvent(event, fields),
    machineName: computerName,
    personal,
    resolveApp: (app) => computerUse.resolveApp(app),
    sendAnswer: (deploymentId, frame, server) =>
      computerUse.sendApprovalAnswer(deploymentId, frame, server),
  });
  // Desktop main holds no Host connection and uses nobody's Host session for
  // approvals: each Host reaches this Mac through the Runner slot it
  // supervises, and the person's answer goes back the same way.
  const detachApprovals = computerUse.attachApprovals({
    disconnected: (deploymentId) => computerAppApprovals.disconnected(deploymentId),
    list: (deploymentId, list) => computerAppApprovals.list(deploymentId, list),
    outcome: (deploymentId, frame) => computerAppApprovals.outcome(deploymentId, frame),
    proveKeyChallenge: (deploymentId, challenge) =>
      computerAppApprovals.proveKeyChallenge(deploymentId, challenge),
  });
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
  let workspaceContents: Electron.WebContents | null = null;
  const unregisterBridge = registerDesktopBridge({
    webLinks,
    isWorkspaceContents: (sender) => sender === workspaceContents,
    passkeys,
    localVisibility,
    access,
    agentPhone: {
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
    cloud: accountConnect,
    fullDiskAccess: {
      check: () => probeFullDiskAccess(loaded.config.localExecution.nativeFsHelperBinary),
      closePanel: async () => fullDiskAccessPanel.close(),
      request: async () => {
        await fullDiskAccessPanel.open();
      },
    },
    computerApps: {
      approvalKey: () => computerUseApprovalKey.publicKey(),
      dragIcon: (file) => app.getFileIcon(file, { size: "normal" }),
      review: (deploymentId, setupRequestId) =>
        computerAppApprovals.review(deploymentId, setupRequestId),
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
        computerAppApprovals.checkComputerUseRunnerTarget(deploymentId, machineId),
      useComputerViewOnThisMac: (input) => computerUse.useComputerViewOnThisMac(input),
      approvalGet: (token, sender) => computerUseApprovalPanel.presentation(token, sender),
      approvalRespond: (token, allow, sender) =>
        computerUseApprovalPanel.respond(token, allow, sender),
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
    hostTransport,
    log: reportEvent,
    ipcMain,
    downloads,
    dictation,
    passwords: {
      open: () => passwords.open(),
      signIns: passwordsSignIns,
      status: () => passwords.status(),
      subscribe: (listener) => passwords.onStatusChanged(listener),
    },
    personalRemote,
    portal: {
      openExternal: async (url) => {
        await shell.openExternal(url, { activate: true });
      },
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
    onCreated: (window) => {
      workspaceContents = window.webContents;
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
    quit: () => app.quit(),
  });
  let updateReady = false;
  const installUpdate = () => {
    if (!updateReady) throw new Error("The desktop update is no longer ready.");
    for (const window of BaseWindow.getAllWindows()) window.destroy();
    autoUpdater.quitAndInstall();
  };
  const restartToUpdate = () => {
    if (updateReady) shutdown.requestUpdate(installUpdate);
  };
  Menu.setApplicationMenu(
    createDesktopApplicationMenu({
      workspaceContents: (window) => (mainWindows.owns(window) ? window.webContents : null),
      browserKey: (key) => browserPresentation.menuKey(key),
      ...(loaded.config.updates ? { restartToUpdate } : {}),
    }),
  );
  const updateReopenMenu = (snapshot: ReturnType<typeof access.snapshot>) => {
    const available =
      snapshot.deployments
        .find((deployment) => deployment.id === snapshot.selectedDeploymentId)
        ?.capabilities?.includes("workspace-tab-reopen-v1") === true;
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
  const tray = new DesktopTrayService({
    catalog: deploymentCatalog,
    iconPath: path.join(import.meta.dirname, "trayTemplate.png"),
    onError: (error) => reportNonFatal("desktop.tray.failed", error),
    open: () => void mainProcess.activate().catch(handleAsyncFatal),
    quit: () => app.quit(),
    runner: localRunner,
  });
  await tray.start();
  startDesktopUpdater({
    updates: loaded.config.updates,
    signal: shutdown.signal,
    log: reportEvent,
    readinessChanged: (ready) => {
      updateReady = ready;
      shutdown.setUpdateInstaller(ready ? installUpdate : undefined);
      const item = Menu.getApplicationMenu()?.getMenuItemById("restart-to-update");
      if (item) item.visible = ready;
      tray.setRestartToUpdate(ready ? restartToUpdate : undefined);
    },
  });
  shutdown.signal.throwIfAborted();
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
    access.wake();
    void localRunner
      .reconcile()
      .catch((error: unknown) => reportNonFatal("desktop.local-runner.resume-failed", error));
  };
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
      powerMonitor.off("resume", refreshOnSystemResume);
      detachPersonalRemoteInitialization();
      resumePersonalRemote();
      detachAccountDirectoryRefresh();
      detachOpenAtLogin();
      detachReopenMenu();
      detachApprovals();
      detachSetupOffers();
      computerAppApprovals.close();
      computerAppSetup.close();
      fullDiskAccessPanel.close();
      computerUsePermissionsPanel.close();
      computerUseApprovalPanel.close();
      unsubscribeOwnOrigins();
      access.dispose();
      hostSessions.dispose();
      closeClearedAccountSockets();
      hostTransport.closeAllSockets();
      tray.dispose();
      unregisterBridge();
      localVisibility.dispose();
      detachUsbDevices();
      if (activeMainProcess === mainProcess) activeMainProcess = null;
      detachOAuthDeepLinks();
      nativeAuth.dispose();
      uninstallAppProtocol();
      localRunner.dispose();
    },
  });

  await mainProcess.start({
    openWindow: shouldOpenDesktopWindowAtLaunch({
      arguments: process.argv,
      wasOpenedAtLogin:
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin,
    }),
  });
  if (webLinks.pending) mainProcess.focus();

  function handleAsyncFatal(error: unknown): void {
    if (shutdown.requested || fatal) return;
    fatal = true;
    reportFatal(error);
    app.quit();
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
