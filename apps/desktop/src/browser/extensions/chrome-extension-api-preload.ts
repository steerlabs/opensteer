import { contextBridge, ipcRenderer } from "electron";

const CALL_CHANNEL = "opensteer-crx:call";
const LISTEN_CHANNEL = "opensteer-crx:listen";
const UNLISTEN_CHANNEL = "opensteer-crx:unlisten";
const EVENT_PREFIX = "opensteer-crx:event:";

function isExtensionContext(): boolean {
  if (process.type === "service-worker") return true;
  try {
    return globalThis.location?.protocol === "chrome-extension:";
  } catch {
    return false;
  }
}

interface InternalBridge {
  invoke: (method: string, args: unknown[]) => Promise<unknown>;
  addListener: (eventName: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (eventName: string, callback: (...args: unknown[]) => void) => void;
}

function installExtensionApis(): void {
  const listenerCounts = new Map<string, number>();
  const wrappedCallbacks = new WeakMap<
    (...args: unknown[]) => void,
    Map<string, (_event: Electron.IpcRendererEvent, ...args: unknown[]) => void>
  >();

  const bridge: InternalBridge = {
    invoke: (method, args) => ipcRenderer.invoke(CALL_CHANNEL, method, ...args),
    addListener: (eventName, callback) => {
      let byEvent = wrappedCallbacks.get(callback);
      if (!byEvent) {
        byEvent = new Map();
        wrappedCallbacks.set(callback, byEvent);
      }
      if (byEvent.has(eventName)) return;
      const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
      byEvent.set(eventName, wrapped);
      const count = listenerCounts.get(eventName) ?? 0;
      if (count === 0) ipcRenderer.send(LISTEN_CHANNEL, eventName);
      listenerCounts.set(eventName, count + 1);
      ipcRenderer.addListener(`${EVENT_PREFIX}${eventName}`, wrapped);
    },
    removeListener: (eventName, callback) => {
      const byEvent = wrappedCallbacks.get(callback);
      const wrapped = byEvent?.get(eventName);
      if (!byEvent || !wrapped) return;
      byEvent.delete(eventName);
      ipcRenderer.removeListener(`${EVENT_PREFIX}${eventName}`, wrapped);
      const count = (listenerCounts.get(eventName) ?? 1) - 1;
      if (count <= 0) {
        listenerCounts.delete(eventName);
        ipcRenderer.send(UNLISTEN_CHANNEL, eventName);
      } else {
        listenerCounts.set(eventName, count);
      }
    },
  };

  function mainWorldScript(internal: InternalBridge): void {
    if (!internal) return;

    const chromeObj = ((globalThis as { chrome?: Record<string, unknown> }).chrome ??= {});
    const runtimeObj = ((chromeObj.runtime as Record<string, unknown> | undefined) ??
      (chromeObj.runtime = {})) as Record<string, unknown>;
    const manifest =
      typeof runtimeObj.getManifest === "function"
        ? ((runtimeObj.getManifest as () => Record<string, unknown>)() ?? {})
        : {};

    const setLastError = (message: string | undefined) => {
      const targetRuntime =
        chromeObj.runtime && typeof chromeObj.runtime === "object"
          ? (chromeObj.runtime as Record<string, unknown>)
          : runtimeObj;
      try {
        Object.defineProperty(targetRuntime, "lastError", {
          value: message ? { message } : undefined,
          configurable: true,
          writable: true,
          enumerable: true,
        });
      } catch {
        targetRuntime.lastError = message ? { message } : undefined;
      }
    };

    const callApi =
      (
        method: string,
        options: {
          readonly noop?: boolean;
          readonly defaultResponse?: unknown;
          readonly prepare?: (args: unknown[]) => Promise<unknown[]> | unknown[];
        } = {},
      ) =>
      (...rawArgs: unknown[]) => {
        const callback =
          typeof rawArgs[rawArgs.length - 1] === "function"
            ? (rawArgs.pop() as (result?: unknown) => void)
            : undefined;

        const run = async () => {
          if (options.noop) return options.defaultResponse;
          const prepared = options.prepare ? await options.prepare(rawArgs) : rawArgs;
          return await internal.invoke(method, prepared);
        };

        if (callback) {
          run().then(
            (value) => {
              setLastError(undefined);
              callback(value);
            },
            (error: unknown) => {
              setLastError(error instanceof Error ? error.message : String(error));
              try {
                callback(undefined);
              } finally {
                setLastError(undefined);
              }
            },
          );
          return undefined;
        }
        return run();
      };

    class ExtensionEvent {
      readonly #name: string;
      readonly #callbacks = new Set<(...args: unknown[]) => void>();
      constructor(name: string) {
        this.#name = name;
      }
      addListener(callback: (...args: unknown[]) => void): void {
        if (typeof callback !== "function" || this.#callbacks.has(callback)) return;
        this.#callbacks.add(callback);
        internal.addListener(this.#name, callback);
      }
      removeListener(callback: (...args: unknown[]) => void): void {
        if (!this.#callbacks.delete(callback)) return;
        internal.removeListener(this.#name, callback);
      }
      hasListener(callback: (...args: unknown[]) => void): boolean {
        return this.#callbacks.has(callback);
      }
      hasListeners(): boolean {
        return this.#callbacks.size > 0;
      }
    }

    async function imageDataToDataUrl(imageData: ImageData): Promise<string | null> {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(imageData.width, imageData.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.putImageData(imageData, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        return `data:image/png;base64,${btoa(binary)}`;
      }
      if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL("image/png");
      }
      return null;
    }

    const prepareSetIcon = async (args: unknown[]): Promise<unknown[]> => {
      const details = args[0];
      if (!details || typeof details !== "object") return args;
      const copy: Record<string, unknown> = { ...(details as Record<string, unknown>) };
      const rawImageData = copy.imageData;
      if (rawImageData) {
        if (typeof ImageData !== "undefined" && rawImageData instanceof ImageData) {
          copy.imageData = await imageDataToDataUrl(rawImageData);
        } else if (typeof rawImageData === "object") {
          const encoded: Record<string, string> = {};
          for (const [size, item] of Object.entries(rawImageData as Record<string, unknown>)) {
            if (typeof ImageData !== "undefined" && item instanceof ImageData) {
              const url = await imageDataToDataUrl(item);
              if (url) encoded[size] = url;
            }
          }
          copy.imageData = encoded;
        }
      }
      return [copy];
    };

    // Augment existing native namespaces in place when possible so native descriptors
    // and live getters (such as chrome.runtime.id / lastError) are preserved intact.
    const extendNamespace = (name: string, additions: Record<string, unknown>) => {
      const existing = chromeObj[name];
      if (existing && typeof existing === "object") {
        try {
          for (const [key, value] of Object.entries(additions)) {
            Object.defineProperty(existing, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          return;
        } catch {
          // Fall back to defining a fresh merged namespace if the native object is non-extensible.
        }
      }
      const merged =
        existing && typeof existing === "object"
          ? Object.assign(Object.create(Object.getPrototypeOf(existing)), existing, additions)
          : { ...additions };
      Object.defineProperty(chromeObj, name, {
        value: merged,
        enumerable: true,
        configurable: true,
      });
    };

    if (manifest.action && typeof manifest.action === "object") {
      extendNamespace("action", {
        setTitle: callApi("action.setTitle"),
        getTitle: callApi("action.getTitle"),
        setIcon: callApi("action.setIcon", { prepare: prepareSetIcon }),
        setPopup: callApi("action.setPopup"),
        getPopup: callApi("action.getPopup"),
        setBadgeText: callApi("action.setBadgeText"),
        getBadgeText: callApi("action.getBadgeText"),
        setBadgeBackgroundColor: callApi("action.setBadgeBackgroundColor"),
        getBadgeBackgroundColor: callApi("action.getBadgeBackgroundColor"),
        getUserSettings: callApi("action.getUserSettings"),
        enable: callApi("action.enable", { noop: true }),
        disable: callApi("action.disable", { noop: true }),
        openPopup: callApi("action.openPopup"),
        onClicked: new ExtensionEvent("action.onClicked"),
      });
    }

    extendNamespace("tabs", {
      TAB_ID_NONE: -1,
      get: callApi("tabs.get"),
      getCurrent: callApi("tabs.getCurrent"),
      getAllInWindow: callApi("tabs.getAllInWindow"),
      query: callApi("tabs.query"),
      create: callApi("tabs.create"),
      update: callApi("tabs.update"),
      remove: callApi("tabs.remove"),
      reload: callApi("tabs.reload"),
      goBack: callApi("tabs.goBack"),
      goForward: callApi("tabs.goForward"),
      insertCSS: callApi("tabs.insertCSS"),
      onCreated: new ExtensionEvent("tabs.onCreated"),
      onUpdated: new ExtensionEvent("tabs.onUpdated"),
      onRemoved: new ExtensionEvent("tabs.onRemoved"),
      onActivated: new ExtensionEvent("tabs.onActivated"),
    });

    extendNamespace("windows", {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      get: callApi("windows.get"),
      getCurrent: callApi("windows.getCurrent"),
      getLastFocused: callApi("windows.getLastFocused"),
      getAll: callApi("windows.getAll"),
      create: callApi("windows.create"),
      update: callApi("windows.update"),
      remove: callApi("windows.remove"),
      onCreated: new ExtensionEvent("windows.onCreated"),
      onRemoved: new ExtensionEvent("windows.onRemoved"),
      onFocusChanged: new ExtensionEvent("windows.onFocusChanged"),
      onBoundsChanged: new ExtensionEvent("windows.onBoundsChanged"),
    });

    extendNamespace("cookies", {
      get: callApi("cookies.get"),
      getAll: callApi("cookies.getAll"),
      set: callApi("cookies.set"),
      remove: callApi("cookies.remove"),
      getAllCookieStores: callApi("cookies.getAllCookieStores"),
      onChanged: new ExtensionEvent("cookies.onChanged"),
    });

    let menuCounter = 0;
    const createMenuCall = callApi("contextMenus.create");
    extendNamespace("contextMenus", {
      create(createProperties: Record<string, unknown>, callback?: () => void) {
        const props = { ...createProperties };
        if (props.id === undefined) props.id = `menu-${++menuCounter}`;
        void createMenuCall(props, ...(callback ? [callback] : []));
        return props.id;
      },
      update: callApi("contextMenus.update"),
      remove: callApi("contextMenus.remove"),
      removeAll: callApi("contextMenus.removeAll"),
      onClicked: new ExtensionEvent("contextMenus.onClicked"),
    });

    extendNamespace("webNavigation", {
      getFrame: callApi("webNavigation.getFrame"),
      getAllFrames: callApi("webNavigation.getAllFrames"),
      onBeforeNavigate: new ExtensionEvent("webNavigation.onBeforeNavigate"),
      onCommitted: new ExtensionEvent("webNavigation.onCommitted"),
      onCompleted: new ExtensionEvent("webNavigation.onCompleted"),
      onDOMContentLoaded: new ExtensionEvent("webNavigation.onDOMContentLoaded"),
      onHistoryStateUpdated: new ExtensionEvent("webNavigation.onHistoryStateUpdated"),
      onCreatedNavigationTarget: new ExtensionEvent("webNavigation.onCreatedNavigationTarget"),
    });

    extendNamespace("notifications", {
      create: callApi("notifications.create"),
      update: callApi("notifications.update"),
      clear: callApi("notifications.clear"),
      getAll: callApi("notifications.getAll"),
      getPermissionLevel: callApi("notifications.getPermissionLevel"),
      onClicked: new ExtensionEvent("notifications.onClicked"),
      onClosed: new ExtensionEvent("notifications.onClosed"),
    });

    extendNamespace("permissions", {
      contains: callApi("permissions.contains"),
      getAll: callApi("permissions.getAll"),
      remove: callApi("permissions.remove"),
      request: callApi("permissions.request"),
      onAdded: new ExtensionEvent("permissions.onAdded"),
      onRemoved: new ExtensionEvent("permissions.onRemoved"),
    });

    extendNamespace("commands", {
      getAll: callApi("commands.getAll"),
      onCommand: new ExtensionEvent("commands.onCommand"),
    });

    extendNamespace("runtime", {
      openOptionsPage: callApi("runtime.openOptionsPage"),
    });

    const storageBase = chromeObj.storage as Record<string, unknown> | undefined;
    if (storageBase && typeof storageBase === "object") {
      extendNamespace("storage", {
        ...(!storageBase.sync && storageBase.local ? { sync: storageBase.local } : {}),
        ...(!storageBase.managed && storageBase.local ? { managed: storageBase.local } : {}),
      });
    }

    const i18nBase = chromeObj.i18n as Record<string, unknown> | undefined;
    if (!i18nBase || typeof i18nBase.getMessage !== "function") {
      extendNamespace("i18n", {
        getUILanguage: () => "en-US",
        getAcceptLanguages: (cb?: (langs: string[]) => void) => {
          const langs = ["en-US"];
          if (cb) queueMicrotask(() => cb(langs));
          return Promise.resolve(langs);
        },
        getMessage: (name: string) => name,
      });
    }

    extendNamespace("extension", {
      isAllowedFileSchemeAccess: callApi("extension.isAllowedFileSchemeAccess", {
        noop: true,
        defaultResponse: false,
      }),
      isAllowedIncognitoAccess: callApi("extension.isAllowedIncognitoAccess", {
        noop: true,
        defaultResponse: false,
      }),
      getViews: () => [],
    });
  }

  // Pass `bridge` directly via executeInMainWorld args so no non-configurable global leaks onto window.
  if (process.contextIsolated) {
    contextBridge.executeInMainWorld({ func: mainWorldScript, args: [bridge] });
  } else {
    mainWorldScript(bridge);
  }
}

if (isExtensionContext()) {
  installExtensionApis();
}
