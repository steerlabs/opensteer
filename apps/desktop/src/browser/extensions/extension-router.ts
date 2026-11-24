import {
  ipcMain,
  type Extension,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { extensionIdFromOrigin } from "./permissions.js";

export const EXTENSION_CALL_CHANNEL = "opensteer-crx:call";
export const EXTENSION_LISTEN_CHANNEL = "opensteer-crx:listen";
export const EXTENSION_UNLISTEN_CHANNEL = "opensteer-crx:unlisten";
export const EXTENSION_EVENT_PREFIX = "opensteer-crx:event:";

export interface ExtensionCallContext {
  readonly type: "frame" | "service-worker";
  readonly extension: Extension;
  readonly sender: WebContents | ServiceWorkerMain;
  readonly frame?: WebFrameMain;
}

export type ExtensionCallHandler = (
  context: ExtensionCallContext,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type FrameListener = {
  readonly type: "frame";
  readonly extensionId: string;
  readonly host: WebContents;
  readonly frame: WebFrameMain;
};

type WorkerListener = {
  readonly type: "service-worker";
  readonly extensionId: string;
};

type EventListenerEntry = FrameListener | WorkerListener;

type WorkerIpcEvent = {
  readonly type: "service-worker";
  readonly session: Session;
  readonly serviceWorker: ServiceWorkerMain;
};

function isWorkerEvent(
  event: IpcMainInvokeEvent | IpcMainEvent | WorkerIpcEvent,
): event is WorkerIpcEvent {
  return (event as { readonly type?: unknown }).type === "service-worker";
}

/**
 * Derives the calling extension's ID strictly from Electron's trusted `senderFrame.origin`
 * or `serviceWorker.scope` — never from any renderer-supplied argument or enclosing tab URL.
 */
export function resolveCallerExtension(
  session: Session,
  event: IpcMainInvokeEvent | IpcMainEvent | WorkerIpcEvent,
): ExtensionCallContext | null {
  if (isWorkerEvent(event)) {
    const extensionId = extensionIdFromOrigin(event.serviceWorker?.scope);
    if (!extensionId) return null;
    const extension = session.extensions.getExtension(extensionId);
    if (!extension) return null;
    return { type: "service-worker", extension, sender: event.serviceWorker };
  }
  const frame = event.senderFrame;
  if (!frame || frame.isDestroyed()) return null;
  const extensionId = extensionIdFromOrigin(frame.origin);
  if (!extensionId) return null;
  const extension = session.extensions.getExtension(extensionId);
  if (!extension) return null;
  return { type: "frame", extension, sender: event.sender, frame };
}

class RoutingDelegate {
  static #instance: RoutingDelegate | null = null;
  readonly #routers = new Map<Session, ExtensionRouter>();
  readonly #workers = new WeakSet<ServiceWorkerMain>();

  static get(): RoutingDelegate {
    return (RoutingDelegate.#instance ??= new RoutingDelegate());
  }

  private constructor() {
    ipcMain.handle(EXTENSION_CALL_CHANNEL, (event, method: unknown, ...args: unknown[]) => {
      const session = event.sender.session;
      const router = this.#routers.get(session);
      if (!router) throw new Error("Extensions are not active in this session.");
      return router.dispatchCall(event, method, args);
    });
    ipcMain.on(EXTENSION_LISTEN_CHANNEL, (event, eventName: unknown) => {
      const router = this.#routers.get(event.sender.session);
      router?.registerListener(event, eventName);
    });
    ipcMain.on(EXTENSION_UNLISTEN_CHANNEL, (event, eventName: unknown) => {
      const router = this.#routers.get(event.sender.session);
      router?.unregisterListener(event, eventName);
    });
  }

  attach(router: ExtensionRouter): () => void {
    const { session } = router;
    this.#routers.set(session, router);
    const onWorkerStatus = ({
      runningStatus,
      versionId,
    }: {
      readonly runningStatus: string;
      readonly versionId: number;
    }) => {
      if (runningStatus !== "starting") return;
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || this.#workers.has(worker)) return;
      if (!extensionIdFromOrigin(worker.scope)) return;
      this.#workers.add(worker);
      worker.ipc.handle(EXTENSION_CALL_CHANNEL, (event, method: unknown, ...args: unknown[]) => {
        const current = this.#routers.get(session);
        if (!current) throw new Error("Extensions are not active in this session.");
        return current.dispatchCall(event as unknown as WorkerIpcEvent, method, args);
      });
      worker.ipc.on(EXTENSION_LISTEN_CHANNEL, (event, eventName: unknown) => {
        this.#routers.get(session)?.registerListener(event as unknown as WorkerIpcEvent, eventName);
      });
      worker.ipc.on(EXTENSION_UNLISTEN_CHANNEL, (event, eventName: unknown) => {
        this.#routers
          .get(session)
          ?.unregisterListener(event as unknown as WorkerIpcEvent, eventName);
      });
    };
    session.serviceWorkers.on("running-status-changed", onWorkerStatus);
    return () => {
      session.serviceWorkers.off("running-status-changed", onWorkerStatus);
      if (this.#routers.get(session) === router) this.#routers.delete(session);
    };
  }
}

/**
 * Per-Session extension IPC router. Every API call and event subscription is bound to
 * the caller's exact live `WebFrameMain` or `ServiceWorkerMain` origin in main, and
 * re-verified before every event delivery.
 */
export class ExtensionRouter {
  readonly session: Session;
  readonly #handlers = new Map<string, ExtensionCallHandler>();
  readonly #listeners = new Map<string, EventListenerEntry[]>();
  readonly #observedHosts = new Map<WebContents, () => void>();
  readonly #detachDelegate: () => void;
  readonly #onUnloaded: (_event: Electron.Event, extension: Extension) => void;
  #disposed = false;

  constructor(session: Session) {
    this.session = session;
    this.#detachDelegate = RoutingDelegate.get().attach(this);
    this.#onUnloaded = (_event, extension) => {
      this.#pruneListeners((entry) => entry.extensionId !== extension.id);
    };
    session.extensions.on("extension-unloaded", this.#onUnloaded);
  }

  handle(method: string, handler: ExtensionCallHandler): void {
    this.#handlers.set(method, handler);
  }

  async dispatchCall(
    event: IpcMainInvokeEvent | WorkerIpcEvent,
    method: unknown,
    args: unknown[],
  ): Promise<unknown> {
    if (this.#disposed) throw new Error("Extension router is closed.");
    if (typeof method !== "string") throw new Error("Invalid extension API method.");
    const handler = this.#handlers.get(method);
    if (!handler) throw new Error(`Unsupported extension API: ${method}`);
    const caller = resolveCallerExtension(this.session, event);
    if (!caller) throw new Error(`Unauthorized extension API caller for ${method}.`);
    return await handler(caller, ...args);
  }

  registerListener(event: IpcMainEvent | WorkerIpcEvent, eventName: unknown): void {
    if (this.#disposed || typeof eventName !== "string" || !eventName) return;
    const caller = resolveCallerExtension(this.session, event);
    if (!caller) return;
    const entry: EventListenerEntry =
      caller.type === "frame" && caller.frame
        ? {
            type: "frame",
            extensionId: caller.extension.id,
            host: caller.sender as WebContents,
            frame: caller.frame,
          }
        : { type: "service-worker", extensionId: caller.extension.id };
    const list = this.#listeners.get(eventName) ?? [];
    if (list.some((existing) => sameListener(existing, entry))) return;
    list.push(entry);
    this.#listeners.set(eventName, list);
    if (entry.type === "frame" && !this.#observedHosts.has(entry.host)) {
      this.#observeHost(entry.host);
    }
  }

  unregisterListener(event: IpcMainEvent | WorkerIpcEvent, eventName: unknown): void {
    if (typeof eventName !== "string" || !eventName) return;
    const caller = resolveCallerExtension(this.session, event);
    if (!caller) return;
    const target: EventListenerEntry =
      caller.type === "frame" && caller.frame
        ? {
            type: "frame",
            extensionId: caller.extension.id,
            host: caller.sender as WebContents,
            frame: caller.frame,
          }
        : { type: "service-worker", extensionId: caller.extension.id };
    this.#pruneListeners((item) => !sameListener(item, target), eventName);
  }

  /** Sends an event to a single extension's registered listeners. */
  sendToExtension(extensionId: string, eventName: string, ...args: unknown[]): void {
    if (this.#disposed) return;
    const list = this.#listeners.get(eventName);
    if (!list?.length) return;
    const channel = `${EXTENSION_EVENT_PREFIX}${eventName}`;
    for (const entry of list.slice()) {
      if (entry.extensionId !== extensionId) continue;
      this.#deliver(entry, eventName, channel, args);
    }
  }

  /**
   * Broadcasts an event with per-extension authorization and payload sanitization.
   * Return `null` from `authorize` to skip an extension; return an args array to deliver.
   * Optional `canDeliver` is re-checked asynchronously right before delivering to a woken worker.
   */
  broadcastAuthorized(
    eventName: string,
    authorize: (extension: Extension) => readonly unknown[] | null,
    canDeliver?: () => boolean,
  ): void {
    if (this.#disposed) return;
    if (canDeliver && !canDeliver()) return;
    const list = this.#listeners.get(eventName);
    if (!list?.length) return;
    const channel = `${EXTENSION_EVENT_PREFIX}${eventName}`;
    const decisions = new Map<string, readonly unknown[] | null>();
    for (const entry of list.slice()) {
      let args = decisions.get(entry.extensionId);
      if (args === undefined) {
        const extension = this.session.extensions.getExtension(entry.extensionId);
        args = extension ? authorize(extension) : null;
        decisions.set(entry.extensionId, args);
      }
      if (args) this.#deliver(entry, eventName, channel, args, canDeliver);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const unobserve of this.#observedHosts.values()) unobserve();
    this.#observedHosts.clear();
    this.#listeners.clear();
    this.#handlers.clear();
    this.session.extensions.off("extension-unloaded", this.#onUnloaded);
    this.#detachDelegate();
  }

  #observeHost(host: WebContents): void {
    const pruneNavigatedFrame = (processId: number, routingId: number) => {
      this.#pruneListeners(
        (item) =>
          item.type !== "frame" ||
          item.host !== host ||
          (!item.frame.isDestroyed() &&
            !(item.frame.processId === processId && item.frame.routingId === routingId) &&
            extensionIdFromOrigin(item.frame.origin) === item.extensionId),
      );
    };
    const onDidStartNav = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      _isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      if (isInPlace) return;
      pruneNavigatedFrame(frameProcessId, frameRoutingId);
    };
    const onDidFrameNav = (
      _event: Electron.Event,
      _url: string,
      _code: number,
      _status: string,
      _isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      pruneNavigatedFrame(frameProcessId, frameRoutingId);
    };
    const onDestroyed = () => {
      this.#observedHosts.delete(host);
      this.#pruneListeners((item) => item.type !== "frame" || item.host !== host);
    };
    host.on("did-start-navigation", onDidStartNav);
    host.on("did-frame-navigate", onDidFrameNav);
    host.once("destroyed", onDestroyed);
    this.#observedHosts.set(host, () => {
      if (!host.isDestroyed()) {
        host.off("did-start-navigation", onDidStartNav);
        host.off("did-frame-navigate", onDidFrameNav);
        host.off("destroyed", onDestroyed);
      }
    });
  }

  #deliver(
    entry: EventListenerEntry,
    eventName: string,
    channel: string,
    args: readonly unknown[],
    canDeliver?: () => boolean,
  ): void {
    if (entry.type === "service-worker") {
      const scope = `chrome-extension://${entry.extensionId}/`;
      void this.session.serviceWorkers
        .startWorkerForScope(scope)
        .then((worker) => {
          if (
            !this.#disposed &&
            (!canDeliver || canDeliver()) &&
            this.session.extensions.getExtension(entry.extensionId) &&
            extensionIdFromOrigin(worker.scope) === entry.extensionId
          ) {
            worker.send(channel, ...args);
          }
        })
        .catch(() => undefined);
      return;
    }
    // Re-verify frame identity immediately before delivery so navigation to another
    // origin or extension can never receive events authorized for the previous document.
    if (
      (canDeliver && !canDeliver()) ||
      entry.host.isDestroyed() ||
      entry.frame.isDestroyed() ||
      extensionIdFromOrigin(entry.frame.origin) !== entry.extensionId
    ) {
      this.#pruneListeners((item) => !sameListener(item, entry), eventName);
      return;
    }
    entry.frame.send(channel, ...args);
  }

  #pruneListeners(predicate: (entry: EventListenerEntry) => boolean, onlyEvent?: string): void {
    const keys = onlyEvent ? [onlyEvent] : [...this.#listeners.keys()];
    for (const key of keys) {
      const list = this.#listeners.get(key);
      if (!list) continue;
      const next = list.filter(predicate);
      if (next.length) this.#listeners.set(key, next);
      else this.#listeners.delete(key);
    }
  }
}

function sameListener(left: EventListenerEntry, right: EventListenerEntry): boolean {
  if (left.type !== right.type || left.extensionId !== right.extensionId) return false;
  if (left.type === "frame" && right.type === "frame") {
    return left.host === right.host && left.frame === right.frame;
  }
  return true;
}
