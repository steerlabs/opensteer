import { remoteObjectContextId } from "./execution-contexts.js";
import { SessionCdpRouterError, type CdpParameters } from "./portable-session-cdp-router.js";

import { isExtensionUrl } from "./extension-url.js";

export { isExtensionUrl };

/** Whether a free-form string (e.g. a formatted stack trace or breakpoint regex) mentions an extension URL. */
function containsExtensionUrl(value: unknown): boolean {
  return typeof value === "string" && (isExtensionUrl(value) || /chrome-extension:/iu.test(value));
}

function isHttpOrHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const remoteObjectKeys = new Set([
  "objectId",
  "promiseObjectId",
  "prototypeObjectId",
  "bodyGetterId",
  "errorObjectId",
]);

const contextIdKeys = new Set(["contextId", "executionContextId", "uniqueContextId"]);

const scriptOrWorldMethods = new Set([
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.awaitPromise",
  "Runtime.compileScript",
  "Runtime.runScript",
  "Runtime.addBinding",
  "Runtime.removeBinding",
  "Runtime.getProperties",
  "Runtime.globalLexicalScopeNames",
  "Runtime.queryObjects",
  "Runtime.releaseObject",
  "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Debugger.setBreakpointByUrl",
  "Debugger.setBreakpoint",
  "Debugger.setBreakpointOnFunctionCall",
  "Debugger.evaluateOnCallFrame",
  "Debugger.getScriptSource",
  "Debugger.setScriptSource",
  "Debugger.continueToLocation",
  "Debugger.restartFrame",
  "DOM.resolveNode",
  "DOM.requestNode",
]);

function referencesAnyRuntimeId(params: unknown, depth = 0): boolean {
  if (depth > 32 || !params || typeof params !== "object") return false;
  if (Array.isArray(params)) return params.some((item) => referencesAnyRuntimeId(item, depth + 1));
  for (const [key, field] of Object.entries(params as Record<string, unknown>)) {
    if (field === undefined) continue;
    if (
      contextIdKeys.has(key) ||
      remoteObjectKeys.has(key) ||
      key === "scriptId" ||
      key === "callFrameId"
    )
      return true;
    if (field && typeof field === "object" && referencesAnyRuntimeId(field, depth + 1)) return true;
  }
  return false;
}

export type ExtensionEventOutcome =
  | { readonly action: "compromised" }
  | { readonly action: "drop" }
  | { readonly action: "forward"; readonly params: CdpParameters };

export interface ConnectionExtensionIsolationOptions {
  readonly targetId?: string;
  readonly isWorker?: boolean;
}

/**
 * Per-connection isolation of Chrome extension content-script worlds, scripts, frames, stack
 * frames, and resources. Instantiated ONLY for connection-controlled channels, so the person's own
 * Runs keep full access to extensions they build and test while a connected agent:
 * - can only address execution contexts and scripts positively seen as the page's own main world
 *   or worlds created by this connection through the router, dropping script IDs with their
 *   contexts (M2, N3, S5);
 * - cannot set wildcard/hash breakpoints that run conditions inside extension worlds (N1);
 * - has every agent-chosen world name namespaced with a per-channel non-`opensteer-` prefix so no
 *   world name acts as an installed-extension oracle or reaches an extension world (M5);
 * - ends its channel at once if its main frame commits a `chrome-extension:` document (M1b, N2, S-g).
 */
export class ConnectionExtensionIsolation {
  readonly #worldPrefix: string;
  readonly #isWorker: boolean;
  readonly #allowedContextIds = new Set<number>();
  readonly #allowedUniqueIds = new Set<string>();
  readonly #allowedContexts = new Map<number, CdpParameters>();
  /** Maps allowed scriptId -> executionContextId so scripts expire with their context (N3). */
  readonly #allowedScripts = new Map<string, number>();
  readonly #extensionFrameIds = new Set<string>();
  #mainFrameId: string | undefined;
  #compromised = false;

  constructor(worldPrefix: string, options: ConnectionExtensionIsolationOptions = {}) {
    this.#worldPrefix = worldPrefix;
    this.#isWorker = options.isWorker === true;
    if (!this.#isWorker && options.targetId) this.#mainFrameId = options.targetId;
  }

  get compromised(): boolean {
    return this.#compromised;
  }

  markCompromised(): void {
    this.#compromised = true;
  }

  /** Live allowed execution contexts, already prefix-stripped, for replaying on `Runtime.enable`. */
  allowedContextEvents(): CdpParameters[] {
    return [...this.#allowedContexts.values()].map((context) => ({ context }));
  }

  /**
   * Whether a command runs script, touches execution worlds/breakpoints, or names a context/object/
   * script/call-frame ID and must wait for Runtime inventory first (S9). Non-script/non-ID commands
   * such as `Page.handleJavaScriptDialog` always pass through immediately. On shared-tab backends
   * without eager attach-time inventory (`includeScriptMethods = false`), only ID-bearing commands
   * trigger lazy inventory.
   */
  needsRuntimeInventory(
    method: string,
    params: CdpParameters | undefined,
    includeScriptMethods = true,
  ): boolean {
    if (includeScriptMethods && scriptOrWorldMethods.has(method)) return true;
    if (
      includeScriptMethods &&
      method === "Page.reload" &&
      params?.scriptToEvaluateOnLoad !== undefined
    ) {
      return true;
    }
    return referencesAnyRuntimeId(params);
  }

  /** Filters and scrubs a page/child CDP event; signals `"compromised"` if this channel entered an extension page. */
  observeEvent(method: string, params: CdpParameters): ExtensionEventOutcome {
    if (this.#compromised) return { action: "compromised" };
    if (method === "Runtime.executionContextsCleared") {
      this.#allowedContextIds.clear();
      this.#allowedUniqueIds.clear();
      this.#allowedContexts.clear();
      this.#allowedScripts.clear();
      return { action: "forward", params };
    }
    if (method === "Page.frameNavigated") {
      const frame = asRecord(params.frame);
      const frameId = typeof frame.id === "string" ? frame.id : undefined;
      const isMain =
        frame.parentId === undefined || frame.parentId === null || frame.parentId === "";
      const isExt = isExtensionUrl(frame.url) || isExtensionUrl(frame.securityOrigin);
      if (isMain) {
        if (frameId) this.#mainFrameId = frameId;
        if (isExt) {
          this.#compromised = true;
          return { action: "compromised" };
        }
        return { action: "forward", params };
      }
      if (isExt) {
        if (frameId) this.#extensionFrameIds.add(frameId);
        return { action: "drop" };
      }
      return { action: "forward", params };
    }
    if (method === "Page.navigatedWithinDocument") {
      if (isExtensionUrl(params.url)) {
        const frameId = typeof params.frameId === "string" ? params.frameId : undefined;
        if (frameId === undefined || frameId === this.#mainFrameId) {
          this.#compromised = true;
          return { action: "compromised" };
        }
        this.#extensionFrameIds.add(frameId);
        return { action: "drop" };
      }
      return { action: "forward", params };
    }
    if (
      method === "Page.frameAttached" ||
      method === "Page.frameStartedLoading" ||
      method === "Page.frameRequestedNavigation" ||
      method === "Page.frameStoppedLoading" ||
      method === "Page.frameDetached"
    ) {
      const frameId = typeof params.frameId === "string" ? params.frameId : undefined;
      if (
        isExtensionUrl(params.url) ||
        (frameId !== undefined && this.#extensionFrameIds.has(frameId))
      ) {
        if (frameId) this.#extensionFrameIds.add(frameId);
        return { action: "drop" };
      }
      return { action: "forward", params };
    }
    if (method === "Runtime.executionContextCreated") {
      const context = asRecord(params.context);
      const aux = asRecord(context.auxData);
      const frameId = typeof aux.frameId === "string" ? aux.frameId : undefined;
      const rawName = typeof context.name === "string" ? context.name : "";
      const isExtOrigin =
        isExtensionUrl(context.origin) ||
        isExtensionUrl(aux.origin) ||
        isExtensionUrl(aux.url) ||
        (frameId !== undefined && this.#extensionFrameIds.has(frameId));
      if (isExtOrigin) {
        // S-g: only a default-world extension context in the MAIN frame (known from targetId /
        // top-level frameNavigated) compromises the channel; a default-world extension context in
        // a subframe marks that subframe as an extension document; a non-default content script
        // running in a web subframe never marks that web subframe as an extension frame.
        if (aux.isDefault === true) {
          if (frameId === undefined || frameId === this.#mainFrameId) {
            this.#compromised = true;
            return { action: "compromised" };
          }
          this.#extensionFrameIds.add(frameId);
        }
        return { action: "drop" };
      }
      const isOwnNamedWorld = rawName.startsWith(this.#worldPrefix);
      const isMainWorld =
        aux.isDefault === true && (aux.type === undefined || aux.type === "default");
      const isWorkerMain = this.#isWorker && aux.isDefault !== false && rawName === "";
      if (!isOwnNamedWorld && !isMainWorld && !isWorkerMain) {
        return { action: "drop" };
      }
      const sanitizedContext: CdpParameters = isOwnNamedWorld
        ? { ...context, name: rawName.slice(this.#worldPrefix.length) }
        : context;
      if (typeof context.id === "number") {
        this.#allowedContextIds.add(context.id);
        this.#allowedContexts.set(context.id, sanitizedContext);
      }
      if (typeof context.uniqueId === "string" && context.uniqueId) {
        this.#allowedUniqueIds.add(context.uniqueId);
      }
      return { action: "forward", params: { ...params, context: sanitizedContext } };
    }
    if (method === "Runtime.executionContextDestroyed") {
      let id = typeof params.executionContextId === "number" ? params.executionContextId : null;
      const uniqueId =
        typeof params.executionContextUniqueId === "string"
          ? params.executionContextUniqueId
          : null;
      if (id === null && uniqueId !== null) {
        for (const [ctxId, ctx] of this.#allowedContexts) {
          if (ctx.uniqueId === uniqueId) {
            id = ctxId;
            break;
          }
        }
      }
      const known =
        (id !== null && this.#allowedContextIds.has(id)) ||
        (uniqueId !== null && this.#allowedUniqueIds.has(uniqueId));
      if (id !== null) {
        this.#allowedContextIds.delete(id);
        this.#allowedContexts.delete(id);
        for (const [scriptId, ctxId] of this.#allowedScripts) {
          if (ctxId === id) this.#allowedScripts.delete(scriptId);
        }
      }
      if (uniqueId !== null) this.#allowedUniqueIds.delete(uniqueId);
      return known ? { action: "forward", params } : { action: "drop" };
    }
    if (method === "Debugger.scriptParsed" || method === "Debugger.scriptFailedToParse") {
      const ctxId =
        typeof params.executionContextId === "number" ? params.executionContextId : null;
      if (
        isExtensionUrl(params.url) ||
        isExtensionUrl(params.sourceMapURL) ||
        ctxId === null ||
        !this.#allowedContextIds.has(ctxId)
      ) {
        return { action: "drop" };
      }
      if (typeof params.scriptId === "string") this.#allowedScripts.set(params.scriptId, ctxId);
      return { action: "forward", params };
    }
    if (method === "Debugger.paused") {
      const frames = Array.isArray(params.callFrames) ? params.callFrames : [];
      for (const frame of frames) {
        const record = asRecord(frame);
        const location = asRecord(record.location);
        if (
          isExtensionUrl(record.url) ||
          typeof location.scriptId !== "string" ||
          !this.#allowedScripts.has(location.scriptId)
        )
          return { action: "drop" };
      }
      return { action: "forward", params };
    }
    if (method === "Runtime.consoleAPICalled") {
      if (
        params.executionContextId !== undefined &&
        !this.#isAllowedContextId(params.executionContextId)
      )
        return { action: "drop" };
      if (
        this.#stackOriginatedOutsideAllowed(params.stackTrace) ||
        this.#hasDisallowedReference(params.args, true)
      )
        return { action: "drop" };
      return { action: "forward", params: this.#scrubEventStacks(params) };
    }
    if (method === "Runtime.exceptionThrown") {
      const details = asRecord(params.exceptionDetails);
      if (
        (details.executionContextId !== undefined &&
          !this.#isAllowedContextId(details.executionContextId)) ||
        isExtensionUrl(details.url) ||
        (details.scriptId !== undefined && !this.#isAllowedScriptId(details.scriptId)) ||
        this.#stackOriginatedOutsideAllowed(details.stackTrace) ||
        this.#hasDisallowedReference(details.exception, true)
      )
        return { action: "drop" };
      return {
        action: "forward",
        params: { ...params, exceptionDetails: this.#scrubExceptionDetails(details) },
      };
    }
    if (method === "Console.messageAdded") {
      const message = asRecord(params.message);
      if (
        isExtensionUrl(message.url) ||
        containsExtensionUrl(message.text) ||
        this.#stackOriginatedOutsideAllowed(message.stackTrace)
      )
        return { action: "drop" };
      return { action: "forward", params: { ...params, message: this.#scrubEventStacks(message) } };
    }
    if (method === "Log.entryAdded") {
      const entry = asRecord(params.entry);
      if (
        isExtensionUrl(entry.url) ||
        containsExtensionUrl(entry.text) ||
        this.#stackOriginatedOutsideAllowed(entry.stackTrace) ||
        this.#hasDisallowedReference(entry.args, true)
      )
        return { action: "drop" };
      return { action: "forward", params: { ...params, entry: this.#scrubEventStacks(entry) } };
    }
    if (method.startsWith("Network.") || method.startsWith("Fetch.")) {
      const request = asRecord(params.request);
      const response = asRecord(params.response);
      if (
        isExtensionUrl(request.url) ||
        isExtensionUrl(response.url) ||
        isExtensionUrl(params.documentURL) ||
        this.#isExtensionFrameId(params.frameId)
      )
        return { action: "drop" };
      if (params.initiator && typeof params.initiator === "object") {
        const initiator = asRecord(params.initiator);
        if (isExtensionUrl(initiator.url)) return { action: "drop" };
        if (initiator.stack) {
          return {
            action: "forward",
            params: {
              ...params,
              initiator: { ...initiator, stack: this.#scrubStackTrace(initiator.stack) },
            },
          };
        }
      }
      return { action: "forward", params };
    }
    // Catch-all (S2): drop any event referencing an extension URL, extension frame, or unallowed context/script.
    if (
      isExtensionUrl(params.url) ||
      isExtensionUrl(params.sourceURL) ||
      isExtensionUrl(params.documentURL) ||
      this.#isExtensionFrameId(params.frameId) ||
      this.#hasDisallowedReference(params, true)
    )
      return { action: "drop" };
    return { action: "forward", params };
  }

  /**
   * Refuses commands targeting any context, script, or remote object NOT positively learned as the
   * page's own (M2, N3, S5), refuses wildcard/hash/non-HTTP(S) breakpoints (N1), refuses extension
   * URLs/frames, and namespaces agent-chosen world names so extension names never act as an oracle
   * or binding target (M5).
   */
  assertAndRewriteCommand(method: string, params: CdpParameters = {}): CdpParameters {
    if (this.#compromised)
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.", {
        unsent: true,
      });
    if (method === "Debugger.setBreakpointByUrl") {
      // N1: urlRegex and scriptHash can match extension content scripts and evaluate `condition`
      // inside their isolated worlds. Accept only a parsed HTTP(S) `url`.
      if (
        params.urlRegex !== undefined ||
        params.scriptHash !== undefined ||
        !isHttpOrHttpsUrl(params.url)
      )
        throw new SessionCdpRouterError("forbidden", "Breakpoint target is not available.");
    }
    if (method === "Page.getResourceContent" && isExtensionUrl(params.url))
      throw new SessionCdpRouterError("not_found", "Resource is not available.");
    if (this.#isExtensionFrameId(params.frameId))
      throw new SessionCdpRouterError("not_found", "Frame is not available.");
    if (this.#hasDisallowedReference(params, false))
      throw new SessionCdpRouterError("not_found", "The requested target is not available.");

    // M5: namespace connection-chosen world names (never `opensteer-`) so they cannot match or probe extensions.
    if (method === "Page.createIsolatedWorld") {
      const raw = typeof params.worldName === "string" ? params.worldName : "";
      return { ...params, worldName: `${this.#worldPrefix}${raw}` };
    }
    if (
      method === "Page.addScriptToEvaluateOnNewDocument" &&
      typeof params.worldName === "string" &&
      params.worldName.length > 0
    ) {
      return { ...params, worldName: `${this.#worldPrefix}${params.worldName}` };
    }
    if (method === "Runtime.addBinding") {
      if (params.executionContextId !== undefined) return params;
      if (typeof params.executionContextName === "string") {
        return params.executionContextName.length === 0
          ? params
          : {
              ...params,
              executionContextName: `${this.#worldPrefix}${params.executionContextName}`,
            };
      }
      return { ...params, executionContextName: "" };
    }
    return params;
  }

  /** Learns agent-created world IDs, strips disallowed breakpoint locations, prunes frames/history, and rejects disallowed handles. */
  sanitizeResult(method: string, result: unknown): unknown {
    if (this.#compromised)
      throw new SessionCdpRouterError("not_found", "CDP session is not attached here.");
    if (!result || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
    if (method === "Page.createIsolatedWorld" && typeof record.executionContextId === "number") {
      this.#allowedContextIds.add(record.executionContextId);
      return result;
    }
    if (method === "Debugger.setBreakpointByUrl" && Array.isArray(record.locations)) {
      // N1: strip locations whose script is not allowed instead of throwing (no install oracle).
      return {
        ...record,
        locations: record.locations.filter((loc) =>
          this.#isAllowedScriptId(asRecord(loc).scriptId),
        ),
      };
    }
    if (
      method === "Page.getResourceTree" &&
      record.frameTree &&
      typeof record.frameTree === "object"
    )
      return { ...record, frameTree: this.#pruneResourceTree(asRecord(record.frameTree)) };
    if (method === "Page.getFrameTree" && record.frameTree && typeof record.frameTree === "object")
      return { ...record, frameTree: this.#pruneFrameTree(asRecord(record.frameTree)) };
    if (method === "Page.getNavigationHistory" && Array.isArray(record.entries))
      return {
        ...record,
        entries: record.entries.filter((entry) => !isExtensionUrl(asRecord(entry).url)),
      };
    if (record.exceptionDetails && typeof record.exceptionDetails === "object") {
      const details = asRecord(record.exceptionDetails);
      if (
        (details.executionContextId !== undefined &&
          this.#allowedContextIds.size > 0 &&
          !this.#isAllowedContextId(details.executionContextId)) ||
        isExtensionUrl(details.url) ||
        (details.scriptId !== undefined &&
          this.#allowedScripts.size > 0 &&
          !this.#isAllowedScriptId(details.scriptId)) ||
        (this.#allowedContextIds.size > 0 && this.#hasDisallowedReference(details.exception, true))
      )
        throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
      const scrubbed = { ...record, exceptionDetails: this.#scrubExceptionDetails(details) };
      if (this.#allowedContextIds.size > 0 && this.#hasDisallowedReference(scrubbed, true))
        throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
      return scrubbed;
    }
    if (this.#allowedContextIds.size > 0 && this.#hasDisallowedReference(result, true))
      throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
    return result;
  }

  #isAllowedContextId(value: unknown): boolean {
    return typeof value === "number" && this.#allowedContextIds.has(value);
  }

  #isAllowedScriptId(value: unknown): boolean {
    return typeof value === "string" && this.#allowedScripts.has(value);
  }

  #isExtensionFrameId(value: unknown): boolean {
    return typeof value === "string" && this.#extensionFrameIds.has(value);
  }

  #stackOriginatedOutsideAllowed(stack: unknown): boolean {
    if (!stack || typeof stack !== "object") return false;
    const frames = asRecord(stack).callFrames;
    if (!Array.isArray(frames) || frames.length === 0) return false;
    return frames.every((frame) => {
      const record = asRecord(frame);
      if (isExtensionUrl(record.url)) return true;
      if (
        this.#allowedScripts.size > 0 &&
        typeof record.scriptId === "string" &&
        !this.#allowedScripts.has(record.scriptId)
      )
        return true;
      return false;
    });
  }

  #scrubStackTrace(stack: unknown, depth = 0): unknown {
    if (depth > 16 || !stack || typeof stack !== "object") return stack;
    const record = asRecord(stack);
    const next: Record<string, unknown> = { ...record };
    if (Array.isArray(record.callFrames)) {
      next.callFrames = record.callFrames.filter((frame) => {
        const entry = asRecord(frame);
        if (isExtensionUrl(entry.url)) return false;
        if (
          this.#allowedScripts.size > 0 &&
          typeof entry.scriptId === "string" &&
          !this.#allowedScripts.has(entry.scriptId)
        )
          return false;
        return true;
      });
    }
    if (record.parent && typeof record.parent === "object") {
      next.parent = this.#scrubStackTrace(record.parent, depth + 1);
    }
    return next;
  }

  #scrubEventStacks(record: Record<string, unknown>): Record<string, unknown> {
    if (!record.stackTrace || typeof record.stackTrace !== "object") return record;
    return { ...record, stackTrace: this.#scrubStackTrace(record.stackTrace) };
  }

  #scrubExceptionDetails(details: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = { ...details };
    if (details.stackTrace && typeof details.stackTrace === "object") {
      next.stackTrace = this.#scrubStackTrace(details.stackTrace);
    }
    if (details.exception && typeof details.exception === "object") {
      const exception = asRecord(details.exception);
      if (
        typeof exception.description === "string" &&
        containsExtensionUrl(exception.description)
      ) {
        const cleaned = exception.description
          .split("\n")
          .filter((line) => !containsExtensionUrl(line))
          .join("\n");
        next.exception = { ...exception, description: cleaned };
      }
    }
    return next;
  }

  #pruneFrameTree(node: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth > 32) return node;
    const children = Array.isArray(node.childFrames) ? node.childFrames : undefined;
    if (!children) return node;
    const kept: Record<string, unknown>[] = [];
    for (const child of children) {
      const entry = asRecord(child);
      const frame = asRecord(entry.frame);
      if (isExtensionUrl(frame.url) || isExtensionUrl(frame.securityOrigin)) {
        if (typeof frame.id === "string") this.#extensionFrameIds.add(frame.id);
        continue;
      }
      kept.push(this.#pruneFrameTree(entry, depth + 1));
    }
    return { ...node, childFrames: kept };
  }

  #pruneResourceTree(node: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth > 32) return node;
    const next: Record<string, unknown> = { ...node };
    if (Array.isArray(node.resources)) {
      next.resources = node.resources.filter((resource) => !isExtensionUrl(asRecord(resource).url));
    }
    if (Array.isArray(node.childFrames)) {
      const kept: Record<string, unknown>[] = [];
      for (const child of node.childFrames) {
        const entry = asRecord(child);
        const frame = asRecord(entry.frame);
        if (isExtensionUrl(frame.url) || isExtensionUrl(frame.securityOrigin)) {
          if (typeof frame.id === "string") this.#extensionFrameIds.add(frame.id);
          continue;
        }
        kept.push(this.#pruneResourceTree(entry, depth + 1));
      }
      next.childFrames = kept;
    }
    return next;
  }

  /**
   * Inverted allow-list check (M2, N3, S5): every contextId, executionContextId, uniqueContextId,
   * scriptId, or remote-object ID must name a positively learned page/agent context or script.
   * When inspecting outbound events/results (`fromBrowser = true`), skips serialized page JS values.
   */
  #hasDisallowedReference(value: unknown, fromBrowser: boolean, depth = 0): boolean {
    if (depth > 32 || !value || typeof value !== "object") return false;
    if (Array.isArray(value))
      return value.some((item) => this.#hasDisallowedReference(item, fromBrowser, depth + 1));
    const record = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(record)) {
      if (field === undefined) continue;
      if (key === "contextId" || key === "executionContextId") {
        if (!this.#isAllowedContextId(field)) return true;
      }
      if (key === "uniqueContextId") {
        if (typeof field !== "string" || !this.#allowedUniqueIds.has(field)) return true;
      }
      if (key === "scriptId") {
        if (fromBrowser && this.#allowedScripts.size === 0) {
          // A console/exception event can carry a scriptId even when Debugger was never enabled.
        } else if (!this.#isAllowedScriptId(field)) {
          return true;
        }
      }
      if (remoteObjectKeys.has(key)) {
        const id = remoteObjectContextId(field);
        if (id === null || !this.#allowedContextIds.has(id)) return true;
      }
      if (
        fromBrowser &&
        (key === "deepSerializedValue" || (key === "value" && typeof record.type === "string"))
      )
        continue;
      if (this.#hasDisallowedReference(field, fromBrowser, depth + 1)) return true;
    }
    return false;
  }
}
