import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  agentPageCommandRefusal,
  browserInternalsRefusal,
  isAgentPageEvent,
} from "./agent-cdp-policy.js";
import { browserFrameFits, browserFrameLimits } from "./browser-frame-limits.js";
import {
  ExecutionContextInventory,
  foreignObjectHandle,
  type ExecutionContextEntry,
} from "./execution-contexts.js";

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
  close(): Promise<void>;
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void;
  send(method: string, parameters?: CdpParameters): Promise<unknown>;
}

export interface BrowserCdpBackend {
  /**
   * Opens a page channel that behaves as a fresh CDP session: its
   * `Runtime.enable` reports every live execution context before it resolves,
   * whatever other channels on the target have enabled.
   */
  attach(targetId: string): Promise<CdpChannel>;
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void;
  send(method: string, parameters?: CdpParameters): Promise<unknown>;
}

export interface SessionCdpRouterLimits {
  readonly maxCommandBytes: number;
  readonly maxEventBytes: number;
  readonly maxResultBytes: number;
  readonly maxSessions: number;
  readonly maxTargetsPerSession: number;
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
  /** Kept from the router's own Runtime subscription, never the agent's. */
  readonly contexts: ExecutionContextInventory;
  /** Rejects once the router ends the session, answering every command still waiting on it. */
  readonly ending: PromiseWithResolvers<never>;
  /** Settles once the router's own Runtime.enable has reported every context. */
  inventoried: Promise<void>;
  readonly physicalTargetId: string;
  removeListener: () => void;
  /** Whether the agent asked for Runtime events on this session. */
  runtimeEnabled: boolean;
  pageEnabled: boolean;
  readonly virtualSessionId: string;
}

interface SessionState {
  readonly resolveTarget: (targetId: string) => Promise<boolean>;
  readonly channels: Map<string, AttachedChannel>;
  discoverTargets: boolean;
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
  maxSessions: 64,
  maxTargetsPerSession: 128,
};

const allowedBrowserMethods = new Set(["Browser.getVersion"]);
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
 * Site behavior belongs in skills; process, cross-session, native-focus, and
 * page-level agent ([policy](./agent-cdp-policy.ts)) boundaries belong here.
 */
export class SessionCdpRouter {
  readonly #backend: BrowserCdpBackend;
  readonly #machineClipboardShared: boolean;
  readonly #limits: SessionCdpRouterLimits;
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
    limits: Partial<SessionCdpRouterLimits> = {},
    machineClipboardShared = true,
  ) {
    this.#machineClipboardShared = machineClipboardShared;
    this.#backend = backend;
    this.#limits = validateLimits({ ...defaultLimits, ...limits });
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
    if (!path.isAbsolute(filesRoot) || path.resolve(filesRoot) !== filesRoot) {
      throw new TypeError("Browser Session files root must be an absolute normalized path.");
    }
    if (this.#sessions.has(sessionId)) {
      throw new SessionCdpRouterError("conflict", "Browser Session is already registered.");
    }
    if (this.#sessions.size >= this.#limits.maxSessions) {
      throw new SessionCdpRouterError("conflict", "Profile Host session capacity is exhausted.");
    }
    if (this.#ownerByTargetId.has(rootTargetId)) {
      throw new SessionCdpRouterError("conflict", "Root target already belongs to a session.");
    }
    const state: SessionState = {
      resolveTarget,
      channels: new Map(),
      discoverTargets: true,
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
   * Claiming a page the session already owns changes nothing.
   */
  claimTarget(sessionId: string, targetId: string): void {
    this.#assertOpen();
    assertIdentifier(targetId, "CDP target ID");
    const state = this.#requireSession(sessionId);
    if (this.#ownerByTargetId.get(targetId) === state.sessionId) return;
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
    return this.#sessions.get(sessionId)?.channels.get(cdpSessionId)?.physicalTargetId ?? null;
  }

  /**
   * Refuses exactly what `send` would refuse of an agent's command to one of
   * its attached pages, without sending it, for a command the caller applies
   * to that page through a session of its own.
   */
  admitPageCommand(sessionId: string, command: CdpCommand): void {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#limits.maxCommandBytes);
    this.#admitAttachedCommand(state, command);
  }

  /**
   * Refuses exactly what `send` would refuse of an agent's
   * `Target.createTarget`, without sending it, for a tab the caller opens
   * blank and then loads at `url` itself.
   */
  admitCreateTarget(sessionId: string, command: CdpCommand): void {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#limits.maxCommandBytes);
    this.#admitCreateTarget(state, command.parameters ?? {});
  }

  onEvent(sessionId: string, listener: (event: CdpEvent) => void): () => void {
    const state = this.#requireSession(sessionId);
    state.eventListeners.add(listener);
    return () => state.eventListeners.delete(listener);
  }

  async send(sessionId: string, command: CdpCommand): Promise<unknown> {
    this.#assertOpen();
    const state = this.#requireSession(sessionId);
    validateCommand(command, this.#limits.maxCommandBytes);
    if (
      !command.sessionId &&
      !command.method.startsWith("Target.") &&
      !allowedBrowserMethods.has(command.method)
    ) {
      throw new SessionCdpRouterError("forbidden", browserInternalsRefusal(command.method));
    }
    const result = command.method.startsWith("Target.")
      ? await this.#sendTargetCommand(state, command)
      : command.sessionId
        ? await this.#sendAttachedCommand(state, command)
        : await this.#backend.send(command.method, command.parameters);
    if (serializedBytes(result) > this.#limits.maxResultBytes) {
      throw new SessionCdpRouterError(
        "too_large",
        "CDP result exceeds the bounded agent transport. Query a narrower result in the page.",
      );
    }
    return result;
  }

  async #sendTargetCommand(state: SessionState, command: CdpCommand): Promise<unknown> {
    const parameters = command.parameters ?? {};
    switch (command.method) {
      case "Target.getTargets": {
        const response = asRecord(await this.#backend.send(command.method, parameters));
        const targetInfos = Array.isArray(response.targetInfos) ? response.targetInfos : [];
        return {
          ...response,
          rootTargetId: state.rootTargetId,
          targetInfos: targetInfos.filter((targetInfo) => {
            const targetId = readString(asRecord(targetInfo), "targetId");
            return targetId !== null && this.#ownerByTargetId.get(targetId) === state.sessionId;
          }),
        };
      }
      case "Target.getBrowserContexts":
        return this.#backend.send(command.method, parameters);
      case "Target.getTargetInfo": {
        const targetId = requiredTargetId(parameters);
        this.#assertOwnedTarget(state, targetId);
        return this.#backend.send(command.method, { ...parameters, targetId });
      }
      case "Target.createTarget": {
        this.#admitCreateTarget(state, parameters);
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
        return response;
      }
      case "Target.attachToTarget":
        return this.#attachTarget(state, requiredTargetId(parameters));
      case "Target.detachFromTarget": {
        const virtualSessionId = requiredString(parameters, "sessionId");
        const attached = state.channels.get(virtualSessionId);
        if (!attached) {
          throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
        }
        this.#endChannel(state, attached);
        return {};
      }
      case "Target.setDiscoverTargets": {
        const discover = parameters.discover;
        if (typeof discover !== "boolean") {
          throw new SessionCdpRouterError("bad_command", "Target discovery requires a boolean.");
        }
        state.discoverTargets = discover;
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
        throw new SessionCdpRouterError(
          "forbidden",
          `${command.method} cannot be safely scoped to one Browser Session.`,
        );
    }
  }

  /**
   * The router enables Runtime on every page session itself and keeps that
   * session's execution contexts, so it knows each frame's main world before
   * anything the agent sends reaches the page, whether or not the agent ever
   * enables Runtime. The session is the agent's once its channel opens, as an
   * attach is in Chromium: a page under a JavaScript dialog reports no context
   * until the dialog closes, and the agent needs the session to answer it.
   */
  async #attachTarget(state: SessionState, targetId: string): Promise<{ sessionId: string }> {
    this.#assertOwnedTarget(state, targetId);
    const channel = await this.#backend.attach(targetId);
    if (
      this.#sessions.get(state.sessionId) !== state ||
      this.#ownerByTargetId.get(targetId) !== state.sessionId
    ) {
      void channel.close().catch(() => undefined);
      throw new SessionCdpRouterError("not_found", "The browser surface does not exist.");
    }
    const attached: AttachedChannel = {
      channel,
      contexts: new ExecutionContextInventory(),
      ending: Promise.withResolvers<never>(),
      inventoried: Promise.resolve(),
      physicalTargetId: targetId,
      removeListener: () => undefined,
      runtimeEnabled: false,
      pageEnabled: false,
      virtualSessionId: `cdp_${randomUUID()}`,
    };
    attached.ending.promise.catch(() => undefined);
    attached.removeListener = channel.onEvent((method, parameters) => {
      this.#handlePageEvent(state, attached, method, parameters);
    });
    state.channels.set(attached.virtualSessionId, attached);
    attached.inventoried = channel.send("Runtime.enable").then(
      () => undefined,
      (error: unknown) => {
        if (state.channels.get(attached.virtualSessionId) === attached) {
          this.#endChannel(state, attached);
        }
        throw error;
      },
    );
    attached.inventoried.catch(() => undefined);
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
    const reported = attached.contexts.observe(method, parameters);
    if (method.startsWith("Runtime.") && !attached.runtimeEnabled) return;
    if (!isAgentPageEvent(method)) return;
    if (!admitsAgentEvent(attached.contexts, method, parameters, reported)) return;
    if (!state.channels.has(attached.virtualSessionId)) return;
    this.#appendEvent(state, method, parameters, attached.virtualSessionId);
  }

  #admitAttachedCommand(state: SessionState, command: CdpCommand): AttachedChannel {
    const attached = state.channels.get(command.sessionId ?? "");
    if (!attached) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
    }
    const parameters = command.parameters ?? {};
    const refusal =
      agentPageCommandRefusal(command.method, parameters, this.#machineClipboardShared) ??
      objectHandleRefusal(command.method, parameters, attached.contexts);
    if (refusal) throw new SessionCdpRouterError("forbidden", refusal);
    if (command.method === "Page.navigate") {
      assertSafeNavigationUrl(parameters.url, false);
    }
    if (command.method === "DOM.setFileInputFiles") {
      assertSessionFiles(parameters.files, state.filesRoot, command.method);
    }
    if (command.method === "Input.dispatchDragEvent") {
      const data = parameters.data;
      if (data !== undefined) {
        assertSessionFiles(asRecord(data).files ?? [], state.filesRoot, command.method);
      }
    }
    assertBoundedRenderingCommand(command.method, parameters);
    return attached;
  }

  async #sendAttachedCommand(state: SessionState, command: CdpCommand): Promise<unknown> {
    const opened = state.channels.get(command.sessionId ?? "");
    // A dialog's answer is what lets a page under it report its contexts.
    if (opened && command.method !== "Page.handleJavaScriptDialog") {
      await Promise.race([opened.inventoried, opened.ending.promise]);
    }
    const attached = this.#admitAttachedCommand(state, command);
    if (command.method === "Page.bringToFront") {
      return this.#activateTarget(state, attached.physicalTargetId);
    }
    if (command.method === "Page.enable") attached.pageEnabled = true;
    if (command.method === "Page.disable") attached.pageEnabled = false;
    // The router's own subscription stays; the agent's only gates its events.
    if (command.method === "Runtime.enable") {
      if (attached.runtimeEnabled) return {};
      attached.runtimeEnabled = true;
      for (const context of attached.contexts.entries()) {
        if (!context.mainWorld) continue;
        this.#appendEvent(
          state,
          "Runtime.executionContextCreated",
          { context: context.description },
          attached.virtualSessionId,
        );
      }
      return {};
    }
    if (command.method === "Runtime.disable") {
      attached.runtimeEnabled = false;
      return {};
    }
    let parameters = command.parameters;
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
    const result = await Promise.race([
      attached.channel.send(
        command.method,
        agentObjectGroups(parameters, attached.virtualSessionId),
      ),
      attached.ending.promise,
    ]);
    const foreign = foreignObjectHandle(result, attached.contexts, "message");
    if (foreign !== null) {
      throw new SessionCdpRouterError(
        "forbidden",
        `${command.method} returned ${foreign} from outside a frame's main world: agents operate only frames' main worlds.`,
      );
    }
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
    if (this.#closed || !method.startsWith("Target.")) return;
    const targetInfo = asRecord(parameters.targetInfo);
    const targetId = readString(targetInfo, "targetId") ?? readString(parameters, "targetId");
    if (!targetId) return;

    if (method === "Target.targetCreated") {
      const parentTargetId =
        readString(targetInfo, "openerId") ?? readString(targetInfo, "parentId");
      const ownerId = parentTargetId ? this.#ownerByTargetId.get(parentTargetId) : undefined;
      const owner = ownerId ? this.#sessions.get(ownerId) : undefined;
      if (owner && owner.ownedTargetIds.size < this.#limits.maxTargetsPerSession) {
        this.#claimTarget(owner, targetId);
      }
    }

    const ownerId = this.#ownerByTargetId.get(targetId);
    const owner = ownerId ? this.#sessions.get(ownerId) : undefined;
    if (owner?.discoverTargets) this.#appendEvent(owner, method, parameters);
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

  #claimTarget(state: SessionState, targetId: string): void {
    const existingOwner = this.#ownerByTargetId.get(targetId);
    if (existingOwner && existingOwner !== state.sessionId) {
      throw new SessionCdpRouterError("conflict", "CDP target belongs to another session.");
    }
    this.#assertTargetCapacity(state);
    state.ownedTargetIds.add(targetId);
    this.#ownerByTargetId.set(targetId, state.sessionId);
    const announced = this.#unclaimedPages.get(targetId);
    if (!announced) return;
    this.#unclaimedPages.delete(targetId);
    if (state.discoverTargets) {
      this.#appendEvent(state, "Target.targetCreated", { targetInfo: announced });
    }
  }

  #releaseTarget(targetId: string): void {
    const ownerId = this.#ownerByTargetId.get(targetId);
    if (!ownerId) return;
    this.#ownerByTargetId.delete(targetId);
    const state = this.#sessions.get(ownerId);
    state?.ownedTargetIds.delete(targetId);
    if (!state) return;
    for (const attached of state.channels.values()) {
      if (attached.physicalTargetId === targetId) this.#endChannel(state, attached);
    }
  }

  /**
   * Ends one agent page session here at once. Its channel finishes closing on
   * its own: a backend can need the page to answer first, and a page under a
   * JavaScript dialog answers nothing until the dialog closes.
   */
  #endChannel(state: SessionState, attached: AttachedChannel): void {
    if (state.channels.get(attached.virtualSessionId) === attached) {
      state.channels.delete(attached.virtualSessionId);
    }
    attached.removeListener();
    attached.ending.reject(
      new SessionCdpRouterError("not_found", "The CDP session ended before the page answered."),
    );
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
    if (serializedBytes(event) > this.#limits.maxEventBytes) return;
    for (const listener of state.eventListeners) {
      try {
        listener(event);
      } catch {
        // A downstream listener is an observation boundary. It cannot break
        // target ownership or the browser backend's event pump.
      }
    }
  }

  #assertOwnedTarget(state: SessionState, targetId: string): void {
    if (this.#ownerByTargetId.get(targetId) !== state.sessionId) {
      throw new SessionCdpRouterError("forbidden", "CDP target is outside this Browser Session.");
    }
  }

  #admitCreateTarget(state: SessionState, parameters: CdpParameters): void {
    this.#assertTargetCapacity(state);
    assertSafeNavigationUrl(parameters.url, true);
  }

  #assertTargetCapacity(state: SessionState): void {
    if (state.ownedTargetIds.size >= this.#limits.maxTargetsPerSession) {
      throw new SessionCdpRouterError("conflict", "Browser Session target capacity is exhausted.");
    }
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

/**
 * Every object handle a command names must belong to a frame's main world
 * that this page session reported. A handle that does not parse, or names a
 * context the session never reported, is refused as surely as one that names
 * an isolated, preload or platform world.
 */
function objectHandleRefusal(
  method: string,
  parameters: CdpParameters,
  contexts: ExecutionContextInventory,
): string | null {
  const foreign = foreignObjectHandle(parameters, contexts, "command");
  if (foreign === null) return null;
  return `${method} ${foreign} does not name an object in a frame's main world: agents operate only frames' main worlds, not other script worlds.`;
}

/**
 * Admits a page event only when everything it carries comes from a frame's
 * main world: context events for main worlds, console messages and exceptions
 * raised in one, and no object handle from anywhere else.
 */
function admitsAgentEvent(
  contexts: ExecutionContextInventory,
  method: string,
  parameters: CdpParameters,
  reported: ExecutionContextEntry | null,
): boolean {
  switch (method) {
    case "Runtime.executionContextCreated":
    case "Runtime.executionContextDestroyed":
      return reported?.mainWorld === true;
    case "Runtime.consoleAPICalled":
      if (!contexts.isMainWorld(parameters.executionContextId)) return false;
      break;
    case "Runtime.exceptionThrown":
      if (!contexts.isMainWorld(asRecord(parameters.exceptionDetails).executionContextId)) {
        return false;
      }
      break;
    default:
      break;
  }
  return foreignObjectHandle(parameters, contexts, "message") === null;
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

function assertSafeNavigationUrl(value: unknown, allowAboutBlank: boolean): void {
  if (value === undefined && allowAboutBlank) return;
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) {
    throw new SessionCdpRouterError("bad_command", "CDP navigation URL is invalid.");
  }
  if (allowAboutBlank && value === "about:blank") return;
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

function assertSessionFiles(value: unknown, filesRoot: string, method: string): void {
  if (!Array.isArray(value) || value.length > maximumSessionFilesPerCommand) {
    throw new SessionCdpRouterError("bad_command", `${method} files are invalid.`);
  }
  const prefix = `${filesRoot}${path.sep}`;
  for (const file of value) {
    if (
      typeof file !== "string" ||
      file.includes("\0") ||
      !path.isAbsolute(file) ||
      path.resolve(file) !== file ||
      !file.startsWith(prefix)
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
    return Buffer.byteLength(JSON.stringify(value), "utf8");
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
