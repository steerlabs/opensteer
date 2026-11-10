import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpCommand,
  type CdpEvent,
  type CdpParameters,
} from "@opensteer/browser-core/session-cdp-router";
import type { PhoneBrowserNativePort, NativeDocumentRef } from "./native-port.js";
import { PhoneBrowserError } from "./native-port.js";
import { agentObservationMethods } from "@opensteer/browser-core/agent-cdp-policy";
import type { PhoneTab } from "./state.js";

export interface PhoneCdpOwner {
  readonly sessionId: string;
  readonly epoch: number;
  readonly attachmentId: string;
  readonly filesRoot: string;
  readonly uuid: () => string;
  readonly tabs: () => readonly PhoneTab[];
  readonly ref: (tab: PhoneTab) => NativeDocumentRef;
  readonly resume: (tab: PhoneTab) => Promise<void>;
  readonly create: (url: string) => Promise<PhoneTab>;
  readonly close: (tab: PhoneTab) => Promise<void>;
  readonly event: (event: CdpEvent) => void;
  readonly execute: <Result>(
    tab: PhoneTab,
    work: () => Promise<Result>,
    independent: boolean,
  ) => Promise<Result>;
  readonly dialog: (tab: PhoneTab, accept: boolean, promptText?: string) => Promise<void>;
}

export class PhoneCdpSession {
  readonly #native: PhoneBrowserNativePort;
  readonly #owner: PhoneCdpOwner;
  readonly #router: SessionCdpRouter;
  readonly #backendListeners = new Set<(method: string, params: CdpParameters) => void>();
  readonly #pipes = new Map<
    string,
    {
      tab: PhoneTab;
      generation: number;
      listeners: Set<(method: string, params: CdpParameters) => void>;
    }
  >();
  readonly #targets = new Map<string, { generation: number; live: boolean }>();
  #sequence = 0;
  #closed = false;

  constructor(native: PhoneBrowserNativePort, owner: PhoneCdpOwner) {
    this.#native = native;
    this.#owner = owner;
    const backend: BrowserCdpBackend = {
      attach: (targetId) => this.#attach(targetId),
      onEvent: (listener) => {
        this.#backendListeners.add(listener);
        return () => this.#backendListeners.delete(listener);
      },
      send: (method, params) => this.#send(method, params ?? {}),
    };
    this.#router = new SessionCdpRouter(
      backend,
      {
        uuid: owner.uuid,
        isNormalizedAbsolutePath: (value) =>
          value === owner.filesRoot &&
          value.startsWith("/") &&
          value
            .slice(1)
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
        containsFile: (root, value) =>
          root === owner.filesRoot &&
          value.startsWith(`${root}/`) &&
          !value.split("/").some((part) => part === ".." || part === ".") &&
          !value.includes("\0"),
      },
      {},
      true,
    );
    const first = owner.tabs()[0];
    if (!first) throw new PhoneBrowserError("target-closed", "The session has no tabs.");
    this.#router.registerSession(
      owner.sessionId,
      first.id,
      async (targetId) => owner.tabs().some((tab) => tab.id === targetId),
      owner.filesRoot,
    );
    for (const tab of owner.tabs().slice(1)) this.#router.claimTarget(owner.sessionId, tab.id);
    for (const tab of owner.tabs())
      this.#targets.set(tab.id, {
        generation: tab.metadata.generation,
        live: tab.state === "live-covered" || tab.state === "live-visible",
      });
    this.#router.onEvent(owner.sessionId, owner.event);
  }

  send(command: CdpCommand): Promise<unknown> {
    return this.#router.send(this.#owner.sessionId, command);
  }

  async capture(command: CdpCommand, channelId: string, requestId: string): Promise<boolean> {
    if (command.method !== "Page.captureScreenshot") return false;
    const { captureBeyondViewport, fromSurface, ...parameters } = command.parameters ?? {};
    if (
      (captureBeyondViewport !== undefined && captureBeyondViewport !== false) ||
      (fromSurface !== undefined && fromSurface !== true)
    )
      throw new PhoneBrowserError(
        "unsupported-operation",
        "Capture is limited to the native viewport.",
      );
    const signal = this.#router.admitPageCommand(this.#owner.sessionId, { ...command, parameters });
    const tab = this.#tab(
      command.sessionId
        ? this.#router.attachedTargetId(this.#owner.sessionId, command.sessionId)
        : null,
    );
    const params = parameters;
    const format = params.format ?? "png";
    if (format !== "png" && format !== "jpeg")
      throw new PhoneBrowserError(
        "unsupported-operation",
        "Native capture supports PNG and JPEG only.",
      );
    if (typeof params.quality === "number" && (params.quality < 0 || params.quality > 100))
      throw new PhoneBrowserError("unsupported-operation", "Invalid native capture quality.");
    if (
      params.clip &&
      typeof params.clip === "object" &&
      "scale" in params.clip &&
      params.clip.scale !== 1
    )
      throw new PhoneBrowserError(
        "unsupported-operation",
        "Native capture keeps the viewport's scale.",
      );
    signal.throwIfAborted();
    await this.#native.captureOnce({
      ...this.#owner.ref(tab),
      channelId,
      requestId,
      attachmentId: this.#owner.attachmentId,
      format,
      ...(typeof params.quality === "number" ? { quality: params.quality } : {}),
      ...(params.clip && typeof params.clip === "object"
        ? { clip: params.clip as { x: number; y: number; width: number; height: number } }
        : {}),
    });
    return true;
  }

  nativeEvent(pipeHandle: string, method: string, params: CdpParameters): void {
    const pipe = this.#pipes.get(pipeHandle);
    if (
      !pipe ||
      pipe.generation !== pipe.tab.metadata.generation ||
      (pipe.tab.state !== "live-covered" && pipe.tab.state !== "live-visible")
    )
      return;
    for (const listener of pipe.listeners) listener(method, params);
  }

  surfaceChanged(tab: PhoneTab): void {
    if (this.#closed || tab.sessionId !== this.#owner.sessionId) return;
    const previous = this.#targets.get(tab.id);
    const live = tab.state === "live-covered" || tab.state === "live-visible";
    if (previous && (previous.generation !== tab.metadata.generation || (previous.live && !live)))
      for (const listener of this.#backendListeners)
        listener("Target.targetDestroyed", { targetId: tab.id });
    this.#targets.set(tab.id, { generation: tab.metadata.generation, live });
    const method = tab.state === "closed" ? "Target.targetDestroyed" : "Target.targetInfoChanged";
    const params = tab.state === "closed" ? { targetId: tab.id } : { targetInfo: targetInfo(tab) };
    if (tab.state !== "closed") this.#router.claimTarget(this.#owner.sessionId, tab.id);
    for (const listener of this.#backendListeners) listener(method, params);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#router.close();
    } finally {
      await this.#native.releaseCdp({
        epoch: this.#owner.epoch,
        attachmentId: this.#owner.attachmentId,
      });
    }
  }

  #tab(targetId: unknown): PhoneTab {
    const tab = this.#owner.tabs().find((entry) => entry.id === targetId);
    if (!tab) throw new PhoneBrowserError("target-closed", "The tab is closed.");
    return tab;
  }

  async #attach(targetId: string): Promise<CdpChannel> {
    const tab = this.#tab(targetId);
    await this.#owner.resume(tab);
    const reference = this.#owner.ref(tab);
    const pipeHandle = await this.#native.openCdpPipe({
      ...reference,
      attachmentId: this.#owner.attachmentId,
    });
    const listeners = new Set<(method: string, params: CdpParameters) => void>();
    this.#pipes.set(pipeHandle, { tab, generation: reference.generation, listeners });
    return {
      close: async () => {
        this.#pipes.delete(pipeHandle);
        await this.#native.closeCdpPipe({ epoch: this.#owner.epoch, pipeHandle });
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (method, params = {}) => {
        if (this.#closed || tab.metadata.generation !== reference.generation)
          throw new PhoneBrowserError("target-closed", "The native target was replaced.");
        if (method === "Page.bringToFront") return Promise.resolve({});
        if (method === "Page.startScreencast")
          throw new PhoneBrowserError(
            "unsupported-operation",
            "Use the native viewer stream or a viewport capture.",
          );
        if (method === "Page.handleJavaScriptDialog")
          return this.#owner
            .dialog(
              tab,
              params.accept === true,
              typeof params.promptText === "string" ? params.promptText : undefined,
            )
            .then(() => ({}));
        return this.#owner.execute(
          tab,
          () =>
            this.#native.sendCdp({
              ...this.#owner.ref(tab),
              pipeHandle,
              id: ++this.#sequence,
              method,
              params,
            }),
          agentObservationMethods.has(method),
        );
      },
    };
  }

  async #send(method: string, params: CdpParameters): Promise<unknown> {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: this.#owner.tabs().map(targetInfo) };
      case "Target.getTargetInfo":
        return { targetInfo: targetInfo(this.#tab(params.targetId)) };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Browser.getVersion":
        return { product: "Opensteer/AndroidWebView", protocolVersion: "1.3" };
      case "Target.createTarget": {
        const tab = await this.#owner.create(
          typeof params.url === "string" ? params.url : "about:blank",
        );
        return { targetId: tab.id };
      }
      case "Target.closeTarget":
        await this.#owner.close(this.#tab(params.targetId));
        return { success: true };
      default:
        throw new PhoneBrowserError("unsupported-operation", "Unsupported browser operation.");
    }
  }
}

function targetInfo(tab: PhoneTab): CdpParameters {
  return {
    targetId: tab.id,
    type: "page",
    title: tab.metadata.title,
    url: tab.metadata.url,
    attached: tab.state === "live-covered" || tab.state === "live-visible",
  };
}
