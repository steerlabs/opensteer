import { contextBridge, ipcRenderer } from "electron";

const CHROME_WEB_STORE_ORIGIN = "https://chromewebstore.google.com";

const ExtensionInstallStatus = {
  BLACKLISTED: "blacklisted",
  BLOCKED_BY_POLICY: "blocked_by_policy",
  CAN_REQUEST: "can_request",
  CORRUPTED: "corrupted",
  CUSTODIAN_APPROVAL_REQUIRED: "custodian_approval_required",
  CUSTODIAN_APPROVAL_REQUIRED_FOR_INSTALLATION: "custodian_approval_required_for_installation",
  DEPRECATED_MANIFEST_VERSION: "deprecated_manifest_version",
  DISABLED: "disabled",
  ENABLED: "enabled",
  FORCE_INSTALLED: "force_installed",
  INSTALLABLE: "installable",
  REQUEST_PENDING: "request_pending",
  TERMINATED: "terminated",
} as const;

const MV2DeprecationStatus = {
  INACTIVE: "inactive",
  SOFT_DISABLE: "soft_disable",
  WARNING: "warning",
} as const;

const Result = {
  ALREADY_INSTALLED: "already_installed",
  BLACKLISTED: "blacklisted",
  BLOCKED_BY_POLICY: "blocked_by_policy",
  BLOCKED_FOR_CHILD_ACCOUNT: "blocked_for_child_account",
  FEATURE_DISABLED: "feature_disabled",
  ICON_ERROR: "icon_error",
  INSTALL_ERROR: "install_error",
  INSTALL_IN_PROGRESS: "install_in_progress",
  INVALID_ICON_URL: "invalid_icon_url",
  INVALID_ID: "invalid_id",
  LAUNCH_IN_PROGRESS: "launch_in_progress",
  MANIFEST_ERROR: "manifest_error",
  MISSING_DEPENDENCIES: "missing_dependencies",
  SUCCESS: "success",
  UNKNOWN_ERROR: "unknown_error",
  UNSUPPORTED_EXTENSION_TYPE: "unsupported_extension_type",
  USER_CANCELLED: "user_cancelled",
  USER_GESTURE_REQUIRED: "user_gesture_required",
} as const;

const WebGlStatus = {
  WEBGL_ALLOWED: "webgl_allowed",
  WEBGL_BLOCKED: "webgl_blocked",
} as const;

function installWebStoreBridge(): void {
  const webstorePrivateBridge = {
    ExtensionInstallStatus,
    MV2DeprecationStatus,
    Result,
    WebGlStatus,
    beginInstallRaw: async (
      details: unknown,
    ): Promise<{ readonly result: string; readonly message?: string }> => {
      const reply = (await ipcRenderer.invoke("opensteer-cws:beginInstall", details)) as
        { readonly result: string; readonly message?: string } | undefined;
      return reply ?? { result: Result.UNKNOWN_ERROR };
    },
    completeInstall: async (id: string, callback?: (result: string) => void): Promise<string> => {
      const result =
        ((await ipcRenderer.invoke("opensteer-cws:completeInstall", id)) as string | undefined) ??
        Result.UNKNOWN_ERROR;
      callback?.(result);
      return result;
    },
    enableAppLauncher: async (_enable: boolean, callback?: (ok: boolean) => void) => {
      callback?.(true);
      return true;
    },
    getBrowserLogin: async (callback?: (login: string) => void) => {
      callback?.("");
      return "";
    },
    getExtensionStatus: async (
      id: string,
      manifestJson: string,
      callback?: (status: string) => void,
    ) => {
      const status =
        ((await ipcRenderer.invoke("opensteer-cws:getExtensionStatus", id, manifestJson)) as
          string | undefined) ?? ExtensionInstallStatus.INSTALLABLE;
      callback?.(status);
      return status;
    },
    getFullChromeVersion: async (callback?: (info: { version_number: string }) => void) => {
      const reply = (await ipcRenderer.invoke("opensteer-cws:getFullChromeVersion")) as
        { version_number: string; app_name?: string } | undefined;
      const info = { version_number: reply?.version_number ?? "152.0.0.0" };
      callback?.(info);
      return info;
    },
    getIsLauncherEnabled: async (callback?: (enabled: boolean) => void) => {
      callback?.(true);
      return true;
    },
    getMV2DeprecationStatus: async (callback?: (status: string) => void) => {
      const status =
        ((await ipcRenderer.invoke("opensteer-cws:getMV2DeprecationStatus")) as
          string | undefined) ?? MV2DeprecationStatus.SOFT_DISABLE;
      callback?.(status);
      return status;
    },
    getReferrerChain: async (callback?: (chain: string) => void) => {
      callback?.("EgIIAA==");
      return "EgIIAA==";
    },
    getStoreLogin: async (callback?: (login: string) => void) => {
      callback?.("");
      return "";
    },
    getWebGLStatus: async (callback?: (status: string) => void) => {
      const status =
        ((await ipcRenderer.invoke("opensteer-cws:getWebGLStatus")) as string | undefined) ??
        WebGlStatus.WEBGL_ALLOWED;
      callback?.(status);
      return status;
    },
    install: async (
      _id: string,
      _silent?: boolean,
      callback?: (result: string) => void,
    ): Promise<string> => {
      callback?.(Result.SUCCESS);
      return Result.SUCCESS;
    },
    isInIncognitoMode: async (callback?: (incognito: boolean) => void) => {
      callback?.(false);
      return false;
    },
    isPendingCustodianApproval: async (_id: string, callback?: (pending: boolean) => void) => {
      callback?.(false);
      return false;
    },
    setStoreLogin: async (_login: string, callback?: (ok: boolean) => void) => {
      callback?.(true);
      return true;
    },
  };

  const wrappedInstalled = new WeakMap<
    (info: unknown) => void,
    (_event: Electron.IpcRendererEvent, info: unknown) => void
  >();

  const management = {
    onInstalled: {
      addListener: (callback: (info: unknown) => void) => {
        if (typeof callback !== "function" || wrappedInstalled.has(callback)) return;
        const wrapped = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info);
        wrappedInstalled.set(callback, wrapped);
        ipcRenderer.on("opensteer-cws:onInstalled", wrapped);
      },
      removeListener: (callback: (info: unknown) => void) => {
        const wrapped = wrappedInstalled.get(callback);
        if (!wrapped) return;
        wrappedInstalled.delete(callback);
        ipcRenderer.removeListener("opensteer-cws:onInstalled", wrapped);
      },
    },
    onUninstalled: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
    getAll: (callback?: (list: unknown[]) => void) =>
      ipcRenderer.invoke("opensteer-cws:getAll").then((list: unknown) => {
        const items = Array.isArray(list) ? list : [];
        callback?.(items);
        return items;
      }),
    setEnabled: async () => true,
    uninstall: (_id: string, _options?: unknown, callback?: () => void) => {
      void ipcRenderer.invoke("opensteer-cws:uninstall").then(() => callback?.());
    },
  };

  function installInMainWorld(
    storeBridge: typeof webstorePrivateBridge,
    mgmtApi: typeof management,
  ): void {
    const chromeObj = ((globalThis as { chrome?: Record<string, unknown> }).chrome ??= {});
    const setExtensionLastError = (message: string | undefined) => {
      const extObj = ((chromeObj.extension as Record<string, unknown> | undefined) ??
        (chromeObj.extension = {})) as Record<string, unknown>;
      extObj.lastError = message ? { message } : undefined;
    };

    const { beginInstallRaw, ...restStore } = storeBridge;
    chromeObj.webstorePrivate = {
      ...restStore,
      beginInstallWithManifest3: async (
        details: unknown,
        callback?: (result: string) => void,
      ): Promise<string> => {
        // Match Chrome's WebstorePrivateBeginInstallWithManifest3Function: require an active user gesture.
        if (
          typeof navigator !== "undefined" &&
          navigator.userActivation &&
          !navigator.userActivation.isActive
        ) {
          const result = storeBridge.Result.USER_GESTURE_REQUIRED;
          setExtensionLastError("This function must be called during a user gesture");
          try {
            callback?.(result);
          } finally {
            setExtensionLastError(undefined);
          }
          return result;
        }
        const reply = await beginInstallRaw(details);
        const result = reply.result || storeBridge.Result.UNKNOWN_ERROR;
        setExtensionLastError(
          result === storeBridge.Result.SUCCESS ? undefined : (reply.message ?? result),
        );
        try {
          callback?.(result);
        } finally {
          setExtensionLastError(undefined);
        }
        return result;
      },
    };
    chromeObj.runtime = Object.assign(
      (chromeObj.runtime as Record<string, unknown> | undefined) ?? {},
      { lastError: null, getManifest: async () => ({}) },
    );
    chromeObj.management = Object.assign(
      (chromeObj.management as Record<string, unknown> | undefined) ?? {},
      mgmtApi,
    );
  }

  // Pass bridge objects directly via executeInMainWorld args so no extra globals leak onto window.
  if (process.contextIsolated) {
    contextBridge.executeInMainWorld({
      func: installInMainWorld,
      args: [webstorePrivateBridge, management],
    });
  } else {
    installInMainWorld(webstorePrivateBridge, management);
  }
}

if (
  typeof window !== "undefined" &&
  window.location.origin === CHROME_WEB_STORE_ORIGIN &&
  window.top === window
) {
  installWebStoreBridge();
}
