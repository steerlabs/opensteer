import {
  standardCdpMessageMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "./standard-cdp-limits.js";
export {
  standardCdpMessageMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "./standard-cdp-limits.js";
import { contextScopedCdpMethods } from "./cdp-context.js";
import { CdpProductIsolation } from "./cdp-product-isolation.js";
import { boundedJsonSize, type JsonSizeBudget } from "./bounded-json.js";
import { utf8Size } from "./bytes.js";

export interface SessionCdpRouterPorts {
  readonly uuid: () => string;
  readonly isNormalizedAbsolutePath: (path: string) => boolean;
  readonly containsFile: (root: string, path: string) => boolean;
}
import { agentObservationMethods } from "./cdp-activity.js";
export { agentObservationMethods } from "./cdp-activity.js";
import { browserFrameFits, browserFrameLimits } from "./browser-frame-limits.js";

export type CdpParameters = Readonly<Record<string, unknown>>;

export interface CdpCommand {
  readonly method: string;
  readonly replyBudget?: JsonSizeBudget;
  readonly parameters?: CdpParameters;
  readonly sessionId?: string;
}

export interface CdpEvent {
  readonly method: string;
  readonly parameters: CdpParameters;
  readonly sequence: number;
  readonly sessionId?: string;
}

export interface CdpChannel {
  /** Trusted runtime cleanup, including on an agent channel; never an agent command. */
  cancelDragging?(): Promise<unknown>;
  close(): Promise<void>;
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void;
  send(method: string, parameters?: CdpParameters): Promise<unknown>;
}

export interface BrowserCdpBackend {
  readonly protectProductWorlds?: boolean;
  readonly allowsProfileCookieReads?: boolean;
  /**
   * Opens a page channel that behaves as a fresh CDP session: its
   * `Runtime.enable` reports every live execution context before it resolves,
   * whatever other channels on the target have enabled.
   */
  readonly dedicatedContext?: boolean;
  attach(targetId: string, waitForPage?: boolean, signal?: AbortSignal): Promise<CdpChannel>;
  assertScope?(method: string, parameters: CdpParameters): void;
  scopeParameters?(method: string, parameters: CdpParameters): Promise<CdpParameters>;
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void;
  send(method: string, parameters?: CdpParameters): Promise<unknown>;
}

export interface SessionCdpRouterLimits {
  readonly maxCommandBytes: number;
  readonly maxEventBytes: number;
  readonly maxResultBytes: number;
}

export interface StandardCdpAttachmentOptions {
  readonly wholeContext: boolean;
  readonly adoptTarget?: (targetId: string) => Promise<boolean>;
  readonly onOverflow?: () => void;
  readonly captureScreenshot?: (
    targetId: string,
    parameters: CdpParameters,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly answerDialog?: (targetId: string, parameters: CdpParameters) => Promise<unknown>;
}

export interface StandardCdpAttachment {
  readonly signal: AbortSignal;
  send(command: CdpCommand, beforeActivity?: (targetId: string) => void): Promise<unknown>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  attachedTargetId(cdpSessionId: string): string | null;
  close(): void;
}

export class SessionCdpRouterError extends Error {
  readonly code: "bad_command" | "conflict" | "forbidden" | "not_found" | "too_large";

  constructor(code: SessionCdpRouterError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionCdpRouterError";
    this.code = code;
  }
}

interface AttachedChannel {
  readonly channel: CdpChannel;
  /** Rejects once the router ends the session, answering every command still waiting on it. */
  readonly pending: Set<(reason: unknown) => void>;
  readonly ended: AbortController;
  readonly physicalTargetId: string;
  removeListener: () => void;
  pageEnabled: boolean;
  readonly rootAttached?: boolean;
  readonly virtualSessionId: string;
}

interface TargetClaim {
  readonly sessionId: string;
  parentId?: string;
}

interface DiscoveryReplay {
  readonly events: { method: string; parameters: CdpParameters }[];
  bytes: number;
}

interface BrowserSessionState {
  readonly connections: Set<ConnectionState>;
  readonly adopting: Set<string>;
  readonly exclusiveWorkers: Set<string>;
  readonly resolveTarget: (targetId: string) => Promise<boolean>;
  readonly filesRoot: string;
  readonly ownedTargetIds: Set<string>;
  readonly rootTargetId: string;
  readonly sessionId: string;
  ledgerDialogEvents: boolean;
}

interface ConnectionState {
  readonly session: BrowserSessionState;
  readonly standard?: StandardCdpAttachmentOptions;
  readonly contextOperations: Set<Promise<unknown>>;
  readonly closed: AbortController;
  readonly pending: Set<(reason: unknown) => void>;
  pendingBytes: number;
  pendingCount: number;
  autoReady: Promise<void> | undefined;
  readonly channels: Map<string, AttachedChannel>;
  readonly retiredTargets: Map<string, string>;
  autoAttached: Map<string, Promise<{ sessionId: string } | undefined>> | undefined;
  discoverTargets: boolean;
  discoveryReplay: DiscoveryReplay | undefined;
  readonly discoveredTargets: Set<string>;
  readonly eventListeners: Set<(event: CdpEvent) => void>;
  nextSequence: number;
}

const defaultLimits: SessionCdpRouterLimits = {
  maxCommandBytes: 432 * 1_024,
  maxEventBytes: 432 * 1_024,
  maxResultBytes: 432 * 1_024,
};

const browserRootLimit = standardCdpMessageMaxBytes - 4_096;
const maxRetiredTargets = 256;

const standardRootTargets = new Set([
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.getBrowserContexts",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
  "Target.sendMessageToTarget",
]);

const standardPageDomains = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "CSS",
  "Console",
  "Debugger",
  "DOM",
  "DOMDebugger",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "LayerTree",
  "Log",
  "Media",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Runtime",
  "WebAudio",
  "WebAuthn",
]);

const standardPageTargetMethods = new Set([
  "Target.setAutoAttach",
  "Target.sendMessageToTarget",
  "Target.detachFromTarget",
]);

const browserWidePageMethods = new Set([
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.getCertificate",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Network.setAcceptedEncodings",
  "Network.clearAcceptedEncodingsOverride",
  "Page.setDownloadBehavior",
  "Page.deleteCookie",
  "Page.setRPHRegistrationMode",
  "Page.setSPCTransactionMode",
  "Page.crash",
  "Emulation.setLocaleOverride",
  "Emulation.setTimezoneOverride",
  "Emulation.addScreen",
  "Emulation.removeScreen",
  "Emulation.updateScreen",
  "Emulation.setPrimaryScreen",
  "Emulation.getScreenInfos",
]);

function isWorkerShared(type: unknown): boolean {
  return type === "shared_worker" || type === "service_worker";
}

const maximumSessionFilesPerCommand = 64;
const maximumUnclaimedPages = 256;

// Meta subset of Playwright 1.62.1 server/macEditingCommands.ts (without Cocoa colons).
// Kept in sync with the self-contained Browser Harness by the router tests.
const macEditingCommands: Readonly<Record<string, string>> = {
  "4:KeyA": "selectAll",
  "4:KeyC": "copy",
  "4:KeyX": "cut",
  "4:KeyV": "paste",
  "4:KeyZ": "undo",
  "12:KeyZ": "redo",
  "4:Backspace": "deleteToBeginningOfLine",
  "4:ArrowUp": "moveToBeginningOfDocument",
  "4:ArrowDown": "moveToEndOfDocument",
  "4:ArrowLeft": "moveToLeftEndOfLine",
  "4:ArrowRight": "moveToRightEndOfLine",
  "12:Backspace": "deleteToBeginningOfLine",
  "12:ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "12:ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "12:ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "12:ArrowRight": "moveToRightEndOfLineAndModifySelection",
};
const windowsEditingCodes = new Map([
  [8, "Backspace"],
  [37, "ArrowLeft"],
  [38, "ArrowUp"],
  [39, "ArrowRight"],
  [40, "ArrowDown"],
]);

/**
 * A small CDP namespace boundary. It preserves CDP commands and events while
 * replacing physical target/session identifiers with controller-local ones.
 * Target and attachment ownership stay here; page CDP domains are unrestricted.
 */
export class SessionCdpRouter {
  readonly #ports: SessionCdpRouterPorts;
  readonly #backend: BrowserCdpBackend;
  readonly #limits: SessionCdpRouterLimits;
  readonly #browserRootLimits: SessionCdpRouterLimits;
  readonly #ownerByTargetId = new Map<string, TargetClaim>();
  #exclusive: ConnectionState | undefined;
  readonly #removeBackendListener: () => void;
  readonly #sessions = new Map<string, ConnectionState>();
  /**
   * The latest target information of pages no session owns yet. A tab the
   * person opens is claimed only after the browser announced it, so its owner
   * hears `Target.targetCreated` when it claims the page.
   */
  readonly #unclaimedPages = new Map<string, CdpParameters>();
  #closed = false;

  constructor(
    backend: BrowserCdpBackend,
    ports: SessionCdpRouterPorts,
    limits: Partial<SessionCdpRouterLimits> = {},
    _machineClipboardShared = true,
  ) {
    this.#ports = ports;
    this.#backend = backend;
    this.#limits = validateLimits({ ...defaultLimits, ...limits });
    this.#browserRootLimits = {
      maxCommandBytes: browserRootLimit,
      maxEventBytes: browserRootLimit,
      maxResultBytes: browserRootLimit,
      ...limits,
    };
    this.#removeBackendListener = backend.onEvent((method, parameters) => {
      this.#handleBrowserEvent(method, parameters);
    });
  }

  /**
   * `filesRoot` is the only directory whose files this session's page commands
   * may hand to the browser: file inputs and drag data name paths on the
   * Browser Runtime machine, never anywhere else on it.
   */
  registerSession(
    sessionId: string,
    rootTargetId: string,
    resolveTarget: (targetId: string) => Promise<boolean>,
    filesRoot: string,
  ): void {
    this.#assertOpen();
    assertIdentifier(sessionId, "Browser Session ID");
    assertIdentifier(rootTargetId, "CDP target ID");
    if (!this.#ports.isNormalizedAbsolutePath(filesRoot)) {
      throw new TypeError("Browser Session files root must be an absolute normalized path.");
    }
    if (this.#exclusive)
      throw new SessionCdpRouterError(
        "conflict",
        "This browser profile has a whole-context CDP attachment.",
      );
    if (this.#sessions.has(sessionId)) {
      throw new SessionCdpRouterError("conflict", "Browser Session is already registered.");
    }
    if (this.#ownerByTargetId.has(rootTargetId)) {
      throw new SessionCdpRouterError("conflict", "Root target already belongs to a session.");
    }
    const session: BrowserSessionState = {
      resolveTarget,
      connections: new Set(),
      adopting: new Set(),
      exclusiveWorkers: new Set(),
      ledgerDialogEvents: false,
      filesRoot,
      ownedTargetIds: new Set([rootTargetId]),
      rootTargetId,
      sessionId,
    };
    this.#sessions.set(sessionId, this.#openConnection(session));
    this.#ownerByTargetId.set(rootTargetId, { sessionId });
    this.#unclaimedPages.delete(rootTargetId);
  }

  async unregisterSession(sessionId: string): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    this.#sessions.delete(sessionId);
    for (const connection of state.session.connections) this.#closeConnection(connection);
    for (const targetId of state.session.ownedTargetIds) this.#ownerByTargetId.delete(targetId);
  }

  get hasExclusiveContextClient(): boolean {
    return this.#exclusive !== undefined;
  }

  openStandardClient(
    sessionId: string,
    options: StandardCdpAttachmentOptions,
  ): StandardCdpAttachment {
    this.#assertOpen();
    const session = this.#requireSession(sessionId);
    if (
      options.wholeContext &&
      (!this.#backend.dedicatedContext || this.#sessions.size !== 1 || this.#exclusive)
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "Whole-context CDP requires an exclusive saved profile.",
      );
    const state = this.#openConnection(session.session, options);
    if (options.wholeContext) this.#exclusive = state;
    return {
      signal: state.closed.signal,
      send: (command, beforeActivity) => this.#send(state, command, beforeActivity),
      onEvent: (listener) => this.#observe(state, listener),
      attachedTargetId: (id) => this.#attachedTargetId(state, id),
      close: () => this.#closeConnection(state),
    };
  }

  #openConnection(
    session: BrowserSessionState,
    standard?: StandardCdpAttachmentOptions,
  ): ConnectionState {
    const state: ConnectionState = {
      session,
      ...(standard ? { standard } : {}),
      contextOperations: new Set(),
      closed: new AbortController(),
      pending: new Set(),
      pendingBytes: 0,
      pendingCount: 0,
      channels: new Map(),
      retiredTargets: new Map(),
      autoAttached: undefined,
      autoReady: undefined,
      discoverTargets: standard === undefined,
      discoveryReplay: undefined,
      discoveredTargets: new Set(),
      eventListeners: new Set(),
      nextSequence: 1,
    };
    session.connections.add(state);
    return state;
  }

  #closeConnection(state: ConnectionState): void {
    if (state.closed.signal.aborted) return;
    const error = new SessionCdpRouterError("not_found", "CDP connection closed.");
    state.closed.abort(error);
    rejectPending(state.pending, error);
    state.session.connections.delete(state);
    state.autoAttached = undefined;
    state.autoReady = undefined;
    state.discoveryReplay = undefined;
    state.discoveredTargets.clear();
    state.eventListeners.clear();
    state.retiredTargets.clear();
    for (const attached of state.channels.values()) this.#endChannel(state, attached);
    if (this.#exclusive === state) {
      for (const targetId of state.session.exclusiveWorkers) this.#releaseTarget(targetId);
      const release = () => {
        if (this.#exclusive === state) this.#exclusive = undefined;
      };
      if (state.contextOperations.size)
        void Promise.allSettled(state.contextOperations).then(release);
      else release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeBackendListener();
    this.#unclaimedPages.clear();
    await Promise.all(
      [...this.#sessions.keys()].map((sessionId) => this.unregisterSession(sessionId)),
    );
  }

  listOwnedTargets(sessionId: string): readonly string[] {
    return [...this.#requireSession(sessionId).session.ownedTargetIds];
  }

  /**
   * Makes a page the session opened outside agent CDP, such as a tab the
   * person opened, reachable by that session's agents, and its popups with it.
   */
  releaseTarget(sessionId: string, targetId: string): void {
    if (this.#ownerByTargetId.get(targetId)?.sessionId === sessionId) this.#releaseTarget(targetId);
  }

  claimTarget(sessionId: string, targetId: string): void {
    this.#assertOpen();
    assertIdentifier(targetId, "CDP target ID");
    const state = this.#requireSession(sessionId);
    this.#claimTarget(state, targetId);
  }

  /**
   * Uses the ledger's single dialog observation for every attached channel.
   * Separate CDP subscriptions can deliver the same opening at different times;
   * assigning its identity here from another subscription could name a later dialog.
   */
  useDialogEvents(
    sessionId: string,
  ): (
    targetId: string,
    method: "Page.javascriptDialogOpening" | "Page.javascriptDialogClosed",
    parameters: CdpParameters,
  ) => void {
    const state = this.#requireSession(sessionId);
    state.session.ledgerDialogEvents = true;
    return (targetId, method, parameters) => {
      for (const connection of state.session.connections) {
        for (const attached of connection.channels.values()) {
          if (attached.physicalTargetId === targetId && attached.pageEnabled) {
            this.#appendEvent(connection, method, parameters, attached.virtualSessionId);
          }
        }
      }
    };
  }

  /** The page an agent's attached CDP session drives, or null when it is not attached here. */
  attachedTargetId(sessionId: string, cdpSessionId: string): string | null {
    return this.#attachedTargetId(this.#sessions.get(sessionId), cdpSessionId);
  }

  #attachedTargetId(state: ConnectionState | undefined, cdpSessionId: string): string | null {
    let attached = state?.channels.get(cdpSessionId);
    while (attached?.channel instanceof ChildCdpChannel) {
      const parent: CdpChannel = attached.channel.parent;
      attached = [...(state?.channels.values() ?? [])].find(
        (candidate) => candidate.channel === parent,
      );
    }
    return attached?.physicalTargetId ?? state?.retiredTargets.get(cdpSessionId) ?? null;
  }

  /** Retains the actual Input handler for cleanup after an admitted agent press. */
  inputChannel(sessionId: string, command: CdpCommand): CdpChannel {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    return this.#admitAttachedCommand(state, command).channel;
  }

  /**
   * Refuses exactly what `send` would refuse of an agent's command to one of
   * its attached pages, without sending it, for a command the caller applies
   * to that page through a session of its own. The signal aborts when the
   * agent's session ends, as `send` would then answer.
   */
  admitPageCommand(sessionId: string, command: CdpCommand): AbortSignal {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    return this.#admitAttachedCommand(state, command).ended.signal;
  }

  /** Refuses exactly what `send` would refuse of a result the caller produced itself. */
  admitPageResult(result: unknown, budget?: JsonSizeBudget): void {
    this.#assertResultSize(result, this.#limits.maxResultBytes, budget);
  }

  #assertResultSize(result: unknown, maxResultBytes: number, budget?: JsonSizeBudget): void {
    if (boundedJsonSize(result, {
      maxBytes: Math.min(maxResultBytes, budget?.maxBytes ?? maxResultBytes),
      maxDepth: budget?.maxDepth ?? 32,
      maxEntries: budget?.maxEntries ?? 65_536,
    }) === undefined) {
      throw new SessionCdpRouterError(
        "too_large",
        "CDP result exceeds the bounded agent transport. Query a narrower result in the page.",
      );
    }
  }

  /**
   * Refuses exactly what `send` would refuse of an agent's
   * `Target.createTarget`, without sending it, for a tab the caller opens
   * blank and then loads at `url` itself.
   */
  admitCreateTarget(sessionId: string, command: CdpCommand): void {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    assertSafeNavigationUrl(command.parameters?.url, true);
  }

  onEvent(sessionId: string, listener: (event: CdpEvent) => void): () => void {
    return this.#observe(this.#requireSession(sessionId), listener);
  }

  #observe(state: ConnectionState, listener: (event: CdpEvent) => void): () => void {
    state.closed.signal.throwIfAborted();
    state.eventListeners.add(listener);
    return () => state.eventListeners.delete(listener);
  }

  async send(
    sessionId: string,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    return this.#send(this.#requireSession(sessionId), command, beforeActivity);
  }

  async #send(
    state: ConnectionState,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    this.#assertOpen();
    state.closed.signal.throwIfAborted();
    const bytes = validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    if (!state.standard) return this.#dispatch(state, command, beforeActivity);
    if (
      state.pendingBytes + bytes > standardCdpBufferedMaxBytes ||
      state.pendingCount >= standardCdpMaxPending
    )
      throw new SessionCdpRouterError(
        "too_large",
        "CDP connection has too many commands in flight.",
      );
    state.pendingBytes += bytes;
    state.pendingCount++;
    try {
      return await whileOpen(state.pending, () => this.#dispatch(state, command, beforeActivity));
    } finally {
      state.pendingBytes -= bytes;
      state.pendingCount--;
    }
  }

  async #dispatch(
    state: ConnectionState,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    this.#assertScope(state, command.parameters ?? {});
    if (state.standard && command.parameters?.browserContextId !== undefined) {
      const { browserContextId, ...parameters } = command.parameters;
      if (browserContextId !== state.session.sessionId)
        throw new SessionCdpRouterError(
          "forbidden",
          "CDP command requested another browser context.",
        );
      command = { ...command, parameters };
    }
    this.#backend.assertScope?.(command.method, command.parameters ?? {});
    if (
      [
        "Browser.close",
        "Browser.crash",
        "Browser.crashGpuProcess",
        "Target.attachToBrowserTarget",
        "Target.exposeDevToolsProtocol",
        "Browser.setDockTile",
        "Target.createBrowserContext",
        "Target.disposeBrowserContext",
        "Target.setRemoteLocations",
        "Browser.executeBrowserCommand",
      ].includes(command.method)
    )
      throw new SessionCdpRouterError(
        "forbidden",
        `${command.method} would reach the shared browser engine or runtime control channel.`,
      );
    if (state.standard) {
      if (command.sessionId && !state.channels.has(command.sessionId))
        throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
      const pageCookieRead =
        this.#backend.allowsProfileCookieReads &&
        command.sessionId !== undefined &&
        ["Network.getCookies", "Network.getAllCookies", "Storage.getCookies"].includes(
          command.method,
        );
      if (contextScopedCdpMethods.has(command.method) && !pageCookieRead) {
        if (!state.standard.wholeContext)
          throw new SessionCdpRouterError(
            "forbidden",
            `${command.method} requires a whole browser context grant.`,
          );
        if (command.method === "Browser.setDownloadBehavior") {
          if (
            !command.sessionId &&
            command.parameters?.behavior === "allowAndName" &&
            command.parameters.eventsEnabled === true
          )
            return {};
          throw new SessionCdpRouterError(
            "forbidden",
            "Remote CDP cannot configure browser download destinations.",
          );
        }
        if (command.method === "Browser.cancelDownload")
          throw new SessionCdpRouterError(
            "forbidden",
            "Remote CDP does not manage browser downloads.",
          );
        const pending = this.#backend.send(command.method, command.parameters);
        state.contextOperations.add(pending);
        try {
          const result = await pending;
          this.#assertResultSize(result, this.#sessionLimits(state).maxResultBytes, command.replyBudget);
          return result;
        } finally {
          state.contextOperations.delete(pending);
        }
      }
      const domain = command.method.split(".", 1)[0] ?? "";
      if (
        command.sessionId
          ? !pageCookieRead &&
            !standardPageTargetMethods.has(command.method) &&
            (!standardPageDomains.has(domain) || browserWidePageMethods.has(command.method))
          : !standardRootTargets.has(command.method) && command.method !== "Browser.getVersion"
      )
        throw new SessionCdpRouterError(
          "forbidden",
          `${command.method} cannot be scoped to this CDP attachment.`,
        );
    }
    if (this.#backend.scopeParameters && command.sessionId) {
      command = {
        ...command,
        parameters: await this.#backend.scopeParameters(command.method, command.parameters ?? {}),
      };
      state.closed.signal.throwIfAborted();
    }
    const targetRouting = [
      "Target.attachToTarget",
      "Target.getTargets",
      "Target.getTargetInfo",
      "Target.getBrowserContexts",
      "Target.createTarget",
      "Target.closeTarget",
      "Target.activateTarget",
      "Target.setDiscoverTargets",
    ].includes(command.method);
    const result = targetRouting
      ? await this.#sendTargetCommand(state, command)
      : command.sessionId
        ? await this.#sendAttachedCommand(state, command, beforeActivity)
        : command.method.startsWith("Target.")
          ? await this.#sendTargetCommand(state, command)
          : await this.#backend.send(command.method, command.parameters);
    this.#assertResultSize(result, this.#sessionLimits(state).maxResultBytes, command.replyBudget);
    return result;
  }

  async #sendTargetCommand(state: ConnectionState, command: CdpCommand): Promise<unknown> {
    const parameters = command.parameters ?? {};
    switch (command.method) {
      case "Target.getTargets": {
        const response = await this.#ownedTargetInfos(state, parameters);
        if (state.standard) return { targetInfos: response.targetInfos };
        const root = state.session.rootTargetId;
        const current = this.#ownerByTargetId.get(root);
        const rootTargetId =
          current && current.sessionId !== state.session.sessionId
            ? state.session.ownedTargetIds.values().next().value
            : root;
        return { ...response, rootTargetId };
      }
      case "Target.sendMessageToTarget": {
        const virtualSessionId = requiredString(parameters, "sessionId");
        const attached = state.channels.get(virtualSessionId);
        if (!attached)
          throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
        let nested: Record<string, unknown>;
        try {
          nested = asRecord(JSON.parse(String(parameters.message)));
        } catch {
          throw new SessionCdpRouterError("bad_command", "Invalid nested CDP message.");
        }
        const result = await this.#send(state, {
          method: requiredString(nested, "method"),
          parameters: asRecord(nested.params),
          sessionId: virtualSessionId,
        });
        this.#appendEvent(state, "Target.receivedMessageFromTarget", {
          sessionId: virtualSessionId,
          message: JSON.stringify({ id: nested.id, result }),
        });
        return {};
      }
      case "Target.getBrowserContexts":
        if (state.standard) return { browserContextIds: [] };
        return this.#backend.send(command.method, parameters);
      case "Target.getTargetInfo": {
        if (state.standard && !command.sessionId && parameters.targetId === undefined) {
          return {
            targetInfo: {
              targetId: `browser_${state.session.sessionId}`,
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          };
        }
        const targetId = requiredTargetId(parameters);
        const claim = this.#assertOwnedTarget(state, targetId);
        return this.#readTargetInfo(state, targetId, claim, parameters);
      }
      case "Target.createTarget": {
        assertSafeNavigationUrl(parameters.url, true);
        const response = asRecord(await this.#backend.send(command.method, parameters));
        const targetId = readString(response, "targetId");
        if (!targetId) {
          throw new SessionCdpRouterError("bad_command", "Browser did not return a target ID.");
        }
        // A session that ended while the tab opened has already closed its
        // pages; this one would outlive it in a profile other sessions share.
        if (!this.#sessions.has(state.session.sessionId) || state.closed.signal.aborted) {
          if (!this.#ownerByTargetId.has(targetId))
            await this.#backend.send("Target.closeTarget", { targetId }).catch(() => undefined);
          throw new SessionCdpRouterError("not_found", "Browser Session is not registered.");
        }
        const claim = this.#claimTarget(state, targetId, undefined, !state.standard);
        if (state.standard) {
          state.session.adopting.add(targetId);
          let adopted = false;
          try {
            try {
              adopted = !state.standard.adoptTarget || (await state.standard.adoptTarget(targetId));
            } finally {
              state.session.adopting.delete(targetId);
            }
            if (!adopted)
              throw new SessionCdpRouterError(
                "not_found",
                "The new browser page could not be adopted.",
              );
            this.#assertCurrentClaim(state, targetId, claim);
            for (const connection of state.session.connections)
              if (connection !== state)
                void this.#autoAttachTarget(connection, targetId)?.catch(() => undefined);
            const attaching = this.#autoAttachTarget(state, targetId);
            if (attaching && !(await attaching))
              throw new SessionCdpRouterError(
                "not_found",
                "The new browser page could not be attached.",
              );
          } catch (error) {
            if (this.#ownerByTargetId.get(targetId) === claim) {
              await this.#closeTarget(targetId, claim, {}).catch(() => undefined);
              // If Chromium refuses rollback, an adopted page remains discoverable.
              if (
                adopted &&
                this.#ownerByTargetId.get(targetId) === claim &&
                !state.closed.signal.aborted
              )
                return response;
            }
            throw error;
          }
        }
        return response;
      }
      case "Target.attachToTarget": {
        const targetId = requiredTargetId(parameters);
        const existing = [...state.channels.values()].find(
          (channel) =>
            channel.physicalTargetId === targetId && channel.channel instanceof ChildCdpChannel,
        );
        if (existing) return { sessionId: existing.virtualSessionId };
        if (state.standard && state.autoAttached) {
          const attached = await this.#autoAttachTarget(state, targetId);
          if (attached) return attached;
          throw new SessionCdpRouterError("not_found", "The browser page is no longer attachable.");
        }
        if (state.standard) {
          const claim = this.#assertOwnedTarget(state, targetId);
          const { targetInfo } = await this.#readTargetInfo(state, targetId, claim);
          this.#assertCurrentClaim(state, targetId, claim);
          if (targetInfo.type !== "page")
            throw new SessionCdpRouterError(
              "forbidden",
              "Use its parent page to attach a child target.",
            );
          return this.#attachTarget(state, targetId, targetInfo);
        }
        return this.#attachTarget(state, targetId);
      }
      case "Target.detachFromTarget": {
        const virtualSessionId = requiredString(parameters, "sessionId");
        const attached = state.channels.get(virtualSessionId);
        if (!attached) {
          if (state.retiredTargets.delete(virtualSessionId)) return {};
          throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
        }
        this.#endChannel(state, attached);
        return {};
      }
      case "Target.setAutoAttach": {
        if (!state.standard) break;
        if (
          typeof parameters.autoAttach !== "boolean" ||
          (parameters.autoAttach && parameters.flatten !== true)
        ) {
          throw new SessionCdpRouterError("bad_command", "Browser auto-attach requires flat mode.");
        }
        if (parameters.autoAttach) {
          if (!state.autoAttached) {
            state.autoAttached = new Map();
            let ready = Promise.resolve();
            for (const targetId of state.session.ownedTargetIds) {
              ready =
                this.#autoAttachTarget(state, targetId, ready)?.then(() => undefined) ?? ready;
            }
            state.autoReady = ready;
          }
          await state.autoReady;
        } else {
          state.autoAttached = undefined;
          state.autoReady = undefined;
          for (const attached of state.channels.values()) {
            if (attached.rootAttached) this.#endChannel(state, attached);
          }
        }
        return {};
      }
      case "Target.setDiscoverTargets": {
        const discover = parameters.discover;
        if (typeof discover !== "boolean") {
          throw new SessionCdpRouterError("bad_command", "Target discovery requires a boolean.");
        }
        if (state.discoverTargets === discover) return {};
        state.discoverTargets = discover;
        state.discoveredTargets.clear();
        if (!state.standard) return {};
        const replay: DiscoveryReplay | undefined = discover ? { events: [], bytes: 0 } : undefined;
        state.discoveryReplay = replay;
        if (!replay) return {};
        try {
          const { targetInfos } = await this.#ownedTargetInfos(state, {
            filter: parameters.filter,
          });
          if (state.discoveryReplay !== replay) return {};
          for (const targetInfo of targetInfos) {
            this.#publishDiscovery(state, "Target.targetCreated", { targetInfo });
          }
          for (const event of replay.events) {
            this.#publishDiscovery(state, event.method, event.parameters);
          }
        } finally {
          if (state.discoveryReplay === replay) state.discoveryReplay = undefined;
        }
        return {};
      }
      case "Target.activateTarget":
        return this.#activateTarget(state, requiredTargetId(parameters));
      case "Target.closeTarget": {
        const targetId = requiredTargetId(parameters);
        const claim = this.#assertOwnedTarget(state, targetId);
        return this.#closeTarget(targetId, claim, parameters);
      }
      default:
        if (!state.standard && typeof parameters.targetId === "string")
          return this.#backend.send(command.method, parameters);
    }
    throw new SessionCdpRouterError(
      "forbidden",
      `${command.method} cannot be safely scoped to one Browser Session.`,
    );
  }

  async #closeTarget(targetId: string, claim: TargetClaim, parameters: CdpParameters) {
    const result = await this.#backend.send("Target.closeTarget", { ...parameters, targetId });
    if (this.#ownerByTargetId.get(targetId) === claim) {
      if (asRecord(result).success !== false) this.#releaseTarget(targetId);
    } else if (this.#ownerByTargetId.has(targetId))
      throw new SessionCdpRouterError("not_found", "The target claim changed while closing.");
    return result;
  }

  async #ownedTargetInfos(state: ConnectionState, parameters?: CdpParameters) {
    const claims = new Map(
      [...state.session.ownedTargetIds].map((id) => [id, this.#ownerByTargetId.get(id)]),
    );
    const response = asRecord(await this.#backend.send("Target.getTargets", parameters));
    state.closed.signal.throwIfAborted();
    const entries: unknown[] = Array.isArray(response.targetInfos) ? response.targetInfos : [];
    const targetInfos = entries.flatMap((entry) => {
      const target = asRecord(entry);
      const id = readString(target, "targetId");
      if (!id || !claims.has(id) || claims.get(id) !== this.#ownerByTargetId.get(id)) return [];
      const info = this.#projectTargetInfo(state, target);
      return info ? [info] : [];
    });
    return { ...response, targetInfos };
  }

  async #readTargetInfo(
    state: ConnectionState,
    targetId: string,
    claim: TargetClaim,
    parameters?: CdpParameters,
  ) {
    const response = asRecord(
      await this.#backend.send("Target.getTargetInfo", { ...parameters, targetId }),
    );
    this.#assertCurrentClaim(state, targetId, claim);
    if (response.targetInfo === undefined && !state.standard)
      return { ...response, targetInfo: asRecord(response.targetInfo) };
    const targetInfo =
      readString(asRecord(response.targetInfo), "targetId") === targetId
        ? this.#projectTargetInfo(state, asRecord(response.targetInfo))
        : undefined;
    if (!targetInfo)
      throw new SessionCdpRouterError("not_found", "The target is no longer available.");
    return { ...response, targetInfo };
  }

  #projectTargetInfo(state: ConnectionState, info: CdpParameters): CdpParameters | undefined {
    const targetId = readString(info, "targetId");
    if (!targetId || this.#ownerByTargetId.get(targetId)?.sessionId !== state.session.sessionId)
      return;
    const projected: Record<string, unknown> = {
      ...info,
      ...(state.standard ? { browserContextId: state.session.sessionId } : {}),
    };
    for (const key of ["openerId", "parentId"]) {
      const relatedId = readString(info, key);
      if (
        relatedId &&
        this.#ownerByTargetId.get(relatedId)?.sessionId !== state.session.sessionId
      ) {
        delete projected[key];
        if (key === "openerId") {
          delete projected.openerFrameId;
          projected.canAccessOpener = false;
        } else {
          delete projected.parentFrameId;
        }
      }
    }
    if (projected.openerId === undefined) delete projected.openerFrameId;
    const parentFrameId = readString(projected, "parentFrameId");
    if (parentFrameId) {
      const frameClaim = this.#ownerByTargetId.get(parentFrameId);
      if (frameClaim && frameClaim.sessionId !== state.session.sessionId)
        delete projected.parentFrameId;
    }
    return projected;
  }

  #autoAttachTarget(
    state: ConnectionState,
    targetId: string,
    initialAfter?: Promise<void>,
  ): Promise<{ sessionId: string } | undefined> | undefined {
    const pending = state.autoAttached;
    if (!pending || state.session.adopting.has(targetId)) return;
    const claim = this.#ownerByTargetId.get(targetId);
    if (!claim || claim.sessionId !== state.session.sessionId) return;
    const existing = pending.get(targetId);
    if (existing) return existing;
    const explicit = [...state.channels.values()].find(
      (channel) => channel.rootAttached && channel.physicalTargetId === targetId,
    );
    if (explicit) {
      const reply = Promise.resolve({ sessionId: explicit.virtualSessionId });
      pending.set(targetId, reply);
      return reply;
    }
    const ready = initialAfter ?? state.autoReady;
    const current = () =>
      state.autoAttached === pending &&
      pending.get(targetId) === attaching &&
      !state.closed.signal.aborted &&
      this.#ownerByTargetId.get(targetId) === claim;
    const attaching: Promise<{ sessionId: string } | undefined> = Promise.resolve().then(
      async () => {
        if (!current()) return;
        try {
          await ready;
          if (!current()) return;
          const { targetInfo } = await this.#readTargetInfo(state, targetId, claim);
          if (!current() || targetInfo.type !== "page") return;
          return await this.#attachTarget(state, targetId, targetInfo, current);
        } catch (error) {
          if (!current()) return;
          pending.delete(targetId);
          throw error;
        }
      },
    );
    pending.set(targetId, attaching);
    return attaching;
  }

  /** Each attachment owns its page channel and all child channels opened through it. */
  async #attachTarget(
    state: ConnectionState,
    targetId: string,
    rootInfo?: CdpParameters,
    current?: () => boolean,
  ): Promise<{ sessionId: string }> {
    const claim = this.#assertOwnedTarget(state, targetId);
    const channel = await this.#backend.attach(
      targetId,
      Boolean(state.standard),
      state.standard ? state.closed.signal : undefined,
    );
    try {
      this.#assertCurrentClaim(state, targetId, claim);
      if (current && !current())
        throw new SessionCdpRouterError("not_found", "Browser auto-attach ended.");
    } catch (error) {
      void channel.close().catch(() => undefined);
      throw error;
    }
    const attached: AttachedChannel = {
      channel,
      pending: new Set(),
      ended: new AbortController(),
      physicalTargetId: targetId,
      rootAttached: rootInfo !== undefined,
      removeListener: () => undefined,
      pageEnabled: false,
      virtualSessionId: `cdp_${this.#ports.uuid()}`,
    };
    attached.removeListener = channel.onEvent((method, parameters) => {
      this.#handlePageEvent(state, attached, method, parameters);
    });
    state.channels.set(attached.virtualSessionId, attached);
    if (rootInfo) {
      this.#appendEvent(state, "Target.attachedToTarget", {
        sessionId: attached.virtualSessionId,
        targetInfo: {
          ...rootInfo,
          targetId,
          attached: true,
          browserContextId: readString(rootInfo, "browserContextId") ?? state.session.sessionId,
        },
        waitingForDebugger: false,
      });
    }
    return { sessionId: attached.virtualSessionId };
  }

  #handlePageEvent(
    state: ConnectionState,
    attached: AttachedChannel,
    method: string,
    parameters: CdpParameters,
  ): void {
    if (
      state.session.ledgerDialogEvents &&
      (method === "Page.javascriptDialogOpening" || method === "Page.javascriptDialogClosed")
    )
      return;
    if (!state.channels.has(attached.virtualSessionId)) return;
    if (method === "Target.attachedToTarget") {
      const info = asRecord(parameters.targetInfo);
      const targetId = readString(info, "targetId");
      const physicalSessionId = readString(parameters, "sessionId");
      if (
        !targetId ||
        !physicalSessionId ||
        !["iframe", "worker", "shared_worker", "service_worker"].includes(String(info.type))
      )
        return;
      const owner = this.#ownerByTargetId.get(targetId);
      if (
        (owner && owner.sessionId !== state.session.sessionId) ||
        (isWorkerShared(info.type) &&
          this.#exclusive?.session.sessionId !== state.session.sessionId)
      ) {
        void attached.channel
          .send("Target.detachFromTarget", { sessionId: physicalSessionId })
          .catch(() => undefined);
        return;
      }
      if (isWorkerShared(info.type)) state.session.exclusiveWorkers.add(targetId);
      this.#claimTarget(state, targetId, attached.physicalTargetId, false);
      const channel = new ChildCdpChannel(
        attached.channel,
        physicalSessionId,
        this.#backend.protectProductWorlds === true,
      );
      const child: AttachedChannel = {
        channel,
        pending: new Set(),
        ended: new AbortController(),
        physicalTargetId: targetId,
        virtualSessionId: `cdp_${this.#ports.uuid()}`,
        pageEnabled: false,
        removeListener: () => undefined,
      };
      child.removeListener = channel.onEvent((method, params) =>
        this.#handlePageEvent(state, child, method, params),
      );
      state.channels.set(child.virtualSessionId, child);
      this.#appendEvent(
        state,
        method,
        { ...parameters, sessionId: child.virtualSessionId },
        attached.virtualSessionId,
      );
      return;
    }
    if (method === "Target.receivedMessageFromTarget") return;
    if (method === "Target.detachedFromTarget") {
      const child = [...state.channels.values()].find(
        (candidate) =>
          candidate.channel instanceof ChildCdpChannel &&
          candidate.channel.parent === attached.channel &&
          candidate.channel.id === parameters.sessionId,
      );
      if (!child) return;
      this.#appendEvent(
        state,
        method,
        { ...parameters, sessionId: child.virtualSessionId },
        attached.virtualSessionId,
      );
      this.#endChannel(state, child);
      return;
    }
    this.#appendEvent(state, method, parameters, attached.virtualSessionId);
  }

  #admitAttachedCommand(state: ConnectionState, command: CdpCommand): AttachedChannel {
    const attached = state.channels.get(command.sessionId ?? "");
    if (!attached) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
    }
    const parameters = command.parameters ?? {};
    if (command.method === "Page.navigate") {
      assertSafeNavigationUrl(parameters.url, false);
    }
    if (command.method === "DOM.setFileInputFiles") {
      assertSessionFiles(parameters.files, state.session.filesRoot, command.method, this.#ports);
    }
    if (command.method === "Input.dispatchDragEvent") {
      const data = parameters.data;
      if (data !== undefined) {
        assertSessionFiles(
          asRecord(data).files ?? [],
          state.session.filesRoot,
          command.method,
          this.#ports,
        );
      }
    }
    assertBoundedRenderingCommand(command.method, parameters);
    if (state.standard && command.method === "Page.captureScreenshot") {
      if (parameters.fromSurface !== undefined && parameters.fromSurface !== true)
        throw new SessionCdpRouterError(
          "bad_command",
          "A screenshot must come from the page surface.",
        );
      if (parameters.captureBeyondViewport === true && parameters.clip === undefined)
        throw new SessionCdpRouterError(
          "bad_command",
          "Full-page capture requires a bounded screenshot clip.",
        );
      if (parameters.clip !== undefined) {
        const { x, y, width, height, scale } = asRecord(parameters.clip);
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          typeof width !== "number" ||
          typeof height !== "number" ||
          typeof scale !== "number" ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          !Number.isFinite(scale) ||
          width <= 0 ||
          height <= 0 ||
          scale <= 0 ||
          scale > browserFrameLimits.maxDevicePixelRatio ||
          width * height * scale ** 2 > browserFrameLimits.maxPhysicalPixels
        )
          throw new SessionCdpRouterError(
            "bad_command",
            "CDP screenshot clip exceeds the raster limit.",
          );
      }
    }
    return attached;
  }

  async #sendAttachedCommand(
    state: ConnectionState,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    const attached = this.#admitAttachedCommand(state, command);
    if (command.method === "Page.bringToFront") {
      return this.#activateTarget(state, attached.physicalTargetId);
    }
    if (command.method === "Page.enable") attached.pageEnabled = true;
    if (command.method === "Page.disable") attached.pageEnabled = false;
    let parameters = command.parameters;
    if (command.method === "Target.setAutoAttach") parameters = { ...parameters, flatten: false };
    if (
      command.method === "Target.sendMessageToTarget" ||
      command.method === "Target.detachFromTarget"
    ) {
      const child = state.channels.get(String(parameters?.sessionId));
      if (!(child?.channel instanceof ChildCdpChannel) || child.channel.parent !== attached.channel)
        throw new SessionCdpRouterError("forbidden", "CDP attachment is outside this page.");
      if (command.method === "Target.sendMessageToTarget") {
        let nested: unknown;
        try {
          nested = JSON.parse(String(parameters?.message));
        } catch {
          throw new SessionCdpRouterError("bad_command", "Invalid nested CDP message.");
        }
        const message = asRecord(nested);
        const result = await this.#send(
          state,
          {
            method: requiredString(message, "method"),
            parameters: asRecord(message.params),
            sessionId: child.virtualSessionId,
          },
          beforeActivity,
        );
        this.#appendEvent(
          state,
          "Target.receivedMessageFromTarget",
          {
            sessionId: child.virtualSessionId,
            message: JSON.stringify({ id: message.id, result }),
          },
          attached.virtualSessionId,
        );
        return {};
      }
      this.#endChannel(state, child);
      return {};
    }

    if (command.method === "Input.dispatchKeyEvent") {
      // Like viewer input.key, agent keys belong to the page. Native OS codes
      // opt macOS into browser shortcut routing and synchronous cursor IPC.
      const pageKeys = { ...parameters };
      delete pageKeys.nativeVirtualKeyCode;
      if (
        pageKeys.commands === undefined &&
        (pageKeys.type === "keyDown" || pageKeys.type === "rawKeyDown")
      ) {
        const modifiers = typeof pageKeys.modifiers === "number" ? pageKeys.modifiers & 15 : 0;
        const windowsCode = pageKeys.windowsVirtualKeyCode;
        const fallback =
          typeof windowsCode === "number"
            ? (windowsEditingCodes.get(windowsCode) ??
              (windowsCode >= 65 && windowsCode <= 90 ? String.fromCharCode(windowsCode) : ""))
            : "";
        for (const candidate of [pageKeys.code, pageKeys.key, fallback]) {
          if (typeof candidate !== "string") continue;
          const code = /^[a-z]$/iu.test(candidate) ? `Key${candidate.toUpperCase()}` : candidate;
          const editing = macEditingCommands[`${modifiers}:${code}`];
          if (editing) {
            pageKeys.commands = [editing];
            break;
          }
        }
      }
      // Inference must not turn a previously unrecognized chord into a paste.
      this.#admitAttachedCommand(state, { ...command, parameters: pageKeys });
      parameters = pageKeys;
    }
    // Admission includes inferred editing commands: a refused command must not
    // attribute a later passkey ceremony to this agent. Script, navigation and
    // DOM changes can start one as surely as input can.
    if (!agentObservationMethods.has(command.method)) beforeActivity?.(attached.physicalTargetId);
    const captureScreenshot = state.standard?.captureScreenshot;
    const answerDialog = state.standard?.answerDialog;
    const send = () => {
      if (captureScreenshot && command.method === "Page.captureScreenshot")
        return captureScreenshot(
          attached.physicalTargetId,
          parameters ?? {},
          attached.ended.signal,
        );
      if (answerDialog && command.method === "Page.handleJavaScriptDialog")
        return answerDialog(attached.physicalTargetId, parameters ?? {});
      return attached.channel.send(
        command.method,
        agentObjectGroups(parameters, attached.virtualSessionId),
      );
    };
    return command.replyBudget ? send() : whileOpen(attached.pending, send);
  }

  // An agent's target selection cannot change a viewer's tab or native focus.
  // CDP activation only verifies that its explicitly named surface still exists.
  async #activateTarget(state: ConnectionState, targetId: string): Promise<Record<string, never>> {
    const claim = this.#assertOwnedTarget(state, targetId);
    if (!(await state.session.resolveTarget(targetId))) {
      throw new SessionCdpRouterError("not_found", "The browser surface does not exist.");
    }
    this.#assertCurrentClaim(state, targetId, claim);
    return {};
  }

  #handleBrowserEvent(method: string, parameters: CdpParameters): void {
    if (this.#closed) return;
    if (!method.startsWith("Target.")) {
      const targetId = readString(parameters, "targetId") ?? readString(parameters, "frameId");
      const owner = targetId
        ? this.#sessions.get(this.#ownerByTargetId.get(targetId)?.sessionId ?? "")
        : undefined;
      if (owner)
        for (const state of owner.session.connections) this.#appendEvent(state, method, parameters);
      return;
    }
    if (
      method !== "Target.targetCreated" &&
      method !== "Target.targetInfoChanged" &&
      method !== "Target.targetDestroyed" &&
      method !== "Target.targetCrashed"
    )
      return;
    const info = asRecord(parameters.targetInfo);
    const targetId = readString(info, "targetId") ?? readString(parameters, "targetId");
    if (!targetId) return;

    if (method === "Target.targetCreated") {
      const parentId = readString(info, "openerId") ?? readString(info, "parentId");
      const owner = parentId
        ? this.#sessions.get(this.#ownerByTargetId.get(parentId)?.sessionId ?? "")
        : undefined;
      if (
        owner &&
        parentId &&
        !this.#ownerByTargetId.has(targetId) &&
        (["page", "iframe", "worker"].includes(String(info.type)) ||
          (this.#exclusive?.session.sessionId === owner.session.sessionId &&
            isWorkerShared(info.type)))
      ) {
        if (isWorkerShared(info.type)) owner.session.exclusiveWorkers.add(targetId);
        this.#claimTarget(owner, targetId, parentId, info.type === "page");
      }
    }

    const owner = this.#sessions.get(this.#ownerByTargetId.get(targetId)?.sessionId ?? "");
    if (owner)
      for (const state of owner.session.connections) this.#discover(state, method, parameters);
    else this.#trackUnclaimedPage(method, targetId, parameters);
    if (method === "Target.targetDestroyed") this.#releaseTarget(targetId);
  }

  #discover(state: ConnectionState, method: string, parameters: CdpParameters): void {
    if (!state.discoverTargets) return;
    const replay = state.discoveryReplay;
    if (replay) {
      replay.bytes += serializedBytes({ method, parameters });
      if (
        replay.bytes > standardCdpBufferedMaxBytes ||
        replay.events.length >= standardCdpMaxPending
      ) {
        state.standard?.onOverflow?.();
        this.#closeConnection(state);
      } else {
        replay.events.push({ method, parameters });
      }
    } else {
      this.#publishDiscovery(state, method, parameters);
    }
  }

  #publishDiscovery(state: ConnectionState, method: string, parameters: CdpParameters): void {
    if (state.standard) {
      const targetId =
        readString(asRecord(parameters.targetInfo), "targetId") ??
        readString(parameters, "targetId");
      if (!targetId) return;
      const seen = state.discoveredTargets;
      if (method === "Target.targetCreated") {
        if (
          seen.has(targetId) ||
          this.#ownerByTargetId.get(targetId)?.sessionId !== state.session.sessionId
        )
          return;
        seen.add(targetId);
      } else {
        if (!seen.has(targetId)) return;
        if (method === "Target.targetDestroyed") seen.delete(targetId);
      }
    }
    this.#appendEvent(state, method, parameters);
  }

  #trackUnclaimedPage(method: string, targetId: string, parameters: CdpParameters): void {
    const targetInfo = asRecord(parameters.targetInfo);
    const tracked =
      (method === "Target.targetCreated" && targetInfo.type === "page") ||
      (method === "Target.targetInfoChanged" && this.#unclaimedPages.has(targetId));
    this.#unclaimedPages.delete(targetId);
    if (!tracked) return;
    this.#unclaimedPages.set(targetId, targetInfo);
    for (const oldest of this.#unclaimedPages.keys()) {
      if (this.#unclaimedPages.size <= maximumUnclaimedPages) break;
      this.#unclaimedPages.delete(oldest);
    }
  }

  #claimTarget(
    state: ConnectionState,
    targetId: string,
    parentId?: string,
    attachPage = true,
  ): TargetClaim {
    const existing = this.#ownerByTargetId.get(targetId);
    if (existing && existing.sessionId !== state.session.sessionId)
      throw new SessionCdpRouterError("conflict", "CDP target belongs to another session.");
    const claim = existing ?? {
      sessionId: state.session.sessionId,
      ...(parentId ? { parentId } : {}),
    };
    if (!parentId) delete claim.parentId;
    this.#ownerByTargetId.set(targetId, claim);
    state.session.ownedTargetIds.add(targetId);
    const announced = this.#unclaimedPages.get(targetId);
    this.#unclaimedPages.delete(targetId);
    for (const connection of state.session.connections) {
      if (announced) this.#discover(connection, "Target.targetCreated", { targetInfo: announced });
      if (attachPage) void this.#autoAttachTarget(connection, targetId)?.catch(() => undefined);
    }
    return claim;
  }

  #releaseTarget(targetId: string): void {
    const claim = this.#ownerByTargetId.get(targetId);
    if (!claim) return;
    this.#ownerByTargetId.delete(targetId);
    const state = this.#sessions.get(claim.sessionId);
    state?.session.ownedTargetIds.delete(targetId);
    if (!state) return;
    state.session.exclusiveWorkers.delete(targetId);
    for (const connection of state.session.connections) {
      if (connection.standard && connection.discoveredTargets.has(targetId))
        this.#discover(connection, "Target.targetDestroyed", { targetId });
      connection.autoAttached?.delete(targetId);
      for (const attached of connection.channels.values()) {
        if (attached.physicalTargetId === targetId) {
          const retired = connection.retiredTargets;
          retired.set(attached.virtualSessionId, targetId);
          if (retired.size > maxRetiredTargets) {
            const oldest = retired.keys().next().value;
            if (oldest !== undefined) retired.delete(oldest);
          }
          this.#endChannel(connection, attached);
        }
      }
    }
    for (const childId of state.session.ownedTargetIds)
      if (this.#ownerByTargetId.get(childId)?.parentId === targetId) this.#releaseTarget(childId);
  }

  /**
   * Ends one agent page session here at once. Its channel finishes closing on
   * its own: a backend can need the page to answer first, and a page under a
   * JavaScript dialog answers nothing until the dialog closes.
   */
  #endChannel(state: ConnectionState, attached: AttachedChannel): void {
    if (state.channels.get(attached.virtualSessionId) !== attached) return;
    state.channels.delete(attached.virtualSessionId);
    if (attached.rootAttached || !state.standard) {
      state.autoAttached?.delete(attached.physicalTargetId);
      this.#appendEvent(state, "Target.detachedFromTarget", {
        sessionId: attached.virtualSessionId,
        targetId: attached.physicalTargetId,
      });
    }
    for (const child of state.channels.values()) {
      if (child.channel instanceof ChildCdpChannel && child.channel.parent === attached.channel)
        this.#endChannel(state, child);
    }
    attached.removeListener();
    const ended = new SessionCdpRouterError(
      "not_found",
      "The CDP session ended before the page answered.",
    );
    rejectPending(attached.pending, ended);
    attached.ended.abort(ended);
    void attached.channel.close().catch(() => undefined);
  }

  #appendEvent(
    state: ConnectionState,
    method: string,
    parameters: CdpParameters,
    sessionId?: string,
  ): void {
    if (method.startsWith("Target.") && parameters.targetInfo !== undefined) {
      const info = this.#projectTargetInfo(state, asRecord(parameters.targetInfo));
      if (!info) return;
      parameters = { ...parameters, targetInfo: info };
    }
    const event: CdpEvent = {
      method,
      parameters,
      sequence: state.nextSequence++,
      ...(sessionId ? { sessionId } : {}),
    };
    if (boundedJsonSize(event, {
      maxBytes: this.#sessionLimits(state).maxEventBytes,
      maxDepth: 28,
      maxEntries: 16_384,
    }) === undefined) {
      if (state.standard) {
        state.standard.onOverflow?.();
        this.#closeConnection(state);
      }
      return;
    }
    for (const listener of state.eventListeners) {
      try {
        listener(event);
      } catch {
        // A downstream listener is an observation boundary. It cannot break
        // target ownership or the browser backend's event pump.
      }
    }
  }

  #assertScope(state: ConnectionState, parameters: CdpParameters): void {
    for (const key of ["targetId", "openerId"]) {
      const target = parameters[key];
      if (typeof target === "string") this.#assertOwnedTarget(state, target);
    }
    // Browser contexts are checked and supplied by the profile-owned backend.
    if (
      parameters.sessionId !== undefined &&
      !state.channels.has(String(parameters.sessionId)) &&
      !state.retiredTargets.has(String(parameters.sessionId))
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "CDP attachment is outside this Browser Session.",
      );
  }

  #assertOwnedTarget(state: ConnectionState, targetId: string): TargetClaim {
    const claim = this.#ownerByTargetId.get(targetId);
    if (claim?.sessionId !== state.session.sessionId)
      throw new SessionCdpRouterError("forbidden", "CDP target is outside this Browser Session.");
    return claim;
  }

  #assertCurrentClaim(state: ConnectionState, targetId: string, claim: TargetClaim): void {
    state.closed.signal.throwIfAborted();
    if (this.#ownerByTargetId.get(targetId) !== claim)
      throw new SessionCdpRouterError("not_found", "The target claim changed during the command.");
  }

  #sessionLimits(state: ConnectionState): SessionCdpRouterLimits {
    return state.standard ? this.#browserRootLimits : this.#limits;
  }

  #requireSession(sessionId: string): ConnectionState {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new SessionCdpRouterError("not_found", "Browser Session is not registered.");
    return state;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionCdpRouterError("conflict", "CDP router is closed.");
  }
}

async function whileOpen<T>(
  pending: Set<(reason: unknown) => void>,
  operation: () => Promise<T>,
): Promise<T> {
  const ended = Promise.withResolvers<never>();
  pending.add(ended.reject);
  try {
    return await Promise.race([ended.promise, operation()]);
  } finally {
    pending.delete(ended.reject);
  }
}

function rejectPending(pending: Set<(reason: unknown) => void>, error: Error): void {
  for (const reject of pending) reject(error);
  pending.clear();
}

function validateCommand(command: CdpCommand, maxBytes: number): number {
  if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(command.method)) {
    throw new SessionCdpRouterError("bad_command", "CDP method is invalid.");
  }
  if (command.sessionId !== undefined) assertIdentifier(command.sessionId, "CDP session ID");
  if (command.parameters !== undefined && !isPlainObject(command.parameters)) {
    throw new SessionCdpRouterError("bad_command", "CDP parameters must be an object.");
  }
  const bytes = serializedBytes(command);
  if (bytes > maxBytes) {
    throw new SessionCdpRouterError("too_large", "CDP command exceeds its byte limit.");
  }
  return bytes;
}

function validateLimits(limits: SessionCdpRouterLimits): SessionCdpRouterLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function requiredTargetId(parameters: CdpParameters): string {
  return requiredString(parameters, "targetId");
}

function requiredString(parameters: CdpParameters, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new SessionCdpRouterError("bad_command", `${key} is invalid.`);
  }
  return value;
}

function assertSafeNavigationUrl(value: unknown, allowOmitted: boolean): void {
  if (value === undefined && allowOmitted) return;
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) {
    throw new SessionCdpRouterError("bad_command", "CDP navigation URL is invalid.");
  }
  if (value === "about:blank") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SessionCdpRouterError("bad_command", "CDP navigation URL is invalid.", {
      cause: error,
    });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SessionCdpRouterError(
      "forbidden",
      "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
    );
  }
}

function assertSessionFiles(
  value: unknown,
  filesRoot: string,
  method: string,
  ports: SessionCdpRouterPorts,
): void {
  if (!Array.isArray(value) || value.length > maximumSessionFilesPerCommand) {
    throw new SessionCdpRouterError("bad_command", `${method} files are invalid.`);
  }
  for (const file of value) {
    if (
      typeof file !== "string" ||
      file.includes("\0") ||
      !ports.isNormalizedAbsolutePath(file) ||
      !ports.containsFile(filesRoot, file)
    ) {
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} accepts only files staged for this Browser Session. Use Browser Harness setInputFiles, or pass the paths stageFiles returns.`,
      );
    }
  }
}

function assertBoundedRenderingCommand(method: string, parameters: CdpParameters): void {
  if (method === "Emulation.setDeviceMetricsOverride") {
    const width = parameters.width;
    const height = parameters.height;
    const devicePixelRatio = parameters.deviceScaleFactor;
    if (
      typeof width === "number" &&
      typeof height === "number" &&
      width > 0 &&
      height > 0 &&
      typeof devicePixelRatio === "number" &&
      devicePixelRatio > 0 &&
      !browserFrameFits(width, height, devicePixelRatio)
    ) {
      throw new SessionCdpRouterError(
        "bad_command",
        "CDP device metrics exceed the bounded browser frame size.",
      );
    }
    return;
  }
  if (method !== "Page.startScreencast") return;
  const maxWidth = parameters.maxWidth;
  const maxHeight = parameters.maxHeight;
  const outputWidthLimit = browserFrameLimits.maxWidth * browserFrameLimits.maxDevicePixelRatio;
  const outputHeightLimit = browserFrameLimits.maxHeight * browserFrameLimits.maxDevicePixelRatio;
  if (
    (typeof maxWidth === "number" && maxWidth > outputWidthLimit) ||
    (typeof maxHeight === "number" && maxHeight > outputHeightLimit) ||
    (typeof maxWidth === "number" &&
      typeof maxHeight === "number" &&
      maxWidth > 0 &&
      maxHeight > 0 &&
      maxWidth * maxHeight > browserFrameLimits.maxPhysicalPixels)
  ) {
    throw new SessionCdpRouterError(
      "bad_command",
      "CDP screencast dimensions exceed the bounded browser frame size.",
    );
  }
}

function assertIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new SessionCdpRouterError("bad_command", `${label} is invalid.`);
  }
}

function serializedBytes(value: unknown): number {
  try {
    return utf8Size(JSON.stringify(value));
  } catch (error) {
    throw new SessionCdpRouterError("bad_command", "CDP payload is not serializable.", {
      cause: error,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Object groups are named per debugger session, and Electron shares one
 * session per page between the agent and the platform, so an agent's groups
 * carry its own prefix: releasing one can never release a group the platform
 * holds in another world.
 */
function agentObjectGroups(
  parameters: CdpParameters | undefined,
  virtualSessionId: string,
): CdpParameters | undefined {
  const group = parameters?.objectGroup;
  if (typeof group !== "string") return parameters;
  return { ...parameters, objectGroup: `opensteer-agent:${virtualSessionId}:${group}` };
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length <= 512 ? candidate : null;
}

/** A nested page target has its own CDP namespace, never the browser's control session. */
class ChildCdpChannel implements CdpChannel {
  readonly #pending = new Map<
    number,
    { method: string; parameters: CdpParameters; reply: PromiseWithResolvers<unknown> }
  >();
  readonly #listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly #remove: () => void;
  #next = 1;
  #closed = false;
  readonly #isolation: CdpProductIsolation | undefined;
  readonly parent: CdpChannel;
  readonly id: string;
  constructor(parent: CdpChannel, id: string, protectProductWorlds = false) {
    this.#isolation = protectProductWorlds ? new CdpProductIsolation() : undefined;
    this.parent = parent;
    this.id = id;
    this.#remove = parent.onEvent((method, params) => {
      if (method !== "Target.receivedMessageFromTarget" || params.sessionId !== id) return;
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(String(params.message)));
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error)
          pending?.reply.reject(
            new Error(String(asRecord(message.error).message ?? "Child CDP command failed")),
          );
        else if (pending) {
          try {
            this.#isolation?.observeResult(pending.method, pending.parameters, message.result);
            pending.reply.resolve(message.result ?? {});
          } catch (error) {
            pending.reply.reject(error);
          }
        }
      } else if (typeof message.method === "string") {
        if (this.#isolation && !this.#isolation.observe(message.method, asRecord(message.params)))
          return;
        for (const listener of this.#listeners) listener(message.method, asRecord(message.params));
      }
    });
  }
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (this.#closed) throw new Error("Child CDP attachment closed");
    const id = this.#next++;
    const pending = Promise.withResolvers<unknown>();
    this.#isolation?.assertCommand(method, parameters ?? {});
    if (
      this.#isolation &&
      method === "Runtime.addBinding" &&
      parameters?.executionContextId === undefined &&
      parameters?.executionContextName === undefined
    )
      parameters = { ...parameters, executionContextName: "" };
    this.#pending.set(id, { method, parameters: parameters ?? {}, reply: pending });
    void this.parent
      .send("Target.sendMessageToTarget", {
        sessionId: this.id,
        message: JSON.stringify({ id, method, params: parameters }),
      })
      .catch((error: unknown) => {
        if (this.#pending.delete(id)) pending.reject(error);
      });
    return pending.promise;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#remove();
    this.#listeners.clear();
    for (const pending of this.#pending.values())
      pending.reply.reject(new Error("Child CDP attachment closed"));
    this.#pending.clear();
    await this.parent
      .send("Target.detachFromTarget", { sessionId: this.id })
      .catch(() => undefined);
  }
}
