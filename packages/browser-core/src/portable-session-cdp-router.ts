import { CdpProductIsolation } from "./cdp-product-isolation.js";
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
  /**
   * Opens a page channel that behaves as a fresh CDP session: its
   * `Runtime.enable` reports every live execution context before it resolves,
   * whatever other channels on the target have enabled.
   */
  attach(targetId: string, waitForPage?: boolean): Promise<CdpChannel>;
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
  readonly ending: PromiseWithResolvers<never>;
  readonly ended: AbortController;
  readonly physicalTargetId: string;
  removeListener: () => void;
  pageEnabled: boolean;
  readonly rootAttached?: boolean;
  readonly virtualSessionId: string;
}

interface SessionState {
  readonly resolveTarget: (targetId: string) => Promise<boolean>;
  readonly channels: Map<string, AttachedChannel>;
  /** Released channels retain identity for the caller's tab lifecycle check, never page access. */
  readonly retiredTargets: Map<string, string>;
  autoAttached: Map<string, Promise<{ sessionId: string } | undefined>> | undefined;
  discoverTargets: boolean | undefined;
  discoveryReplay: Set<string> | undefined;
  ledgerDialogEvents: boolean;
  readonly eventListeners: Set<(event: CdpEvent) => void>;
  readonly filesRoot: string;
  nextSequence: number;
  readonly ownedTargetIds: Set<string>;
  readonly rootTargetId: string;
  readonly sessionId: string;
}

const defaultLimits: SessionCdpRouterLimits = {
  maxCommandBytes: 432 * 1_024,
  maxEventBytes: 432 * 1_024,
  maxResultBytes: 432 * 1_024,
};

const browserRootLimit = 8 * 1_024 * 1_024;

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
  readonly #ownerByTargetId = new Map<string, string>();
  readonly #removeBackendListener: () => void;
  readonly #sessions = new Map<string, SessionState>();
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
    if (this.#sessions.has(sessionId)) {
      throw new SessionCdpRouterError("conflict", "Browser Session is already registered.");
    }
    if (this.#ownerByTargetId.has(rootTargetId)) {
      throw new SessionCdpRouterError("conflict", "Root target already belongs to a session.");
    }
    const state: SessionState = {
      resolveTarget,
      channels: new Map(),
      retiredTargets: new Map(),
      autoAttached: undefined,
      discoverTargets: undefined,
      discoveryReplay: undefined,
      ledgerDialogEvents: false,
      eventListeners: new Set(),
      filesRoot,
      nextSequence: 1,
      ownedTargetIds: new Set([rootTargetId]),
      rootTargetId,
      sessionId,
    };
    this.#sessions.set(sessionId, state);
    this.#ownerByTargetId.set(rootTargetId, sessionId);
    this.#unclaimedPages.delete(rootTargetId);
  }

  async unregisterSession(sessionId: string): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    this.#sessions.delete(sessionId);
    for (const targetId of state.ownedTargetIds) this.#ownerByTargetId.delete(targetId);
    for (const attached of state.channels.values()) this.#endChannel(state, attached);
    state.eventListeners.clear();
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
    return [...this.#requireSession(sessionId).ownedTargetIds];
  }

  /**
   * Makes a page the session opened outside agent CDP, such as a tab the
   * person opened, reachable by that session's agents, and its popups with it.
   */
  releaseTarget(sessionId: string, targetId: string): void {
    if (this.#ownerByTargetId.get(targetId) === sessionId) this.#releaseTarget(targetId);
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
    state.ledgerDialogEvents = true;
    return (targetId, method, parameters) => {
      for (const attached of state.channels.values()) {
        if (attached.physicalTargetId === targetId && attached.pageEnabled) {
          this.#appendEvent(state, method, parameters, attached.virtualSessionId);
        }
      }
    };
  }

  /** The page an agent's attached CDP session drives, or null when it is not attached here. */
  attachedTargetId(sessionId: string, cdpSessionId: string): string | null {
    const state = this.#sessions.get(sessionId);
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
  admitPageResult(result: unknown): void {
    this.#assertResultSize(result, this.#limits.maxResultBytes);
  }

  #assertResultSize(result: unknown, maxResultBytes: number): void {
    if (serializedBytes(result) > maxResultBytes) {
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
    const state = this.#requireSession(sessionId);
    state.eventListeners.add(listener);
    return () => state.eventListeners.delete(listener);
  }

  async send(
    sessionId: string,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    const limits = this.#sessionLimits(state);
    validateCommand(command, limits.maxCommandBytes);
    this.#assertScope(state, command.parameters ?? {});
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
    if (this.#backend.scopeParameters && command.sessionId) {
      command = {
        ...command,
        parameters: await this.#backend.scopeParameters(command.method, command.parameters ?? {}),
      };
      if (this.#requireSession(sessionId) !== state)
        throw new SessionCdpRouterError("not_found", "Browser Session ended during routing.");
    }
    // Chromium download settings apply to the whole profile. The virtual root
    // acknowledges Playwright's initialization without changing the profile.
    if (
      state.autoAttached &&
      !command.sessionId &&
      command.method === "Browser.setDownloadBehavior"
    )
      return {};

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
    this.#assertResultSize(result, limits.maxResultBytes);
    return result;
  }

  async #sendTargetCommand(state: SessionState, command: CdpCommand): Promise<unknown> {
    const parameters = command.parameters ?? {};
    switch (command.method) {
      case "Target.getTargets": {
        return {
          rootTargetId: state.rootTargetId,
          targetInfos: await this.#ownedTargetInfos(state, parameters),
        };
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
        const result = await this.send(state.sessionId, {
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
        return this.#backend.send(command.method, parameters);
      case "Target.getTargetInfo": {
        if (!command.sessionId && parameters.targetId === undefined) {
          return {
            targetInfo: {
              targetId: `browser_${state.sessionId}`,
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          };
        }
        const targetId = requiredTargetId(parameters);
        this.#assertOwnedTarget(state, targetId);
        return this.#backend.send(command.method, { ...parameters, targetId });
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
        if (this.#sessions.get(state.sessionId) !== state) {
          await this.#backend.send("Target.closeTarget", { targetId }).catch(() => undefined);
          throw new SessionCdpRouterError("not_found", "Browser Session is not registered.");
        }
        this.#claimTarget(state, targetId);
        const attaching = state.autoAttached?.get(targetId);
        if (attaching && !(await attaching))
          throw new SessionCdpRouterError(
            "not_found",
            "The new browser page is no longer attachable.",
          );
        return response;
      }
      case "Target.attachToTarget": {
        const targetId = requiredTargetId(parameters);
        const existing = [...state.channels.values()].find(
          (channel) =>
            channel.physicalTargetId === targetId && channel.channel instanceof ChildCdpChannel,
        );
        if (existing) return { sessionId: existing.virtualSessionId };
        if (!command.sessionId && state.autoAttached) {
          const attached = await this.#autoAttachTarget(state, targetId);
          if (attached) return attached;
          throw new SessionCdpRouterError("not_found", "The browser page is no longer attachable.");
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
        if (
          typeof parameters.autoAttach !== "boolean" ||
          (parameters.autoAttach && parameters.flatten !== true)
        ) {
          throw new SessionCdpRouterError("bad_command", "Browser auto-attach requires flat mode.");
        }
        if (parameters.autoAttach) {
          state.autoAttached ??= new Map();
          const autoAttached = state.autoAttached;
          // Announce existing openers before their popups.
          for (const targetId of state.ownedTargetIds) {
            if (state.autoAttached !== autoAttached) break;
            await this.#autoAttachTarget(state, targetId);
          }
        } else {
          state.autoAttached = undefined;
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
        const replay = discover ? new Set<string>() : undefined;
        state.discoveryReplay = replay;
        if (!replay) return {};
        try {
          for (const targetInfo of await this.#ownedTargetInfos(state)) {
            if (state.discoveryReplay !== replay) break;
            const targetId = requiredTargetId(targetInfo);
            if (!replay.has(targetId) && this.#ownerByTargetId.get(targetId) === state.sessionId)
              this.#appendEvent(state, "Target.targetCreated", { targetInfo });
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
        this.#assertOwnedTarget(state, targetId);
        const response = await this.#backend.send(command.method, { ...parameters, targetId });
        this.#releaseTarget(targetId);
        return response;
      }
      default:
        if (typeof parameters.targetId === "string")
          return this.#backend.send(command.method, parameters);
        throw new SessionCdpRouterError(
          "forbidden",
          `${command.method} cannot be safely scoped to one Browser Session.`,
        );
    }
  }

  async #ownedTargetInfos(
    state: SessionState,
    parameters?: CdpParameters,
  ): Promise<Record<string, unknown>[]> {
    const response = asRecord(await this.#backend.send("Target.getTargets", parameters));
    const targetInfos: unknown[] = Array.isArray(response.targetInfos) ? response.targetInfos : [];
    return targetInfos.map(asRecord).filter((info) => {
      const targetId = readString(info, "targetId");
      return targetId !== null && this.#ownerByTargetId.get(targetId) === state.sessionId;
    });
  }

  #autoAttachTarget(
    state: SessionState,
    targetId: string,
  ): Promise<{ sessionId: string } | undefined> | undefined {
    const pending = state.autoAttached;
    if (!pending) return;
    const existing = pending.get(targetId);
    if (existing) return existing;
    const current = () =>
      state.autoAttached === pending &&
      pending.get(targetId) === attaching &&
      this.#sessions.get(state.sessionId) === state &&
      this.#ownerByTargetId.get(targetId) === state.sessionId;
    const attaching: Promise<{ sessionId: string } | undefined> = Promise.resolve().then(
      async () => {
        if (!current()) return;
        try {
          const response = asRecord(await this.#backend.send("Target.getTargetInfo", { targetId }));
          const info = asRecord(response.targetInfo);
          if (!current() || info.type !== "page") return;
          const targetInfo: Record<string, unknown> = {
            ...info,
            targetId,
            attached: true,
            browserContextId: readString(info, "browserContextId") ?? state.sessionId,
          };
          const openerId = readString(info, "openerId");
          if (openerId && this.#ownerByTargetId.get(openerId) !== state.sessionId) {
            delete targetInfo.openerId;
            delete targetInfo.openerFrameId;
            targetInfo.canAccessOpener = false;
          }
          return await this.#attachTarget(state, targetId, { targetInfo, current });
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
    state: SessionState,
    targetId: string,
    root?: { targetInfo: CdpParameters; current: () => boolean },
  ): Promise<{ sessionId: string }> {
    this.#assertOwnedTarget(state, targetId);
    const channel = await this.#backend.attach(targetId, root !== undefined);
    if (
      this.#sessions.get(state.sessionId) !== state ||
      this.#ownerByTargetId.get(targetId) !== state.sessionId ||
      (root && !root.current())
    ) {
      void channel.close().catch(() => undefined);
      throw new SessionCdpRouterError("not_found", "The browser surface does not exist.");
    }
    const attached: AttachedChannel = {
      channel,
      ending: Promise.withResolvers<never>(),
      ended: new AbortController(),
      physicalTargetId: targetId,
      rootAttached: root !== undefined,
      removeListener: () => undefined,
      pageEnabled: false,
      virtualSessionId: `cdp_${this.#ports.uuid()}`,
    };
    attached.ending.promise.catch(() => undefined);
    attached.removeListener = channel.onEvent((method, parameters) => {
      this.#handlePageEvent(state, attached, method, parameters);
    });
    state.channels.set(attached.virtualSessionId, attached);
    if (root) {
      this.#appendEvent(state, "Target.attachedToTarget", {
        sessionId: attached.virtualSessionId,
        targetInfo: root.targetInfo,
        waitingForDebugger: false,
      });
    }
    return { sessionId: attached.virtualSessionId };
  }

  #handlePageEvent(
    state: SessionState,
    attached: AttachedChannel,
    method: string,
    parameters: CdpParameters,
  ): void {
    if (
      state.ledgerDialogEvents &&
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
      if (owner && owner !== state.sessionId) return;
      this.#claimTarget(state, targetId, false);
      const channel = new ChildCdpChannel(
        attached.channel,
        physicalSessionId,
        this.#backend.protectProductWorlds === true,
      );
      const child: AttachedChannel = {
        channel,
        ending: Promise.withResolvers<never>(),
        ended: new AbortController(),
        physicalTargetId: targetId,
        virtualSessionId: `cdp_${this.#ports.uuid()}`,
        pageEnabled: false,
        removeListener: () => undefined,
      };
      child.ending.promise.catch(() => undefined);
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

  #admitAttachedCommand(state: SessionState, command: CdpCommand): AttachedChannel {
    const attached = state.channels.get(command.sessionId ?? "");
    if (!attached) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
    }
    const parameters = command.parameters ?? {};
    if (command.method === "Page.navigate") {
      assertSafeNavigationUrl(parameters.url, false);
    }
    if (command.method === "DOM.setFileInputFiles") {
      assertSessionFiles(parameters.files, state.filesRoot, command.method, this.#ports);
    }
    if (command.method === "Input.dispatchDragEvent") {
      const data = parameters.data;
      if (data !== undefined) {
        assertSessionFiles(
          asRecord(data).files ?? [],
          state.filesRoot,
          command.method,
          this.#ports,
        );
      }
    }
    assertBoundedRenderingCommand(command.method, parameters);
    return attached;
  }

  async #sendAttachedCommand(
    state: SessionState,
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
        const result = await this.send(
          state.sessionId,
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
    const result = await Promise.race([
      attached.channel.send(
        command.method,
        agentObjectGroups(parameters, attached.virtualSessionId),
      ),
      attached.ending.promise,
    ]);
    return result;
  }

  // An agent's target selection cannot change a viewer's tab or native focus.
  // CDP activation only verifies that its explicitly named surface still exists.
  async #activateTarget(state: SessionState, targetId: string): Promise<Record<string, never>> {
    this.#assertOwnedTarget(state, targetId);
    if (!(await state.resolveTarget(targetId))) {
      throw new SessionCdpRouterError("not_found", "The browser surface does not exist.");
    }
    return {};
  }

  #handleBrowserEvent(method: string, parameters: CdpParameters): void {
    if (this.#closed) return;
    if (!method.startsWith("Target.")) {
      const targetId = readString(parameters, "targetId") ?? readString(parameters, "frameId");
      const ownerId = targetId ? this.#ownerByTargetId.get(targetId) : undefined;
      const owner = ownerId ? this.#sessions.get(ownerId) : undefined;
      if (owner) this.#appendEvent(owner, method, parameters);
      return;
    }
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") return;
    const targetInfo = asRecord(parameters.targetInfo);
    const targetId = readString(targetInfo, "targetId") ?? readString(parameters, "targetId");
    if (!targetId) return;

    if (method === "Target.targetCreated") {
      const parentTargetId =
        readString(targetInfo, "openerId") ?? readString(targetInfo, "parentId");
      const ownerId = parentTargetId ? this.#ownerByTargetId.get(parentTargetId) : undefined;
      const owner = ownerId ? this.#sessions.get(ownerId) : undefined;
      if (
        owner &&
        ["page", "iframe", "worker", "shared_worker", "service_worker"].includes(
          String(targetInfo.type),
        )
      ) {
        this.#claimTarget(owner, targetId, targetInfo.type === "page");
      }
    }

    const ownerId = this.#ownerByTargetId.get(targetId);
    const owner = ownerId ? this.#sessions.get(ownerId) : undefined;
    if (owner && owner.discoverTargets !== false) {
      if (method === "Target.targetCreated") owner.discoveryReplay?.add(targetId);
      this.#appendEvent(owner, method, parameters);
    }
    if (!owner) this.#trackUnclaimedPage(method, targetId, parameters);
    if (method === "Target.targetDestroyed") this.#releaseTarget(targetId);
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

  #claimTarget(state: SessionState, targetId: string, attachPage = true): void {
    const existingOwner = this.#ownerByTargetId.get(targetId);
    if (existingOwner && existingOwner !== state.sessionId) {
      throw new SessionCdpRouterError("conflict", "CDP target belongs to another session.");
    }
    state.ownedTargetIds.add(targetId);
    this.#ownerByTargetId.set(targetId, state.sessionId);
    const announced = this.#unclaimedPages.get(targetId);
    if (announced) {
      this.#unclaimedPages.delete(targetId);
      if (state.discoverTargets !== false) {
        state.discoveryReplay?.add(targetId);
        this.#appendEvent(state, "Target.targetCreated", { targetInfo: announced });
      }
    }
    if (attachPage) void this.#autoAttachTarget(state, targetId)?.catch(() => undefined);
  }

  #releaseTarget(targetId: string): void {
    const ownerId = this.#ownerByTargetId.get(targetId);
    if (!ownerId) return;
    this.#ownerByTargetId.delete(targetId);
    const state = this.#sessions.get(ownerId);
    state?.ownedTargetIds.delete(targetId);
    if (!state) return;
    state.autoAttached?.delete(targetId);
    for (const attached of state.channels.values()) {
      if (attached.physicalTargetId === targetId) {
        state.retiredTargets.set(attached.virtualSessionId, targetId);
        this.#endChannel(state, attached);
      }
    }
  }

  /**
   * Ends one agent page session here at once. Its channel finishes closing on
   * its own: a backend can need the page to answer first, and a page under a
   * JavaScript dialog answers nothing until the dialog closes.
   */
  #endChannel(state: SessionState, attached: AttachedChannel): void {
    if (state.channels.get(attached.virtualSessionId) !== attached) return;
    state.channels.delete(attached.virtualSessionId);
    if (attached.rootAttached) {
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
    attached.ending.reject(ended);
    attached.ended.abort(ended);
    void attached.channel.close().catch(() => undefined);
  }

  #appendEvent(
    state: SessionState,
    method: string,
    parameters: CdpParameters,
    sessionId?: string,
  ): void {
    const event: CdpEvent = {
      method,
      parameters,
      sequence: state.nextSequence++,
      ...(sessionId ? { sessionId } : {}),
    };
    if (serializedBytes(event) > this.#sessionLimits(state).maxEventBytes) return;
    for (const listener of state.eventListeners) {
      try {
        listener(event);
      } catch {
        // A downstream listener is an observation boundary. It cannot break
        // target ownership or the browser backend's event pump.
      }
    }
  }

  #assertScope(state: SessionState, parameters: CdpParameters): void {
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

  #assertOwnedTarget(state: SessionState, targetId: string): void {
    if (this.#ownerByTargetId.get(targetId) !== state.sessionId) {
      throw new SessionCdpRouterError("forbidden", "CDP target is outside this Browser Session.");
    }
  }

  #sessionLimits(state: SessionState): SessionCdpRouterLimits {
    return state.autoAttached ? this.#browserRootLimits : this.#limits;
  }

  #requireSession(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new SessionCdpRouterError("not_found", "Browser Session is not registered.");
    return state;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionCdpRouterError("conflict", "CDP router is closed.");
  }
}

function validateCommand(command: CdpCommand, maxBytes: number): void {
  if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(command.method)) {
    throw new SessionCdpRouterError("bad_command", "CDP method is invalid.");
  }
  if (command.sessionId !== undefined) assertIdentifier(command.sessionId, "CDP session ID");
  if (command.parameters !== undefined && !isPlainObject(command.parameters)) {
    throw new SessionCdpRouterError("bad_command", "CDP parameters must be an object.");
  }
  if (serializedBytes(command) > maxBytes) {
    throw new SessionCdpRouterError("too_large", "CDP command exceeds its byte limit.");
  }
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
      .catch(pending.reject);
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
