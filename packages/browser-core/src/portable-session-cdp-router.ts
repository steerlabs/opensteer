import {
  standardCdpPageMethods,
  standardCdpRootTargetMethods as standardRootTargets,
} from "./standard-cdp-page-methods.js";
import {
  standardCdpAnswerMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "./standard-cdp-limits.js";
export {
  standardCdpAnswerMaxBytes,
  standardCdpMessageMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "./standard-cdp-limits.js";
import { ThisHomeAddressSet, type ThisHomeAddresses } from "@opensteer/shared/homeAddress";
import { contextScopedCdpMethods } from "./cdp-context.js";
import { CdpProductIsolation } from "./cdp-product-isolation.js";
import { ConnectionExtensionIsolation, isExtensionUrl } from "./connection-extension-isolation.js";
import { answerTooLargeMessage, boundedJsonSize, type JsonSizeBudget } from "./bounded-json.js";
import { utf8Size } from "./bytes.js";
import {
  cdpCommandRefusal,
  connectionAutoAttachParameters,
  connectionCdpRefusal,
  connectionMethodRefusal,
  decodeNestedCdpMessage,
  extensionManagementRefusal,
  invalidNestedMessageRefusal,
  isExtensionMutationCommand,
} from "./cdp-command-refusals.js";
export {
  decodeNestedCdpMessage,
  invalidNestedMessageRefusal,
  nestedTooDeepRefusal,
  cdpCommandRefusal,
  connectionAutoAttachParameters,
  connectionCdpRefusal,
  connectionMethodRefusal,
  connectionNestedAutoAttachRefusal,
  nestsAutoAttach,
  clipboardPermissionRefusal,
  connectionClipboardRefusal,
  connectionPermissionRefusal,
  extensionManagementRefusal,
  isExtensionMutationCommand,
} from "./cdp-command-refusals.js";

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
  readonly replyBudget?: JsonSizeBudget & { readonly maxImageBytes?: number | undefined };
  readonly scriptAttachmentId?: string;
  readonly parameters?: CdpParameters;
  readonly sessionId?: string;
  /**
   * The command is sent under a connected agent's authority, as the Home decided it for this
   * command's attachment; nested commands carry it on.
   */
  readonly connection?: true;
  /**
   * The Home's authority rule admitted this execution to persist or remove profile Chrome
   * extensions (`Extensions.loadUnpacked`, `Extensions.uninstall`). Never defaulted on.
   */
  readonly manageExtensions?: true;
}

export interface CdpEvent {
  readonly method: string;
  readonly parameters: CdpParameters;
  readonly sequence: number;
  readonly scriptAttachmentId?: string;
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
  /**
   * This Home's addresses, as the Home last told this browser: no page, frame, worker or service
   * worker of any of its profiles loads one, the person's or an agent's (G1).
   */
  setHomeAddresses?(home: ThisHomeAddressSet): void | Promise<void>;
  readonly protectProductWorlds?: boolean;
  readonly allowsProfileCookieReads?: boolean;
  /** The browser keeps the profile's Chrome extensions and answers CDP's `Extensions` domain. */
  readonly extensions?: boolean;
  /**
   * Opens a page channel that behaves as a fresh CDP session: its
   * `Runtime.enable` reports every live execution context before it resolves,
   * whatever other channels on the target have enabled.
   */
  readonly dedicatedContext?: boolean;
  attach(targetId: string, waitForPage?: boolean, signal?: AbortSignal): Promise<CdpChannel>;
  /** Notifies the backend when a target enters or leaves connected-agent control (M1a, S1). */
  setConnectionControlled?(targetId: string, controlled: boolean): void;
  assertScope?(method: string, parameters: CdpParameters): void;
  scopeParameters?(method: string, parameters: CdpParameters): Promise<CdpParameters>;
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void;
  send(method: string, parameters?: CdpParameters): Promise<unknown>;
}

export interface SessionCdpRouterLimits {
  readonly maxCommandBytes: number;
  readonly maxEventBytes: number;
  readonly maxResultBytes: number;
  /** Upper bound (ms) for internal `Runtime.enable` inventory on connection channels. */
  readonly internalRuntimeEnableTimeoutMs?: number;
}

export interface StandardCdpAttachmentOptions {
  readonly wholeContext: boolean;
  /**
   * The attachment acts under a connected agent's authority, as the Home decided when it was
   * made: it never uses the clipboard in the browser and never changes a browser permission.
   */
  readonly connection?: boolean;
  readonly lineage?: { readonly attachmentId: string; readonly seedTargetId: string };
  readonly adoptTarget?: (targetId: string) => Promise<boolean>;
  readonly recoverUnadoptedTarget?: (targetId: string) => Promise<void>;
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
  readonly settled: Promise<void>;
  send(command: CdpCommand, beforeActivity?: (targetId: string) => void): Promise<unknown>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  attachedTargetId(cdpSessionId: string): string | null;
  close(): void;
}

export class SessionCdpRouterError extends Error {
  readonly code: "bad_command" | "conflict" | "forbidden" | "not_found" | "too_large";
  /** A7: refused before the command was handed on toward the browser: nothing happened. */
  readonly unsent: boolean;
  /**
   * A7: the command ran and its answer arrived, over the limit: a failure of that command, never
   * an unknown outcome. Only the answer-size check says so; no other refusal proves the command
   * finished.
   */
  readonly answerTooLarge: boolean;

  constructor(
    code: SessionCdpRouterError["code"],
    message: string,
    options?: ErrorOptions & { readonly unsent?: boolean; readonly answerTooLarge?: boolean },
  ) {
    super(message, options);
    this.name = "SessionCdpRouterError";
    this.code = code;
    this.unsent = options?.unsent === true;
    this.answerTooLarge = options?.answerTooLarge === true;
  }
}

interface AttachedChannel {
  readonly channel: CdpChannel;
  /** Rejects once the router ends the session, answering every command still waiting on it. */
  readonly pending: Set<(reason: unknown) => void>;
  readonly ended: AbortController;
  readonly physicalTargetId: string;
  /** Whether this channel operates under a connected agent's authority (state.connection || command.connection). */
  readonly connection: boolean;
  /** Whether this channel's virtualSessionId has been announced/returned to the caller (S6). */
  announced: boolean;
  removeListener: () => void;
  pageEnabled: boolean;
  agentRuntimeEnabled: boolean;
  internalRuntimeEnabled: boolean;
  /** Underlying `Runtime.enable` send reused across retries after a bounded wait times out (S9). */
  runtimeEnableSent?: Promise<unknown>;
  /** Underlying error when `Runtime.enable` rejected and ended the channel (Q1). */
  runtimeEnableFailure?: unknown;
  internalRuntimeEnable?: Promise<void>;
  readonly rootAttached?: boolean;
  readonly rootAlias?: TargetRoot;
  readonly parentSessionId?: string;
  readonly childClaim?: TargetClaim;
  readonly extensionIsolation?: ConnectionExtensionIsolation;
  readonly virtualSessionId: string;
}

interface TargetClaim {
  readonly sessionId: string;
  parentId?: string;
  scriptParentId?: string;
  creatorAttachmentId?: string;
  exclusiveOwner?: ConnectionState;
  channelReferences?: number;
}

interface DiscoveryReplay {
  readonly events: { method: string; parameters: CdpParameters }[];
  bytes: number;
}

interface BrowserSessionState {
  readonly connections: Set<ConnectionState>;
  readonly scripts: Map<string, ConnectionState>;
  readonly adopting: Set<string>;
  readonly exclusiveWorkers: Set<string>;
  readonly resolveTarget: (targetId: string) => Promise<boolean>;
  readonly filesRoot: string;
  readonly ownedTargetIds: Set<string>;
  readonly rootTargetId: string;
  readonly sessionId: string;
  ledgerDialogEvents: boolean;
}

interface TargetRoot {
  readonly aliasId?: string;
  autoReady: Promise<void> | undefined;
  autoAttached: Map<string, Promise<{ sessionId: string } | undefined>> | undefined;
  discoverTargets: boolean;
  discoveryFilter?: readonly { readonly type?: string; readonly exclude?: boolean }[];
  discoveryReplay: DiscoveryReplay | undefined;
  readonly discoveredTargets: Set<string>;
}

function targetRoot(discoverTargets: boolean, aliasId?: string): TargetRoot {
  return {
    ...(aliasId ? { aliasId } : {}),
    autoAttached: undefined,
    autoReady: undefined,
    discoverTargets,
    discoveryReplay: undefined,
    discoveredTargets: new Set(),
  };
}

interface ConnectionState extends TargetRoot {
  readonly session: BrowserSessionState;
  /** Work under a connected agent's authority, settled when the connection was opened. */
  readonly connection: boolean;
  readonly standard?: StandardCdpAttachmentOptions;
  readonly lineagePages?: Set<string>;
  /**
   * Pages of this lineage the runtime put to sleep: their target ended, the tab did not. Each
   * leaves when the runtime wakes that tab (and the woken target takes its place) or closes it.
   */
  readonly asleepLineage?: Set<string>;
  readonly script?: {
    id: string;
    root: string;
    eventBudget: JsonSizeBudget;
    closing: boolean;
    active: Set<Promise<unknown>>;
  };
  readonly physicalWork: Set<Promise<unknown>>;
  readonly settlement: { readonly promise: Promise<void>; readonly resolve: () => void };
  readonly closed: AbortController;
  readonly pending: Set<(reason: unknown) => void>;
  pendingBytes: number;
  pendingCount: number;
  readonly channels: Map<string, AttachedChannel>;
  readonly retiredTargets: Map<string, string>;
  /** Target IDs hidden from this connection (an extension's): never in `shownTargets` at once (S4, G1). */
  readonly hiddenTargets: Set<string>;
  /**
   * For a connection: target IDs this state has projected as visible to it (an event's or a
   * reply's `targetInfo`). A terminal event without `targetInfo` reaches a connection only for
   * one of these, its script's root, or a target one of its own channels is on (M1).
   */
  readonly shownTargets: Set<string>;
  readonly aliases: Map<string, TargetRoot>;
  readonly eventListeners: Set<(event: CdpEvent) => void>;
  nextSequence: number;
}

/** On a session's root, the browser's and the profile's own domains, which need no page (G6). */
const sessionRootDomains =
  /^(?:Browser|SystemInfo|Storage|Extensions|Tracing|IO|Tethering|Memory)\./u;

const standardJsonBudget = { maxBytes: Infinity, maxDepth: 32, maxEntries: 16_384 };

/** Whether any string in a (bounded) CDP value is an extension's address. */
function mentionsExtensionUrl(value: unknown, depth: number): boolean {
  if (typeof value === "string") return isExtensionUrl(value);
  if (depth > 16 || value === null || typeof value !== "object") return false;
  for (const entry of Array.isArray(value) ? value : Object.values(value))
    if (mentionsExtensionUrl(entry, depth + 1)) return true;
  return false;
}

const defaultLimits: SessionCdpRouterLimits = {
  maxCommandBytes: 432 * 1_024,
  maxEventBytes: 432 * 1_024,
  maxResultBytes: 432 * 1_024,
  internalRuntimeEnableTimeoutMs: 5_000,
};

const browserRootLimit = standardCdpAnswerMaxBytes;
const maxRetiredTargets = 256;

function readTargetFilter(value: unknown): ConnectionState["discoveryFilter"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64)
    throw new SessionCdpRouterError("bad_command", "Invalid CDP target filter.");
  return value.map((entry: unknown) => {
    const filter = asRecord(entry);
    const { type, exclude } = filter;
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      (type !== undefined && typeof type !== "string") ||
      (exclude !== undefined && typeof exclude !== "boolean")
    )
      throw new SessionCdpRouterError("bad_command", "Invalid CDP target filter.");
    return {
      ...(type === undefined ? {} : { type }),
      ...(exclude === undefined ? {} : { exclude }),
    };
  });
}

function targetMatchesFilter(
  info: CdpParameters,
  filter: ConnectionState["discoveryFilter"],
): boolean {
  if (!filter) return info.type !== "browser" && info.type !== "tab";
  const match = filter.find((entry) => entry.type === undefined || entry.type === info.type);
  return match !== undefined && !match.exclude;
}

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
  readonly #connectionTargetCounts = new Map<string, number>();
  readonly #workByTarget = new Map<string, Set<Promise<unknown>>>();
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
    this.#assertTargetAvailable(rootTargetId);
    if (this.#ownerByTargetId.has(rootTargetId)) {
      throw new SessionCdpRouterError("conflict", "Root target already belongs to a session.");
    }
    const session: BrowserSessionState = {
      resolveTarget,
      connections: new Set(),
      scripts: new Map(),
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

  /**
   * Ends a session's routing. `abandon` gives up the targets' claim of work still in flight, for
   * a session whose channel was lost while its pages are kept: that work's outcome is already
   * unknown to its sender, its replies reach no connection, and the same session may register
   * the targets again at once.
   */
  async unregisterSession(sessionId: string, confirm = false, abandon = false): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    this.#sessions.delete(sessionId);
    const connections = [...state.session.connections];
    for (const connection of connections) this.#closeConnection(connection);
    for (const targetId of state.session.ownedTargetIds) {
      this.#ownerByTargetId.delete(targetId);
      if (abandon) this.#workByTarget.delete(targetId);
    }
    if (confirm) await Promise.all(connections.map((connection) => connection.settlement.promise));
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
    if (options.lineage) this.#assertOwnedTarget(session, options.lineage.seedTargetId);
    const state = this.#openConnection(session.session, options);
    if (options.wholeContext) this.#exclusive = state;
    return {
      signal: state.closed.signal,
      settled: state.settlement.promise,
      send: (command, beforeActivity) => this.#send(state, command, beforeActivity),
      onEvent: (listener) => this.#observe(state, listener),
      attachedTargetId: (id) => this.#attachedTargetId(state, id),
      close: () => this.#closeConnection(state),
    };
  }

  #openConnection(
    session: BrowserSessionState,
    standard?: StandardCdpAttachmentOptions,
    script?: ConnectionState["script"],
    connection = standard?.connection === true,
  ): ConnectionState {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const state: ConnectionState = {
      session,
      connection,
      ...(standard ? { standard } : {}),
      ...(standard?.lineage
        ? { lineagePages: new Set([standard.lineage.seedTargetId]), asleepLineage: new Set() }
        : {}),
      ...(script ? { script } : {}),
      physicalWork: new Set(),
      settlement: { promise, resolve },
      closed: new AbortController(),
      pending: new Set(),
      pendingBytes: 0,
      pendingCount: 0,
      channels: new Map(),
      retiredTargets: new Map(),
      hiddenTargets: new Set(),
      shownTargets: new Set(),
      aliases: new Map(),
      ...targetRoot(standard === undefined),
      eventListeners: new Set(),
      nextSequence: 1,
    };
    session.connections.add(state);
    if (connection) {
      if (state.lineagePages)
        for (const targetId of state.lineagePages) this.#retainConnectionTarget(targetId);
      if (state.script) this.#retainConnectionTarget(state.script.root);
    }
    return state;
  }

  #retainConnectionTarget(targetId: string): void {
    const next = (this.#connectionTargetCounts.get(targetId) ?? 0) + 1;
    this.#connectionTargetCounts.set(targetId, next);
    if (next === 1) this.#backend.setConnectionControlled?.(targetId, true);
  }

  #releaseConnectionTarget(targetId: string): void {
    const count = this.#connectionTargetCounts.get(targetId);
    if (!count) return;
    if (count === 1) {
      this.#connectionTargetCounts.delete(targetId);
      this.#backend.setConnectionControlled?.(targetId, false);
    } else {
      this.#connectionTargetCounts.set(targetId, count - 1);
    }
  }

  #closeConnection(state: ConnectionState): void {
    if (state.closed.signal.aborted) return;
    const error = new SessionCdpRouterError("not_found", "CDP connection closed.");
    state.closed.abort(error);
    rejectPending(state.pending, error);
    state.session.connections.delete(state);
    if (state.script) {
      state.session.scripts.delete(state.script.id);
      if (state.connection) this.#releaseConnectionTarget(state.script.root);
    }
    if (state.connection && state.lineagePages) {
      for (const targetId of state.lineagePages) this.#releaseConnectionTarget(targetId);
      state.lineagePages.clear();
    }
    state.autoAttached = undefined;
    state.autoReady = undefined;
    state.discoveryReplay = undefined;
    state.discoveredTargets.clear();
    state.shownTargets.clear();
    state.hiddenTargets.clear();
    state.eventListeners.clear();
    for (const aliasId of state.aliases.keys()) this.#detachRootAlias(state, aliasId);
    state.retiredTargets.clear();
    for (const attached of state.channels.values()) void this.#endChannel(state, attached);
    if (this.#exclusive === state) {
      for (const targetId of state.session.exclusiveWorkers) this.#releaseTarget(targetId);
    }
    const release = () => {
      if (this.#exclusive === state) this.#exclusive = undefined;
      state.settlement.resolve();
    };
    if (state.physicalWork.size) void Promise.allSettled(state.physicalWork).then(release);
    else release();
  }

  #trackPhysicalWork<T>(state: ConnectionState, start: () => Promise<T>): Promise<T> {
    return trackPromise(state.physicalWork, start);
  }

  /**
   * This Home's addresses, from the attach ticket or a route change: the browser's state (G1).
   * Settles once the browser refuses them.
   */
  async setHomeAddresses(home: ThisHomeAddresses): Promise<void> {
    await this.#backend.setHomeAddresses?.(new ThisHomeAddressSet(home));
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
  releaseTarget(sessionId: string, targetId: string, asleep = false): void {
    // A page the runtime puts to sleep keeps its place in each lineage that holds it, for its own
    // wake to take over; any other release (a close, a failed wake) ends that place.
    for (const connection of this.#sessions.get(sessionId)?.session.connections ?? []) {
      if (asleep && connection.lineagePages?.has(targetId)) connection.asleepLineage?.add(targetId);
      else if (!asleep) connection.asleepLineage?.delete(targetId);
    }
    if (this.#ownerByTargetId.get(targetId)?.sessionId === sessionId) this.#releaseTarget(targetId);
  }

  /**
   * `woke` is given only by the runtime's own wake of a tab it put to sleep, from its own record of
   * that tab: `from` is the slept target, `itself` whether the tab itself woke (not a fresh page
   * opened at its address). Then the woken target takes the slept one's place in each lineage that
   * held it. Nothing a page can set decides this.
   */
  claimTarget(
    sessionId: string,
    targetId: string,
    openerId?: string,
    woke?: { readonly from: string; readonly itself: boolean },
  ): string | undefined {
    this.#assertOpen();
    assertIdentifier(targetId, "CDP target ID");
    const state = this.#requireSession(sessionId);
    return this.#claimTarget(state, targetId, undefined, true, openerId, woke).creatorAttachmentId;
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

  openScriptAttachment(
    sessionId: string,
    id: string,
    root: string,
    eventBudget: JsonSizeBudget,
    onEvent: (event: CdpEvent) => void,
    options: { readonly connection?: boolean } = {},
  ): void {
    const session = this.#requireSession(sessionId);
    this.#assertOwnedTarget(session, root);
    if (session.session.scripts.has(id))
      throw new SessionCdpRouterError("conflict", "Browser script attachment already exists.");
    if (session.session.scripts.size >= 128)
      throw new SessionCdpRouterError("too_large", "Too many browser script attachments.", {
        unsent: true,
      });
    const state = this.#openConnection(
      session.session,
      undefined,
      { id, root, eventBudget, closing: false, active: new Set() },
      options.connection === true,
    );
    session.session.scripts.set(id, state);
    this.#observe(state, onEvent);
  }

  async closeScriptAttachment(
    sessionId: string,
    id: string,
    cleanup: Promise<unknown>,
  ): Promise<void> {
    const state = this.#sessions.get(sessionId)?.session.scripts.get(id);
    if (!state?.script || state.script.closing) return;
    state.script.closing = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([cleanup, ...state.script.active]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      this.#closeConnection(state);
    }
  }

  assertScriptTarget(sessionId: string, attachmentId: string, targetId?: string): void {
    const state = this.#commandState(sessionId, attachmentId);
    if (targetId !== undefined) this.#assertOwnedTarget(state, targetId);
  }

  #commandState(sessionId: string, attachmentId?: string): ConnectionState {
    const state = this.#requireSession(sessionId);
    if (!attachmentId) return state;
    const script = state.session.scripts.get(attachmentId);
    if (!script || script.script?.closing)
      throw new SessionCdpRouterError("not_found", "Browser script attachment ended.", {
        unsent: true,
      });
    return script;
  }

  /** The page an agent's attached CDP session drives, or null when it is not attached here. */
  attachedTargetId(sessionId: string, cdpSessionId: string, attachmentId?: string): string | null {
    const state = this.#sessions.get(sessionId);
    return this.#attachedTargetId(
      attachmentId ? state?.session.scripts.get(attachmentId) : state,
      cdpSessionId,
    );
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
    const state = this.#commandState(sessionId, command.scriptAttachmentId);
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
    const state = this.#commandState(sessionId, command.scriptAttachmentId);
    validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    return this.#admitAttachedCommand(state, command).ended.signal;
  }

  /** Refuses exactly what `send` would refuse of a result the caller produced itself. */
  admitPageResult(result: unknown, budget?: JsonSizeBudget): void {
    this.#assertResultSize(result, this.#limits.maxResultBytes, budget);
  }

  #assertResultSize(result: unknown, maxResultBytes: number, budget?: JsonSizeBudget): void {
    const tooLarge = budget
      ? boundedJsonSize(result, {
          ...budget,
          maxBytes: Math.min(maxResultBytes, budget.maxBytes),
        }) === undefined
      : serializedBytes(result) > maxResultBytes;
    if (tooLarge)
      throw new SessionCdpRouterError(
        "too_large",
        answerTooLargeMessage(
          result,
          Math.min(maxResultBytes, budget?.maxBytes ?? Infinity),
          budget ?? standardJsonBudget,
        ),
        { answerTooLarge: true },
      );
  }

  /**
   * Refuses exactly what `send` would refuse of an agent's
   * `Target.createTarget`, without sending it, for a tab the caller opens
   * blank and then loads at `url` itself.
   */
  admitCreateTarget(sessionId: string, command: CdpCommand): void {
    this.#assertOpen();
    const state = this.#commandState(sessionId, command.scriptAttachmentId);
    validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    assertSafeNavigationUrl(
      command.parameters?.url,
      true,
      true,
      !state.connection && command.connection !== true,
    );
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
    return this.#send(
      this.#commandState(sessionId, command.scriptAttachmentId),
      command,
      beforeActivity,
    );
  }

  async #send(
    state: ConnectionState,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
  ): Promise<unknown> {
    this.#assertOpen();
    state.closed.signal.throwIfAborted();
    const bytes = validateCommand(command, this.#sessionLimits(state).maxCommandBytes);
    if (state.script) {
      const operation = this.#dispatch(state, command, beforeActivity);
      state.script.active.add(operation);
      try {
        return await operation;
      } finally {
        state.script.active.delete(operation);
      }
    }
    if (!state.standard) return this.#dispatch(state, command, beforeActivity);
    if (
      state.pendingBytes + bytes > standardCdpBufferedMaxBytes ||
      state.pendingCount >= standardCdpMaxPending
    )
      throw new SessionCdpRouterError(
        "too_large",
        "CDP connection has too many commands in flight.",
        { unsent: true },
      );
    state.pendingBytes += bytes;
    state.pendingCount++;
    try {
      const alias = command.sessionId ? state.aliases.get(command.sessionId) : undefined;
      return await whileOpen(state.pending, () =>
        this.#trackPhysicalWork(state, async () => {
          const result = await this.#dispatch(state, command, beforeActivity, alias);
          if (alias?.aliasId && !state.aliases.has(alias.aliasId))
            throw new SessionCdpRouterError("not_found", "Browser CDP session detached.");
          return result;
        }),
      );
    } finally {
      state.pendingBytes -= bytes;
      state.pendingCount--;
    }
  }

  async #dispatch(
    state: ConnectionState,
    command: CdpCommand,
    beforeActivity?: (targetId: string) => void,
    alias?: TargetRoot,
  ): Promise<unknown> {
    if (alias) {
      const { sessionId: _aliasId, ...rootCommand } = command;
      command = rootCommand;
    }
    this.#assertScope(
      state,
      command.parameters ?? {},
      command.method === "Target.detachFromTarget",
      command.method,
    );
    this.#assertAllowed(state, command);
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
    // A command that needs a page names a page session (G6): neither a script nor a Run's relay on
    // the session's root has its root command run in whatever page a browser would pick (Electron's
    // first page: the person's own tab, or another task's). On a session's root the browser's and
    // the profile's own domains go without one; a script keeps its narrower list.
    if (
      !state.standard &&
      !command.sessionId &&
      !command.method.startsWith("Target.") &&
      command.method !== "Browser.getVersion" &&
      (state.script
        ? !(this.#backend.dedicatedContext && contextScopedCdpMethods.has(command.method))
        : !sessionRootDomains.test(command.method))
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "CDP command is outside this browser attachment.",
      );
    if (
      [
        "Browser.close",
        "Browser.crash",
        "Browser.crashGpuProcess",
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
        state.connection
          ? connectionMethodRefusal(command.method)
          : `${command.method} would reach the shared browser engine or runtime control channel.`,
      );
    if (
      command.method === "Target.attachToBrowserTarget" &&
      (!state.standard || command.sessionId || alias)
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "Open a browser CDP session from the connection root.",
      );

    if (state.standard) {
      if (command.sessionId && !state.channels.has(command.sessionId))
        throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
          unsent: true,
        });
      if (command.method === "Opensteer.fillLogin" || command.method === "Opensteer.fillCard")
        throw new SessionCdpRouterError(
          "forbidden",
          state.connection
            ? connectionMethodRefusal(command.method)
            : "Saved login and card fills use browser_use on the personal hosting Mac. Open the approved tab there and call page.cdp.",
        );
      const pageCookieRead = this.#pageCookieRead(state, command);
      if (contextScopedCdpMethods.has(command.method) && !pageCookieRead) {
        if (!state.standard.wholeContext)
          throw new SessionCdpRouterError(
            "forbidden",
            state.connection
              ? connectionMethodRefusal(command.method)
              : `${command.method} requires a whole browser context grant.`,
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
            state.connection
              ? connectionMethodRefusal(command.method)
              : "Remote CDP cannot configure browser download destinations.",
          );
        }
        if (command.method === "Browser.cancelDownload")
          throw new SessionCdpRouterError(
            "forbidden",
            state.connection
              ? connectionMethodRefusal(command.method)
              : "Remote CDP does not manage browser downloads.",
          );
        const result = await this.#backend.send(command.method, command.parameters);
        this.#assertResultSize(
          result,
          this.#sessionLimits(state).maxResultBytes,
          command.replyBudget ?? standardJsonBudget,
        );
        return result;
      }
      if (
        command.sessionId
          ? !pageCookieRead && !standardCdpPageMethods.has(command.method)
          : !standardRootTargets.has(command.method) && command.method !== "Browser.getVersion"
      )
        throw new SessionCdpRouterError(
          "forbidden",
          state.connection
            ? connectionMethodRefusal(command.method)
            : `${command.method} cannot be scoped to this CDP attachment.`,
        );
    } else {
      if (command.method === "Browser.setDownloadBehavior")
        throw new SessionCdpRouterError(
          "forbidden",
          state.connection
            ? connectionMethodRefusal(command.method)
            : "Remote CDP cannot configure browser download destinations.",
        );
      if (command.method === "Browser.cancelDownload")
        throw new SessionCdpRouterError(
          "forbidden",
          state.connection
            ? connectionMethodRefusal(command.method)
            : "Remote CDP does not manage browser downloads.",
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
    // Extensions belong to the profile's browser, so a page's session reaches
    // them as the browser target does.
    const result = command.method.startsWith("Extensions.")
      ? await this.#sendExtensionsCommand(state, command)
      : targetRouting
        ? await this.#sendTargetCommand(state, command, alias)
        : command.sessionId
          ? await this.#sendAttachedCommand(state, command, beforeActivity)
          : command.method.startsWith("Target.")
            ? await this.#sendTargetCommand(state, command, alias)
            : await this.#backend.send(command.method, command.parameters);
    this.#assertResultSize(
      result,
      this.#sessionLimits(state).maxResultBytes,
      command.replyBudget ?? (state.standard ? standardJsonBudget : undefined),
    );
    return result;
  }

  #sendExtensionsCommand(state: ConnectionState, command: CdpCommand): Promise<unknown> {
    if (state.connection || command.connection === true)
      throw new SessionCdpRouterError("forbidden", connectionMethodRefusal(command.method));
    if (
      isExtensionMutationCommand(command.method, command.parameters) &&
      command.manageExtensions !== true
    )
      throw new SessionCdpRouterError("forbidden", extensionManagementRefusal);
    if (command.parameters) this.#assertScope(state, command.parameters);
    let parameters = command.parameters;
    let attachedTargetId: string | undefined;
    if (command.sessionId !== undefined) {
      const attached = this.#admitAttachedCommand(state, command);
      attachedTargetId = attached.physicalTargetId;
    }
    if (command.method === "Extensions.triggerAction") {
      if (parameters?.targetId !== undefined) {
        if (typeof parameters.targetId !== "string" || !parameters.targetId) {
          throw new SessionCdpRouterError(
            "bad_command",
            "Extensions.triggerAction targetId must be a non-empty string.",
          );
        }
      } else {
        const defaultTargetId =
          attachedTargetId ?? state.script?.root ?? state.session.rootTargetId;
        if (!defaultTargetId || !this.#canReach(state, defaultTargetId)) {
          throw new SessionCdpRouterError(
            "not_found",
            "No Browser Session tab is available for Extensions.triggerAction.",
          );
        }
        parameters = { ...parameters, targetId: defaultTargetId };
      }
    }
    if (!this.#backend.extensions)
      throw new SessionCdpRouterError(
        "bad_command",
        "This browser keeps no extensions: they live in the desktop app's saved profiles.",
      );
    return this.#backend.send(command.method, parameters);
  }

  async #sendTargetCommand(
    state: ConnectionState,
    command: CdpCommand,
    root: TargetRoot = state,
  ): Promise<unknown> {
    const parameters = command.parameters ?? {};
    const connection = state.connection || command.connection === true;
    switch (command.method) {
      case "Target.attachToBrowserTarget": {
        this.#assertChannelCapacity(state);
        const sessionId = `cdp_${this.#ports.uuid()}`;
        state.aliases.set(sessionId, targetRoot(false, sessionId));
        return { sessionId };
      }
      case "Target.getTargets": {
        const response = await this.#ownedTargetInfos(state, parameters, connection);
        if (state.standard) return { targetInfos: response.targetInfos };
        // A connection's script is told only its own root, never another of its session's pages.
        if (state.connection && state.script)
          return { ...response, rootTargetId: state.script.root };
        const root = state.script?.root ?? state.session.rootTargetId;
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
        if (!attached || (root.aliasId && attached.rootAlias !== root))
          throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
            unsent: true,
          });
        const nested = decodeNestedCdpMessage(parameters.message);
        if (!nested) throw new SessionCdpRouterError("bad_command", invalidNestedMessageRefusal);
        const result = await this.#send(state, {
          method: this.#nestedMethod(state, nested.method),
          parameters: nested.params ?? {},
          ...(command.replyBudget ? { replyBudget: command.replyBudget } : {}),
          ...(command.connection ? { connection: true as const } : {}),
          ...(command.manageExtensions ? { manageExtensions: true as const } : {}),
          sessionId: virtualSessionId,
        });
        if (!root.aliasId || state.aliases.has(root.aliasId))
          this.#nestedReply(state, virtualSessionId, { id: nested.id, result }, root.aliasId);
        return {};
      }
      case "Target.getBrowserContexts":
        // A connection is told of no browser context: another profile's would be outside it.
        if (state.standard || connection) return { browserContextIds: [] };
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
        return this.#readTargetInfo(state, targetId, claim, parameters, connection);
      }
      case "Target.createTarget": {
        assertSafeNavigationUrl(parameters.url, true, true, !connection);
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
        const claim = this.#claimTarget(state, targetId, state.script?.root, !state.standard);
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
              for (const subscriber of this.#targetRoots(connection))
                if (subscriber !== root)
                  void this.#autoAttachTarget(connection, targetId, undefined, subscriber)?.catch(
                    () => undefined,
                  );
            // Adoption is a session outcome. A lost client or failed auto-attach must not close it.
            await this.#autoAttachTarget(state, targetId, undefined, root)?.catch(() => undefined);
          } catch (error) {
            if (!adopted && this.#ownerByTargetId.get(targetId) === claim) {
              await this.#closeTarget(targetId, claim, {}).catch(() => undefined);
              if (this.#ownerByTargetId.get(targetId) === claim) {
                this.#releaseTarget(targetId);
                if (state.standard.recoverUnadoptedTarget)
                  await this.#trackTargetWork(targetId, () =>
                    state.standard!.recoverUnadoptedTarget!(targetId),
                  );
              }
            }
            throw error;
          }
        }
        // S-1: a connection's own new page is shown to it by this reply.
        if (state.connection) this.#setTargetVisibility(state, targetId, true);
        return response;
      }
      case "Target.attachToTarget": {
        const targetId = requiredTargetId(parameters);
        if (state.lineagePages) this.#assertOwnedTarget(state, targetId);
        const existing = [...state.channels.values()].find(
          (channel) =>
            channel.physicalTargetId === targetId &&
            channel.channel instanceof ChildCdpChannel &&
            channel.connection === connection &&
            channel.rootAlias === (root.aliasId ? root : undefined),
        );
        if (existing) return { sessionId: existing.virtualSessionId };
        if (state.standard && root.autoAttached) {
          const attached = await this.#autoAttachTarget(state, targetId, undefined, root);
          if (attached) return attached;
          throw new SessionCdpRouterError("not_found", "The browser page is no longer attachable.");
        }
        if (state.standard) {
          const claim = this.#assertOwnedTarget(state, targetId);
          const { targetInfo } = await this.#readTargetInfo(
            state,
            targetId,
            claim,
            undefined,
            connection,
          );
          this.#assertCurrentClaim(state, targetId, claim);
          if (targetInfo.type !== "page")
            throw new SessionCdpRouterError(
              "forbidden",
              "Use its parent page to attach a child target.",
            );
          return this.#attachTarget(state, targetId, targetInfo, undefined, root, connection);
        }
        if (connection) {
          const claim = this.#assertOwnedTarget(state, targetId);
          await this.#readTargetInfo(state, targetId, claim, undefined, true);
          this.#assertCurrentClaim(state, targetId, claim);
        }
        return this.#attachTarget(state, targetId, undefined, undefined, root, connection);
      }
      case "Target.detachFromTarget": {
        const virtualSessionId = requiredString(parameters, "sessionId");
        const alias = state.aliases.get(virtualSessionId);
        if (alias) {
          if (root.aliasId)
            throw new SessionCdpRouterError(
              "forbidden",
              "CDP session belongs to another browser root.",
            );
          this.#detachRootAlias(state, virtualSessionId);
          return {};
        }
        const attached = state.channels.get(virtualSessionId);
        if (root.aliasId && attached && attached.rootAlias !== root)
          throw new SessionCdpRouterError(
            "forbidden",
            "CDP session belongs to another browser root.",
          );
        if (!attached) {
          if (state.retiredTargets.delete(virtualSessionId)) return {};
          throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
            unsent: true,
          });
        }
        // A connection that detaches a child session (an auto-attached frame or worker) itself is
        // told that it ended, as it is for its pages.
        void this.#endChannel(state, attached, attached.connection);
        return {};
      }
      case "Target.setAutoAttach": {
        if (!state.standard) break;
        if (
          typeof parameters.autoAttach !== "boolean" ||
          (parameters.autoAttach && parameters.flatten !== true) ||
          parameters.filter !== undefined
        ) {
          throw new SessionCdpRouterError(
            "bad_command",
            "Browser auto-attach supports flat page attachments without a filter.",
          );
        }
        if (parameters.autoAttach) {
          root.autoAttached ??= new Map();
          if (!root.autoReady) {
            let ready = Promise.resolve();
            for (const targetId of state.session.ownedTargetIds) {
              ready =
                this.#autoAttachTarget(state, targetId, ready, root)?.then(() => undefined) ??
                ready;
            }
            root.autoReady = ready;
          }
          const ready = root.autoReady;
          try {
            await ready;
          } catch (error) {
            if (root.autoReady === ready) root.autoReady = undefined;
            throw error;
          }
        } else {
          root.autoAttached = undefined;
          root.autoReady = undefined;
          for (const attached of state.channels.values()) {
            if (attached.rootAttached && attached.rootAlias === (root.aliasId ? root : undefined))
              void this.#endChannel(state, attached);
          }
        }
        return {};
      }
      case "Target.setDiscoverTargets": {
        const discover = parameters.discover;
        if (typeof discover !== "boolean") {
          throw new SessionCdpRouterError("bad_command", "Target discovery requires a boolean.");
        }
        const filter = state.standard && discover ? readTargetFilter(parameters.filter) : undefined;
        if (
          root.discoverTargets === discover &&
          JSON.stringify(root.discoveryFilter) === JSON.stringify(filter)
        )
          return {};
        if (filter) root.discoveryFilter = filter;
        else delete root.discoveryFilter;
        root.discoverTargets = discover;
        root.discoveredTargets.clear();
        if (!state.standard) return {};
        const replay: DiscoveryReplay | undefined = discover ? { events: [], bytes: 0 } : undefined;
        root.discoveryReplay = replay;
        if (!replay) return {};
        try {
          const { targetInfos } = await this.#ownedTargetInfos(state, {
            filter: parameters.filter,
          });
          if (root.discoveryReplay !== replay) return {};
          for (const targetInfo of targetInfos) {
            this.#publishDiscovery(state, "Target.targetCreated", { targetInfo }, root);
          }
          for (const event of replay.events) {
            this.#publishDiscovery(state, event.method, event.parameters, root);
          }
        } finally {
          if (root.discoveryReplay === replay) root.discoveryReplay = undefined;
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
    const result = await this.#trackTargetWork(targetId, () =>
      this.#backend.send("Target.closeTarget", { ...parameters, targetId }),
    );
    if (this.#ownerByTargetId.get(targetId) === claim) {
      if (asRecord(result).success !== false) this.#releaseTarget(targetId);
    } else if (this.#ownerByTargetId.has(targetId))
      throw new SessionCdpRouterError("not_found", "The target claim changed while closing.");
    return result;
  }

  async #ownedTargetInfos(
    state: ConnectionState,
    parameters?: CdpParameters,
    connection = state.connection,
  ) {
    const claims = new Map(
      [...state.session.ownedTargetIds]
        .filter((id) => this.#canReach(state, id))
        .map((id) => [id, this.#ownerByTargetId.get(id)]),
    );
    const response = asRecord(await this.#backend.send("Target.getTargets", parameters));
    state.closed.signal.throwIfAborted();
    const entries: unknown[] = Array.isArray(response.targetInfos) ? response.targetInfos : [];
    const targetInfos = entries.flatMap((entry) => {
      const target = asRecord(entry);
      const id = readString(target, "targetId");
      if (!id || !claims.has(id) || claims.get(id) !== this.#ownerByTargetId.get(id)) return [];
      const info = this.#projectTargetInfo(state, target, connection);
      return info ? [info] : [];
    });
    return { ...response, targetInfos };
  }

  async #readTargetInfo(
    state: ConnectionState,
    targetId: string,
    claim: TargetClaim,
    parameters?: CdpParameters,
    connection = state.connection,
  ) {
    const response = asRecord(
      await this.#backend.send("Target.getTargetInfo", { ...parameters, targetId }),
    );
    this.#assertCurrentClaim(state, targetId, claim);
    if (response.targetInfo === undefined && !state.standard) {
      return { ...response, targetInfo: asRecord(response.targetInfo) };
    }
    const targetInfo =
      readString(asRecord(response.targetInfo), "targetId") === targetId
        ? this.#projectTargetInfo(state, asRecord(response.targetInfo), connection)
        : undefined;
    if (!targetInfo)
      throw new SessionCdpRouterError("not_found", "The target is no longer available.");
    return { ...response, targetInfo };
  }

  #projectTargetInfo(
    state: ConnectionState,
    info: CdpParameters,
    connection = state.connection,
  ): CdpParameters | undefined {
    const targetId = readString(info, "targetId");
    if (!targetId || !this.#canReach(state, targetId)) return;
    if (connection && isExtensionUrl(info.url)) {
      // An event's or a reply's projection is where a connection learns a target is an
      // extension's: from here its id is named to this state nowhere (G2).
      if (state.connection) this.#setTargetVisibility(state, targetId, false);
      return;
    }
    const projected: Record<string, unknown> = {
      ...info,
      ...(state.standard ? { browserContextId: state.session.sessionId } : {}),
    };
    for (const key of ["openerId", "parentId"]) {
      const relatedId = readString(info, key);
      if (
        relatedId &&
        (!this.#canReach(state, relatedId) ||
          // A connection is told a related target's id only where it may be told of that target.
          (state.connection && !this.#mayName(state, relatedId)))
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
    if (state.connection) this.#confineFrameIds(state, projected);
    if (state.connection) this.#setTargetVisibility(state, targetId, true);
    return projected;
  }

  /**
   * A frame ID is told to a connection only where it is the related page's own main frame or a
   * target the connection may be told of (N4): a frame in another process (an extension's iframe
   * inside a shown page, say) is a target of its own, claimed or not; a frame the connection
   * cannot name is left out, whatever it is.
   */
  #confineFrameIds(state: ConnectionState, projected: Record<string, unknown>): void {
    for (const [key, relatedKey] of [
      ["openerFrameId", "openerId"],
      ["parentFrameId", "parentId"],
    ] as const) {
      const frameId = readString(projected, key);
      if (!frameId) continue;
      if (frameId === readString(projected, relatedKey) || this.#mayName(state, frameId)) continue;
      delete projected[key];
    }
  }

  /**
   * The one rule for what a connection state may be told of (M1, G2): a target it was shown and
   * that is not hidden from it, its script's root, or a target one of its own channels is on.
   * Terminal events, browser-level events naming a target or frame, and every target-valued
   * field of a projected `targetInfo` go through it. Every other door through which a connection
   * is given a target, frame, session, address or title is listed at `isExtensionUrl`
   * (`@opensteer/shared/extensionUrl`), with where the same rule is applied there.
   */
  #mayName(state: ConnectionState, targetId: string): boolean {
    if (state.hiddenTargets.has(targetId)) return false;
    if (state.shownTargets.has(targetId) || state.script?.root === targetId) return true;
    for (const channel of state.channels.values())
      if (channel.physicalTargetId === targetId) return true;
    return false;
  }

  /** Shown and hidden are exclusive: setting one always clears the other (G1). */
  #setTargetVisibility(state: ConnectionState, targetId: string, visible: boolean): void {
    const into = visible ? state.shownTargets : state.hiddenTargets;
    (visible ? state.hiddenTargets : state.shownTargets).delete(targetId);
    if (into.has(targetId)) return;
    if (into.size >= 4_096) {
      const oldest = into.values().next().value;
      if (oldest !== undefined) into.delete(oldest);
    }
    into.add(targetId);
  }

  #forgetTargetVisibility(state: ConnectionState, targetId: string): void {
    state.shownTargets.delete(targetId);
    state.hiddenTargets.delete(targetId);
  }

  #autoAttachTarget(
    state: ConnectionState,
    targetId: string,
    initialAfter?: Promise<void>,
    root: TargetRoot = state,
  ): Promise<{ sessionId: string } | undefined> | undefined {
    const pending = root.autoAttached;
    if (!pending || state.session.adopting.has(targetId)) return;
    const claim = this.#ownerByTargetId.get(targetId);
    if (!claim || !this.#canReach(state, targetId)) return;
    const existing = pending.get(targetId);
    if (existing) return existing;
    const explicit = [...state.channels.values()].find(
      (channel) =>
        channel.rootAttached &&
        channel.physicalTargetId === targetId &&
        channel.rootAlias === (root.aliasId ? root : undefined),
    );
    if (explicit) {
      const reply = Promise.resolve({ sessionId: explicit.virtualSessionId });
      pending.set(targetId, reply);
      return reply;
    }
    const ready = initialAfter ?? root.autoReady;
    const current = () =>
      root.autoAttached === pending &&
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
          return await this.#attachTarget(state, targetId, targetInfo, current, root);
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

  *#targetRoots(state: ConnectionState): IterableIterator<TargetRoot> {
    yield state;
    yield* state.aliases.values();
  }

  #assertChannelCapacity(state: ConnectionState): void {
    if (state.channels.size + state.aliases.size >= standardCdpMaxPending)
      throw new SessionCdpRouterError("too_large", "Too many attached CDP targets.");
  }

  #detachRootAlias(state: ConnectionState, aliasId: string): void {
    const root = state.aliases.get(aliasId);
    if (!root) return;
    state.aliases.delete(aliasId);
    root.autoAttached = undefined;
    root.autoReady = undefined;
    root.discoveryReplay = undefined;
    for (const channel of state.channels.values())
      if (channel.rootAlias === root) void this.#endChannel(state, channel);
    this.#appendEvent(state, "Target.detachedFromTarget", { sessionId: aliasId });
  }

  /** Each attachment owns its page channel and all child channels opened through it. */
  async #attachTarget(
    state: ConnectionState,
    targetId: string,
    rootInfo?: CdpParameters,
    current?: () => boolean,
    root: TargetRoot = state,
    connection = state.connection,
  ): Promise<{ sessionId: string }> {
    const assertRoot = () => {
      if (root.aliasId && !state.aliases.has(root.aliasId))
        throw new SessionCdpRouterError("not_found", "Browser CDP session detached.");
    };
    assertRoot();
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
      assertRoot();
      if (state.standard) this.#assertChannelCapacity(state);
    } catch (error) {
      const closing = channel.close().catch(() => undefined);
      if (root.aliasId) await closing;
      throw error;
    }
    const virtualSessionId = `cdp_${this.#ports.uuid()}`;
    const attached: AttachedChannel = {
      channel,
      pending: new Set(),
      ended: new AbortController(),
      physicalTargetId: targetId,
      connection,
      announced: false,
      rootAttached: rootInfo !== undefined,
      ...(root.aliasId ? { rootAlias: root } : {}),
      ...(connection
        ? {
            extensionIsolation: new ConnectionExtensionIsolation(
              `agent-world:${virtualSessionId}:`,
              { targetId },
            ),
          }
        : {}),
      removeListener: () => undefined,
      pageEnabled: false,
      agentRuntimeEnabled: false,
      internalRuntimeEnabled: false,
      virtualSessionId,
    };
    attached.removeListener = channel.onEvent((method, parameters) => {
      this.#handlePageEvent(state, attached, method, parameters);
    });
    state.channels.set(attached.virtualSessionId, attached);
    if (connection) this.#retainConnectionTarget(targetId);
    // N2 + S9: start Runtime inventory at attach WITHOUT blocking attach so dialog-blocked pages
    // still accept Page.handleJavaScriptDialog; script and ID-bearing commands wait behind it.
    if (connection && !this.#backend.allowsProfileCookieReads) {
      void this.#ensureRuntimeInventory(state, attached).catch(() => undefined);
      // S6: if Runtime.enable synchronously revealed a main-frame extension commit before attach
      // returned, refuse with the single missing-target sentence and no stray detach event.
      if (attached.extensionIsolation?.compromised || !state.channels.has(virtualSessionId)) {
        void this.#endChannel(state, attached);
        throw new SessionCdpRouterError("not_found", "The target is no longer available.");
      }
    }
    attached.announced = true;
    if (rootInfo) {
      this.#appendEvent(
        state,
        "Target.attachedToTarget",
        {
          sessionId: attached.virtualSessionId,
          targetInfo: {
            ...rootInfo,
            targetId,
            attached: true,
            browserContextId: readString(rootInfo, "browserContextId") ?? state.session.sessionId,
          },
          waitingForDebugger: false,
        },
        root.aliasId,
      );
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
    // A shared Chrome tab is one tab: a connection sees no cookie of any site in its events.
    if (
      attached.connection &&
      this.#backend.allowsProfileCookieReads &&
      (method.startsWith("Network.") || method.startsWith("Fetch."))
    ) {
      if (cookieOnlyEvents.has(method)) return;
      parameters = withoutCookieMaterial(parameters) as CdpParameters;
    }
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
        (owner && !this.#canReach(state, targetId)) ||
        (!owner && this.#workByTarget.has(targetId)) ||
        (state.standard && state.channels.size + state.aliases.size >= standardCdpMaxPending) ||
        (isWorkerShared(info.type) && (this.#exclusive !== state || attached.connection)) ||
        (attached.connection && isExtensionUrl(info.url))
      ) {
        void attached.channel
          .send("Target.detachFromTarget", { sessionId: physicalSessionId })
          .catch(() => undefined);
        return;
      }
      const childClaim = this.#claimTarget(state, targetId, attached.physicalTargetId, false);
      childClaim.channelReferences = (childClaim.channelReferences ?? 0) + 1;
      if (isWorkerShared(info.type)) {
        childClaim.exclusiveOwner = state;
        state.session.exclusiveWorkers.add(targetId);
      }
      const channel = new ChildCdpChannel(
        attached.channel,
        physicalSessionId,
        this.#backend.protectProductWorlds === true,
      );
      const childSessionId = `cdp_${this.#ports.uuid()}`;
      const child: AttachedChannel = {
        channel,
        pending: new Set(),
        ended: new AbortController(),
        physicalTargetId: targetId,
        connection: attached.connection,
        announced: true,
        childClaim,
        parentSessionId: attached.virtualSessionId,
        ...(attached.rootAlias ? { rootAlias: attached.rootAlias } : {}),
        ...(attached.connection
          ? {
              extensionIsolation: new ConnectionExtensionIsolation(
                `agent-world:${childSessionId}:`,
                { targetId, isWorker: info.type !== "iframe" },
              ),
            }
          : {}),
        virtualSessionId: childSessionId,
        pageEnabled: false,
        agentRuntimeEnabled: false,
        internalRuntimeEnabled: false,
        removeListener: () => undefined,
      };
      child.removeListener = channel.onEvent((method, params) =>
        this.#handlePageEvent(state, child, method, params),
      );
      state.channels.set(child.virtualSessionId, child);
      if (attached.connection) {
        this.#retainConnectionTarget(targetId);
        if (!this.#backend.allowsProfileCookieReads) {
          void this.#ensureRuntimeInventory(state, child).catch(() => undefined);
        }
      }
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
      void this.#endChannel(state, child);
      return;
    }
    if (attached.extensionIsolation) {
      const outcome = attached.extensionIsolation.observeEvent(method, parameters);
      if (outcome.action === "compromised") {
        this.#compromiseTargetConnections(state.session, attached.physicalTargetId);
        return;
      }
      if (outcome.action === "drop") return;
      if (!attached.agentRuntimeEnabled && method.startsWith("Runtime.")) return;
      parameters = outcome.params;
    }
    this.#appendEvent(state, method, parameters, attached.virtualSessionId);
  }

  /** History traversal follows the navigation rule: the entry's address passes `Page.navigate`'s. */
  async #assertSafeHistoryEntry(
    state: ConnectionState,
    attached: AttachedChannel,
    parameters: CdpParameters | undefined,
  ): Promise<void> {
    const entryId = parameters?.entryId;
    const claim = this.#assertOwnedTarget(state, attached.physicalTargetId);
    const { entries } = asRecord(await attached.channel.send("Page.getNavigationHistory", {})) as {
      entries?: unknown;
    };
    // The read awaited the page: the session and its target must still be the caller's.
    state.closed.signal.throwIfAborted();
    attached.ended.signal.throwIfAborted();
    if (state.channels.get(attached.virtualSessionId) !== attached)
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    this.#assertCurrentClaim(state, attached.physicalTargetId, claim);
    const entry = Array.isArray(entries)
      ? entries.find((candidate: unknown) => asRecord(candidate).id === entryId)
      : undefined;
    if (!entry) throw new SessionCdpRouterError("not_found", "No such navigation history entry.");
    assertSafeNavigationUrl(
      asRecord(entry).url,
      false,
      Boolean(state.standard || state.script),
      !attached.connection,
    );
  }

  /** Refused before any effect: see `cdp-command-refusals.ts`. */
  #assertAllowed(state: ConnectionState, command: CdpCommand): void {
    const connection = state.connection || command.connection === true;
    const refusal =
      cdpCommandRefusal(command.method, command.parameters, connection) ??
      // Where the Home said a command is a connection's, the runtime holds the standard lists
      // itself; a standard client holds them in its own admission below.
      (connection && !state.standard
        ? connectionCdpRefusal(command.method, command.parameters, command.sessionId !== undefined)
        : undefined) ??
      // For a connection the list comes first, before the backend's own scope check and every
      // later refusal, so that no other sentence (one a backend adds later included) answers a
      // command outside it. A listed command still meets those checks.
      (connection && state.standard && this.#outsideStandardLists(state, command)
        ? connectionMethodRefusal(command.method)
        : undefined);
    if (refusal) throw new SessionCdpRouterError("forbidden", refusal);
  }

  /** Whether a standard client's command is outside its lists, as its admission below reads them. */
  #outsideStandardLists(state: ConnectionState, command: CdpCommand): boolean {
    const pageCookieRead = this.#pageCookieRead(state, command);
    if (contextScopedCdpMethods.has(command.method) && !pageCookieRead)
      return state.standard?.wholeContext !== true;
    return command.sessionId
      ? !pageCookieRead && !standardCdpPageMethods.has(command.method)
      : !standardRootTargets.has(command.method) && command.method !== "Browser.getVersion";
  }

  /**
   * A page cookie read a cookie-reading backend admits: a shared tab is one tab, so a connection
   * reads only that page's own cookies, never the profile's.
   */
  #pageCookieRead(state: ConnectionState, command: CdpCommand): boolean {
    return (
      this.#backend.allowsProfileCookieReads === true &&
      command.sessionId !== undefined &&
      (state.connection
        ? command.method === "Network.getCookies" && command.parameters?.urls === undefined
        : ["Network.getCookies", "Network.getAllCookies", "Storage.getCookies"].includes(
            command.method,
          ))
    );
  }

  #admitAttachedCommand(state: ConnectionState, command: CdpCommand): AttachedChannel {
    const attached = state.channels.get(command.sessionId ?? "");
    if (!attached) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    }
    if (attached.extensionIsolation?.compromised) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    }
    if (command.connection === true && !attached.connection) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    }
    const parameters = command.parameters ?? {};
    this.#assertOwnedTarget(state, attached.physicalTargetId);
    this.#assertScope(state, parameters, false, command.method);
    this.#assertAllowed(state, command);
    if (command.method === "Page.navigate") {
      assertSafeNavigationUrl(
        parameters.url,
        false,
        Boolean(state.standard || state.script),
        !attached.connection && command.connection !== true,
      );
    }
    if (
      state.standard &&
      ["Page.navigate", "Page.createIsolatedWorld", "DOM.getFrameOwner"].includes(command.method) &&
      typeof parameters.frameId === "string" &&
      this.#ownerByTargetId.has(parameters.frameId)
    )
      this.#assertOwnedTarget(state, parameters.frameId);
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
        const maxEdge = browserFrameLimits.maxWidth * browserFrameLimits.maxDevicePixelRatio;
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
          Math.max(width, height) * Math.max(1, scale) > maxEdge ||
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

  #compromiseTargetConnections(session: BrowserSessionState, targetId: string): void {
    for (const connection of session.connections) {
      for (const attached of connection.channels.values()) {
        if (attached.physicalTargetId !== targetId) continue;
        if (attached.extensionIsolation) {
          attached.extensionIsolation.markCompromised();
          void this.#endChannel(connection, attached, true);
        }
      }
    }
  }

  async #ensureRuntimeInventory(state: ConnectionState, attached: AttachedChannel): Promise<void> {
    if (attached.internalRuntimeEnabled) return;
    if (!attached.internalRuntimeEnable) {
      const timeoutMs = this.#limits.internalRuntimeEnableTimeoutMs ?? 5_000;
      if (!attached.runtimeEnableSent) {
        const sent = attached.channel.send("Runtime.enable").then(
          () => {
            attached.internalRuntimeEnabled = true;
          },
          (error: unknown) => {
            if (attached.runtimeEnableSent === sent) delete attached.runtimeEnableSent;
            // Q1: when the underlying `Runtime.enable` rejects (not a bounded timeout), end the
            // channel so no un-held command can run without main-frame compromise detection.
            attached.runtimeEnableFailure = error;
            if (state.channels.get(attached.virtualSessionId) === attached) {
              void this.#endChannel(state, attached, true);
            }
            throw error;
          },
        );
        // Prevent unhandled rejection when a caller's bounded wait rejects before `sent` settles.
        void sent.catch(() => undefined);
        attached.runtimeEnableSent = sent;
      }
      const pendingEnable = attached.runtimeEnableSent;
      const enabling = this.#trackPhysicalWork(state, () =>
        this.#trackTargetWork(attached.physicalTargetId, async () => {
          const timeout = Promise.withResolvers<never>();
          const timer = setTimeout(() => {
            timeout.reject(
              new SessionCdpRouterError("conflict", "The page is not answering; try again.", {
                unsent: false,
              }),
            );
          }, timeoutMs);
          if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
            timer.unref();
          }
          const onAbort = () => {
            timeout.reject(
              attached.runtimeEnableFailure ??
                new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
                  unsent: true,
                }),
            );
          };
          const signals = [state.closed.signal, attached.ended.signal];
          for (const signal of signals) {
            if (signal.aborted) {
              onAbort();
              break;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          }
          try {
            await Promise.race([pendingEnable, timeout.promise]);
          } finally {
            clearTimeout(timer);
            for (const signal of signals) signal.removeEventListener("abort", onAbort);
          }
        }),
      ).finally(() => {
        if (attached.internalRuntimeEnable === enabling) delete attached.internalRuntimeEnable;
      });
      attached.internalRuntimeEnable = enabling;
    }
    await attached.internalRuntimeEnable;
    if (
      !state.channels.has(attached.virtualSessionId) ||
      attached.extensionIsolation?.compromised
    ) {
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    }
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
    const isolation = attached.extensionIsolation;
    if (isolation) {
      if (command.method === "Runtime.enable") {
        if (
          attached.internalRuntimeEnabled ||
          attached.internalRuntimeEnable ||
          attached.runtimeEnableSent
        ) {
          await this.#ensureRuntimeInventory(state, attached);
          attached.agentRuntimeEnabled = true;
          for (const event of isolation.allowedContextEvents()) {
            this.#appendEvent(
              state,
              "Runtime.executionContextCreated",
              event,
              attached.virtualSessionId,
            );
          }
          return {};
        }
        attached.agentRuntimeEnabled = true;
        attached.internalRuntimeEnabled = true;
      } else if (command.method === "Runtime.disable") {
        attached.agentRuntimeEnabled = false;
        if (attached.internalRuntimeEnabled || attached.runtimeEnableSent) return {};
      } else if (
        isolation.needsRuntimeInventory(
          command.method,
          command.parameters,
          !this.#backend.allowsProfileCookieReads,
        ) &&
        !attached.internalRuntimeEnabled
      ) {
        await this.#ensureRuntimeInventory(state, attached);
      }
    }
    let parameters = isolation
      ? isolation.assertAndRewriteCommand(command.method, command.parameters ?? {})
      : command.parameters;
    if (command.method === "Target.setAutoAttach")
      parameters = {
        ...(attached.connection || command.connection
          ? connectionAutoAttachParameters(parameters)
          : parameters),
        flatten: false,
      };
    if (command.method === "Page.navigateToHistoryEntry")
      await this.#assertSafeHistoryEntry(state, attached, parameters);
    if (
      command.method === "Target.sendMessageToTarget" ||
      command.method === "Target.detachFromTarget"
    ) {
      const child = state.channels.get(String(parameters?.sessionId));
      if (!(child?.channel instanceof ChildCdpChannel) || child.channel.parent !== attached.channel)
        throw new SessionCdpRouterError("forbidden", "CDP attachment is outside this page.");
      if (command.method === "Target.sendMessageToTarget") {
        const message = decodeNestedCdpMessage(parameters?.message);
        if (!message) throw new SessionCdpRouterError("bad_command", invalidNestedMessageRefusal);
        const result = await this.#send(
          state,
          {
            method: this.#nestedMethod(state, message.method),
            parameters: message.params ?? {},
            ...(command.replyBudget ? { replyBudget: command.replyBudget } : {}),
            ...(command.connection ? { connection: true as const } : {}),
            ...(command.manageExtensions ? { manageExtensions: true as const } : {}),
            sessionId: child.virtualSessionId,
          },
          beforeActivity,
        );
        this.#nestedReply(
          state,
          child.virtualSessionId,
          { id: message.id, result },
          attached.virtualSessionId,
        );
        return {};
      }
      void this.#endChannel(state, child);
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
    const tracked = () =>
      this.#trackPhysicalWork(state, () => this.#trackTargetWork(attached.physicalTargetId, send));
    const answered = await (command.replyBudget ? tracked() : whileOpen(attached.pending, tracked));
    return isolation ? isolation.sanitizeResult(command.method, answered) : answered;
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
      if (owner && targetId)
        for (const state of owner.session.connections) {
          if (!state.lineagePages || this.#canReach(state, targetId))
            this.#appendEvent(state, method, parameters);
          if (this.#canReach(state, targetId))
            for (const aliasId of state.aliases.keys())
              this.#appendEvent(state, method, parameters, aliasId);
        }
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
        targetId !== parentId &&
        ["page", "iframe", "worker"].includes(String(info.type))
      ) {
        const existing = this.#ownerByTargetId.get(targetId);
        if (existing?.sessionId === owner.session.sessionId) existing.scriptParentId ??= parentId;
        if (!existing && !this.#workByTarget.has(targetId))
          this.#claimTarget(
            owner,
            targetId,
            parentId,
            info.type === "page",
            info.type === "page" ? parentId : undefined,
          );
      }
    }

    const owner = this.#sessions.get(this.#ownerByTargetId.get(targetId)?.sessionId ?? "");
    if (owner) {
      for (const state of owner.session.connections)
        for (const root of this.#targetRoots(state))
          this.#discover(state, method, parameters, root);
    } else this.#trackUnclaimedPage(method, targetId, parameters);
    if (method === "Target.targetDestroyed") this.#releaseTarget(targetId);
  }

  #discover(
    state: ConnectionState,
    method: string,
    parameters: CdpParameters,
    root: TargetRoot = state,
  ): void {
    if (
      state.script &&
      method === "Target.targetDestroyed" &&
      parameters.targetId === state.script.root
    ) {
      this.#appendEvent(state, method, parameters);
      this.#closeConnection(state);
      return;
    }
    if (!root.discoverTargets) return;
    const replay = root.discoveryReplay;
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
      this.#publishDiscovery(state, method, parameters, root);
    }
  }

  #publishDiscovery(
    state: ConnectionState,
    method: string,
    parameters: CdpParameters,
    root: TargetRoot,
  ): void {
    if (state.standard) {
      const targetId =
        readString(asRecord(parameters.targetInfo), "targetId") ??
        readString(parameters, "targetId");
      if (!targetId) return;
      const seen = root.discoveredTargets;
      if (method === "Target.targetCreated") {
        if (
          seen.has(targetId) ||
          !this.#canReach(state, targetId) ||
          !targetMatchesFilter(asRecord(parameters.targetInfo), root.discoveryFilter) ||
          (state.connection && isExtensionUrl(asRecord(parameters.targetInfo).url))
        ) {
          if (
            state.connection &&
            this.#canReach(state, targetId) &&
            isExtensionUrl(asRecord(parameters.targetInfo).url)
          ) {
            this.#setTargetVisibility(state, targetId, false);
          }
          return;
        }
        seen.add(targetId);
      } else if (!seen.has(targetId)) {
        // A connection's target that was hidden when it was created (an extension page) is
        // announced when it is first shown, so it hears that target's later end.
        const info = asRecord(parameters.targetInfo);
        // A connection learns a target went to an extension's page even if it never discovered
        // it (one of its own channels may be on it), so that target is hidden from it alike.
        if (state.connection && isExtensionUrl(info.url) && this.#canReach(state, targetId)) {
          this.#setTargetVisibility(state, targetId, false);
          return;
        }
        if (
          !state.connection ||
          method !== "Target.targetInfoChanged" ||
          !state.hiddenTargets.has(targetId) ||
          isExtensionUrl(info.url) ||
          !this.#canReach(state, targetId) ||
          !targetMatchesFilter(info, root.discoveryFilter)
        )
          return;
        seen.add(targetId);
        method = "Target.targetCreated";
        parameters = { targetInfo: info };
      } else if (method === "Target.targetDestroyed") seen.delete(targetId);
    }
    this.#appendEvent(state, method, parameters, root.aliasId);
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

  #assertTargetAvailable(targetId: string): void {
    if (this.#workByTarget.has(targetId))
      throw new SessionCdpRouterError("conflict", "Previous CDP work still holds this target.");
  }

  #trackTargetWork<T>(targetId: string, start: () => Promise<T>): Promise<T> {
    let work = this.#workByTarget.get(targetId);
    if (!work) {
      work = new Set();
      this.#workByTarget.set(targetId, work);
    }
    const tracked = work;
    return trackPromise(tracked, start).finally(() => {
      // Abandoned work settling late leaves the target's newer work alone.
      if (!tracked.size && this.#workByTarget.get(targetId) === tracked)
        this.#workByTarget.delete(targetId);
    });
  }

  #claimTarget(
    state: ConnectionState,
    targetId: string,
    parentId?: string,
    attachPage = true,
    openerId?: string,
    woke?: { readonly from: string; readonly itself: boolean },
  ): TargetClaim {
    const existing = this.#ownerByTargetId.get(targetId);
    if (!existing) this.#assertTargetAvailable(targetId);
    if (existing && existing.sessionId !== state.session.sessionId)
      throw new SessionCdpRouterError("conflict", "CDP target belongs to another session.");
    const claim = existing ?? {
      sessionId: state.session.sessionId,
      ...(parentId ? { parentId, scriptParentId: parentId } : {}),
    };
    if (!parentId && state.lineagePages && state.standard?.lineage) {
      if (!state.lineagePages.has(targetId)) {
        state.lineagePages.add(targetId);
        if (state.connection) this.#retainConnectionTarget(targetId);
      }
      claim.creatorAttachmentId ??= state.standard.lineage.attachmentId;
    }
    if (openerId) {
      for (const connection of state.session.connections) {
        const lineage = connection.standard?.lineage;
        if (!lineage || !connection.lineagePages || !this.#canReach(connection, openerId)) continue;
        if (!connection.lineagePages.has(targetId)) {
          connection.lineagePages.add(targetId);
          if (connection.connection) this.#retainConnectionTarget(targetId);
        }
        claim.creatorAttachmentId ??= lineage.attachmentId;
      }
    }
    // A place kept under this id is stale unless this claim wakes from it: ids are not trusted
    // to be unique for ever.
    if (woke?.from !== targetId)
      for (const connection of state.session.connections)
        connection.asleepLineage?.delete(targetId);
    if (woke) {
      for (const connection of state.session.connections) {
        if (!connection.asleepLineage?.delete(woke.from) || !woke.itself) continue;
        if (connection.lineagePages && !connection.lineagePages.has(targetId)) {
          connection.lineagePages.add(targetId);
          if (connection.connection) this.#retainConnectionTarget(targetId);
        }
      }
    }
    if (parentId) claim.scriptParentId ??= parentId;
    if (!parentId || (openerId && claim.creatorAttachmentId)) delete claim.parentId;
    this.#ownerByTargetId.set(targetId, claim);
    state.session.ownedTargetIds.add(targetId);
    const announced = this.#unclaimedPages.get(targetId);
    this.#unclaimedPages.delete(targetId);
    for (const connection of state.session.connections) {
      for (const root of this.#targetRoots(connection)) {
        if (announced)
          this.#discover(connection, "Target.targetCreated", { targetInfo: announced }, root);
        if (attachPage)
          void this.#autoAttachTarget(connection, targetId, undefined, root)?.catch(
            () => undefined,
          );
      }
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
      if (connection.script?.root === targetId)
        this.#discover(connection, "Target.targetDestroyed", { targetId });
      for (const root of this.#targetRoots(connection)) {
        if (connection.standard && root.discoveredTargets.has(targetId))
          this.#discover(connection, "Target.targetDestroyed", { targetId }, root);
        root.autoAttached?.delete(targetId);
      }
      for (const attached of connection.channels.values()) {
        if (attached.physicalTargetId === targetId) {
          const retired = connection.retiredTargets;
          retired.set(attached.virtualSessionId, targetId);
          if (retired.size > maxRetiredTargets) {
            const oldest = retired.keys().next().value;
            if (oldest !== undefined) retired.delete(oldest);
          }
          // A connection's auto-attached child whose target the browser ended before its page
          // said so is told now: the page's own detach then finds no child, so it is told once.
          void this.#endChannel(
            connection,
            attached,
            attached.connection && attached.parentSessionId !== undefined,
          );
        }
      }
      if (connection.lineagePages?.delete(targetId) && connection.connection) {
        this.#releaseConnectionTarget(targetId);
      }
      if (connection.script?.root === targetId) this.#closeConnection(connection);
    }
    for (const childId of state.session.ownedTargetIds)
      if (this.#ownerByTargetId.get(childId)?.parentId === targetId) this.#releaseTarget(childId);
  }

  /**
   * Ends one agent page session here at once. Its channel finishes closing on
   * its own: a backend can need the page to answer first, and a page under a
   * JavaScript dialog answers nothing until the dialog closes.
   */
  #endChannel(
    state: ConnectionState,
    attached: AttachedChannel,
    forceDetachEvent = false,
  ): Promise<void> | undefined {
    if (state.channels.get(attached.virtualSessionId) !== attached) return;
    state.channels.delete(attached.virtualSessionId);
    if (attached.connection) this.#releaseConnectionTarget(attached.physicalTargetId);
    if (attached.rootAttached || state.script || forceDetachEvent) {
      (attached.rootAlias ?? state).autoAttached?.delete(attached.physicalTargetId);
      if (attached.announced) {
        this.#appendEvent(
          state,
          "Target.detachedFromTarget",
          {
            sessionId: attached.virtualSessionId,
            targetId: attached.physicalTargetId,
          },
          attached.parentSessionId ?? attached.rootAlias?.aliasId,
        );
      }
    }
    const descendants: Promise<void>[] = [];
    for (const child of state.channels.values()) {
      if (child.channel instanceof ChildCdpChannel && child.channel.parent === attached.channel) {
        const closing = this.#endChannel(state, child);
        if (closing) descendants.push(closing);
      }
    }
    attached.removeListener();
    const ended = new SessionCdpRouterError(
      "not_found",
      "The CDP session ended before the page answered.",
    );
    rejectPending(attached.pending, ended);
    attached.ended.abort(ended);
    const close = () =>
      attached.channel
        .close()
        .catch((error: unknown) => console.error("CDP channel cleanup failed", error));
    const work = this.#workByTarget.get(attached.physicalTargetId);
    const closure = this.#trackPhysicalWork(state, () =>
      (state.standard || state.script) && (work?.size || descendants.length)
        ? Promise.allSettled([...descendants, ...(work ?? [])]).then(close)
        : close(),
    );
    const claim = attached.childClaim;
    if (
      claim &&
      this.#ownerByTargetId.get(attached.physicalTargetId) === claim &&
      claim.channelReferences !== undefined &&
      --claim.channelReferences === 0
    )
      this.#releaseTarget(attached.physicalTargetId);
    return closure;
  }

  #appendEvent(
    state: ConnectionState,
    method: string,
    parameters: CdpParameters,
    sessionId?: string,
  ): void {
    if (state.script?.closing) return;
    if (
      state.script &&
      !sessionId &&
      method !== "Target.detachedFromTarget" &&
      method !== "Target.receivedMessageFromTarget" &&
      // The durable close fence has already released the claim for this terminal event.
      !(method === "Target.targetDestroyed" && parameters.targetId === state.script.root)
    ) {
      const id =
        readString(asRecord(parameters.targetInfo), "targetId") ??
        readString(parameters, "targetId");
      if (!id || !this.#canReach(state, id)) return;
    }
    if (
      state.script &&
      boundedJsonSize({ method, parameters, sessionId }, state.script.eventBudget) === undefined
    )
      return;
    if (method.startsWith("Target.")) {
      if (parameters.targetInfo !== undefined) {
        const connection =
          state.connection ||
          (sessionId !== undefined && state.channels.get(sessionId)?.connection === true);
        const rawInfo = asRecord(parameters.targetInfo);
        const info = this.#projectTargetInfo(state, rawInfo, connection);
        if (!info) {
          // A state that is not a connection's hides only what a connection's channel on it was
          // shown in an event, as before.
          const hiddenId = readString(rawInfo, "targetId");
          if (!state.connection && connection && hiddenId && isExtensionUrl(rawInfo.url))
            this.#setTargetVisibility(state, hiddenId, false);
          return;
        }
        parameters = { ...parameters, targetInfo: info };
      } else {
        const targetId = readString(parameters, "targetId");
        // A target this connection was told is an extension's stays hidden for its terminal
        // events too. That holds for a script's own root the router has hidden (its address
        // became a `chrome-extension:` page): its own `Target.targetDestroyed` and its channels'
        // `Target.detachedFromTarget` naming it are dropped here, as they were before the
        // allow-list below; the root's destroy still closes the attachment (`#discover`), so its
        // later commands answer as a missing session.
        // It stays hidden through its destroy: its channels' detaches, which follow, are dropped
        // as well (E1). The bounded set and the connection's close forget it.
        if (targetId && state.hiddenTargets.has(targetId)) return;
        if (
          state.connection &&
          targetId &&
          (method === "Target.targetDestroyed" || method === "Target.targetCrashed")
        ) {
          // M1: an allow-list, not a deny-list. A target claimed under this connection's pages
          // before it was opened was never projected to it, so its end is not this
          // connection's to hear unless it was shown, is its root, or one of its channels is on it.
          if (!this.#mayName(state, targetId)) return;
          if (method === "Target.targetDestroyed") this.#forgetTargetVisibility(state, targetId);
        }
      }
    } else if (
      state.connection &&
      (sessionId === undefined || state.aliases.has(sessionId)) &&
      !this.#connectionMayHearBrowserEvent(state, parameters)
    )
      return;
    const event: CdpEvent = {
      method,
      parameters,
      sequence: state.nextSequence++,
      ...(state.script ? { scriptAttachmentId: state.script.id } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    const maxBytes = this.#sessionLimits(state).maxEventBytes;
    const budget = state.script?.eventBudget ?? (state.standard ? standardJsonBudget : undefined);
    const tooLarge = budget
      ? boundedJsonSize(event, { ...budget, maxBytes: Math.min(maxBytes, budget.maxBytes) }) ===
        undefined
      : serializedBytes(event) > maxBytes;
    if (tooLarge) {
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

  /**
   * A browser-level event (not `Target.*`, outside any page session) that names a target or a
   * frame reaches a connection only when it may be told of that target, and never with an
   * extension's address in it (G2).
   */
  #connectionMayHearBrowserEvent(state: ConnectionState, parameters: CdpParameters): boolean {
    const subject = readString(parameters, "targetId") ?? readString(parameters, "frameId");
    if (subject !== null && !this.#mayName(state, subject)) return false;
    return !mentionsExtensionUrl(parameters, 0);
  }

  #nestedMethod(state: ConnectionState, method: string): string {
    if (state.script && method === "Page.captureScreenshot")
      throw new SessionCdpRouterError("bad_command", "Capture a screenshot on an attached page.");
    return method;
  }

  #nestedReply(
    state: ConnectionState,
    childId: string,
    reply: CdpParameters,
    sessionId?: string,
  ): void {
    const envelope = {
      method: "Target.receivedMessageFromTarget",
      parameters: { sessionId: childId, message: "" },
      sequence: state.nextSequence,
      scriptAttachmentId: state.script?.id,
      sessionId,
    };
    if (state.script) {
      const budget = state.script.eventBudget;
      const limit = Math.min(budget.maxBytes, this.#sessionLimits(state).maxEventBytes);
      const overhead = boundedJsonSize(envelope, { ...budget, maxBytes: limit });
      this.#assertResultSize(reply, Math.floor((limit - (overhead ?? limit)) / 2), budget);
    }
    this.#appendEvent(
      state,
      envelope.method,
      { ...envelope.parameters, message: JSON.stringify(reply) },
      sessionId,
    );
  }

  #assertScope(
    state: ConnectionState,
    parameters: CdpParameters,
    allowAlias = false,
    method?: string,
  ): void {
    for (const key of ["targetId", "openerId"]) {
      const target = parameters[key];
      if (typeof target === "string") this.#assertOwnedTarget(state, target);
    }
    // Page.screencastFrameAck names a numeric screencast frame sessionId, not a
    // CDP target attachment session.
    const isScreencastAck =
      method === "Page.screencastFrameAck" && typeof parameters.sessionId === "number";
    // Browser contexts are checked and supplied by the profile-owned backend.
    if (
      parameters.sessionId !== undefined &&
      !isScreencastAck &&
      !state.channels.has(String(parameters.sessionId)) &&
      !state.retiredTargets.has(String(parameters.sessionId)) &&
      !(allowAlias && state.aliases.has(String(parameters.sessionId)))
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "CDP attachment is outside this Browser Session.",
      );
  }

  #canReach(state: ConnectionState, targetId: string): boolean {
    for (let id: string | undefined = targetId, hops = 0; id && hops < 128; hops++) {
      const claim = this.#ownerByTargetId.get(id);
      if (
        claim?.sessionId !== state.session.sessionId ||
        (claim.exclusiveOwner && claim.exclusiveOwner !== state)
      )
        return false;
      if (state.lineagePages) {
        if (state.lineagePages.has(id)) return true;
        id = claim.parentId;
        continue;
      }
      if (!state.script || id === state.script.root) return true;
      id = claim.scriptParentId;
    }
    return false;
  }

  #assertOwnedTarget(state: ConnectionState, targetId: string): TargetClaim {
    const claim = this.#ownerByTargetId.get(targetId);
    if (!claim || !this.#canReach(state, targetId))
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

function trackPromise<T>(work: Set<Promise<unknown>>, start: () => Promise<T>): Promise<T> {
  let dispatch!: () => void;
  const operation = new Promise<T>((resolve, reject) => {
    dispatch = () => {
      try {
        resolve(start());
      } catch (error) {
        reject(error);
      }
    };
  });
  work.add(operation);
  dispatch();
  return operation.finally(() => {
    work.delete(operation);
  });
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
    if (value === undefined) continue;
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

function assertSafeNavigationUrl(
  value: unknown,
  allowOmitted: boolean,
  allowAboutBlank = allowOmitted,
  allowExtensions = true,
): void {
  if (value === undefined && allowOmitted) return;
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
  const allowed = allowExtensions ? ["http:", "https:", "chrome-extension:"] : ["http:", "https:"];
  // Extension pages are the browser's own; connected agents stay limited to HTTP(S).
  if (!allowed.includes(url.protocol) || url.username || url.password) {
    throw new SessionCdpRouterError(
      "forbidden",
      allowExtensions
        ? "CDP navigation is limited to HTTP(S) and extension pages, without embedded credentials."
        : "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
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

/** Events that exist to report cookies sent and set: never delivered to a connection's tab. */
const cookieOnlyEvents = new Set([
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceivedExtraInfo",
]);
const cookieHeader = /^(?:cookie|set-cookie|cookie2|set-cookie2)$/iu;
const cookieKeys = new Set(["associatedCookies", "blockedCookies", "exemptedCookies"]);
const rawHeaderText = new Set(["headersText", "requestHeadersText"]);

/**
 * A Network or Fetch event without cookie material: `Cookie` and `Set-Cookie` headers removed
 * from every header map (`{ name: value }`) and header list (`[{ name, value }]`), raw header
 * text dropped, and cookie lists removed, at any depth.
 */
function withoutCookieMaterial(value: unknown, depth = 0): unknown {
  if (depth > 32 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => withoutCookieMaterial(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (cookieKeys.has(key) || rawHeaderText.has(key)) continue;
    if (/headers$/iu.test(key) && typeof entry === "object" && entry !== null) {
      result[key] = Array.isArray(entry)
        ? entry.filter(
            (header: unknown) =>
              !(
                typeof header === "object" &&
                header !== null &&
                cookieHeader.test(String((header as { name?: unknown }).name))
              ),
          )
        : Object.fromEntries(Object.entries(entry).filter(([name]) => !cookieHeader.test(name)));
      continue;
    }
    result[key] = withoutCookieMaterial(entry, depth + 1);
  }
  return result;
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
