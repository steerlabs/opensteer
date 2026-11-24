import { remoteObjectContextId } from "./execution-contexts.js";
import { SessionCdpRouterError, type CdpParameters } from "./portable-session-cdp-router.js";

/** Whether a URL or origin belongs to a Chrome extension (`chrome-extension:`). */
export function isExtensionUrl(value: unknown): boolean {
  return typeof value === "string" && /^\s*chrome-extension:/iu.test(value);
}

/** Whether a string contains a `chrome-extension:` URL (e.g. a formatted stack trace or regex). */
function containsExtensionUrl(value: unknown): boolean {
  return typeof value === "string" && /chrome-extension:/iu.test(value);
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

/**
 * Per-connection isolation of Chrome extension content-script worlds, scripts, frames, stack
 * frames, and resources. Instantiated ONLY for connected-agent channels (`state.connection`), so
 * the person's own Runs keep full access to extensions they build and test while a connected agent
 * never learns which extensions are installed and never evaluates in an extension context.
 */
export class ConnectionExtensionIsolation {
  readonly #contextIds = new Set<number>();
  readonly #uniqueIds = new Set<string>();
  readonly #contextNames = new Set<string>();
  readonly #scriptIds = new Set<string>();
  readonly #frameIds = new Set<string>();

  /** Filters and scrubs a page/child CDP event; returns `null` to drop it completely. */
  observeEvent(method: string, params: CdpParameters): CdpParameters | null {
    if (method === "Runtime.executionContextsCleared") {
      this.#contextIds.clear();
      this.#uniqueIds.clear();
      this.#contextNames.clear();
      return params;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = asRecord(params.context);
      const aux = asRecord(context.auxData);
      const frameId = typeof aux.frameId === "string" ? aux.frameId : undefined;
      if (
        isExtensionUrl(context.origin) ||
        isExtensionUrl(aux.origin) ||
        isExtensionUrl(aux.url) ||
        (frameId !== undefined && this.#frameIds.has(frameId))
      ) {
        if (typeof context.id === "number") this.#contextIds.add(context.id);
        if (typeof context.uniqueId === "string" && context.uniqueId)
          this.#uniqueIds.add(context.uniqueId);
        if (typeof context.name === "string" && context.name) this.#contextNames.add(context.name);
        return null;
      }
      return params;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const id = params.executionContextId;
      const uniqueId = params.executionContextUniqueId;
      const tracked =
        (typeof id === "number" && this.#contextIds.has(id)) ||
        (typeof uniqueId === "string" && this.#uniqueIds.has(uniqueId));
      if (typeof id === "number") this.#contextIds.delete(id);
      if (typeof uniqueId === "string") this.#uniqueIds.delete(uniqueId);
      return tracked ? null : params;
    }
    if (method === "Debugger.scriptParsed" || method === "Debugger.scriptFailedToParse") {
      if (
        isExtensionUrl(params.url) ||
        isExtensionUrl(params.sourceMapURL) ||
        this.#isExtensionContextId(params.executionContextId)
      ) {
        if (typeof params.scriptId === "string" && params.scriptId)
          this.#scriptIds.add(params.scriptId);
        return null;
      }
      return params;
    }
    if (method === "Debugger.paused") {
      for (const frame of Array.isArray(params.callFrames) ? params.callFrames : []) {
        const record = asRecord(frame);
        const location = asRecord(record.location);
        if (isExtensionUrl(record.url) || this.#isExtensionScriptId(location.scriptId)) return null;
      }
      if (this.#referencesExtension(params)) return null;
      return params;
    }
    if (
      method === "Page.frameAttached" ||
      method === "Page.frameNavigated" ||
      method === "Page.frameStartedNavigation" ||
      method === "Page.frameRequestedNavigation" ||
      method === "Page.navigatedWithinDocument" ||
      method === "Page.frameDetached"
    ) {
      const frame = asRecord(params.frame);
      const frameId =
        typeof frame.id === "string"
          ? frame.id
          : typeof params.frameId === "string"
            ? params.frameId
            : undefined;
      const parentId =
        typeof frame.parentId === "string"
          ? frame.parentId
          : typeof params.parentFrameId === "string"
            ? params.parentFrameId
            : undefined;
      if (
        isExtensionUrl(frame.url) ||
        isExtensionUrl(frame.securityOrigin) ||
        isExtensionUrl(params.url) ||
        (parentId !== undefined && this.#frameIds.has(parentId))
      ) {
        if (frameId) this.#frameIds.add(frameId);
        return null;
      }
      if (frameId && this.#frameIds.has(frameId)) {
        if (method === "Page.frameDetached") this.#frameIds.delete(frameId);
        return null;
      }
      return params;
    }
    if (method === "Runtime.consoleAPICalled") {
      if (this.#isExtensionContextId(params.executionContextId)) return null;
      if (this.#referencesExtension(params.args)) return null;
      if (this.#stackOriginatedInExtension(params.stackTrace)) return null;
      return this.#scrubEventStacks(params);
    }
    if (method === "Runtime.exceptionThrown") {
      const details = asRecord(params.exceptionDetails);
      if (
        this.#isExtensionContextId(details.executionContextId) ||
        isExtensionUrl(details.url) ||
        this.#isExtensionScriptId(details.scriptId) ||
        this.#stackOriginatedInExtension(details.stackTrace) ||
        this.#referencesExtension(details.exception)
      )
        return null;
      return { ...params, exceptionDetails: this.#scrubExceptionDetails(details) };
    }
    if (method === "Console.messageAdded") {
      const message = asRecord(params.message);
      if (
        isExtensionUrl(message.url) ||
        containsExtensionUrl(message.text) ||
        this.#stackOriginatedInExtension(message.stackTrace)
      )
        return null;
      return { ...params, message: this.#scrubEventStacks(message) };
    }
    if (method === "Log.entryAdded") {
      const entry = asRecord(params.entry);
      if (
        isExtensionUrl(entry.url) ||
        containsExtensionUrl(entry.text) ||
        this.#stackOriginatedInExtension(entry.stackTrace) ||
        this.#referencesExtension(entry.args)
      )
        return null;
      return { ...params, entry: this.#scrubEventStacks(entry) };
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
        return null;
      if (params.initiator && typeof params.initiator === "object") {
        const initiator = asRecord(params.initiator);
        if (isExtensionUrl(initiator.url)) return null;
        if (initiator.stack) {
          return {
            ...params,
            initiator: { ...initiator, stack: this.#scrubStackTrace(initiator.stack) },
          };
        }
      }
      return params;
    }
    if (this.#isExtensionFrameId(params.frameId) || this.#referencesExtension(params)) return null;
    return params;
  }

  /**
   * Refuses commands addressing a tracked extension context, script, frame, or URL, and narrows
   * unscoped `Runtime.addBinding` to the default world so bindings never enter extension worlds.
   */
  assertCommand(method: string, params: CdpParameters = {}): CdpParameters {
    if (
      method === "Debugger.setBreakpointByUrl" &&
      (isExtensionUrl(params.url) || containsExtensionUrl(params.urlRegex))
    )
      throw new SessionCdpRouterError("forbidden", "Breakpoint target is not available.");
    if (method === "Page.getResourceContent" && isExtensionUrl(params.url))
      throw new SessionCdpRouterError("not_found", "Resource is not available.");
    if (this.#isExtensionFrameId(params.frameId))
      throw new SessionCdpRouterError("not_found", "Frame is not available.");
    if (this.#referencesExtension(params))
      throw new SessionCdpRouterError("not_found", "The requested target is not available.");
    if (
      method === "Runtime.addBinding" &&
      params.executionContextId === undefined &&
      params.executionContextName === undefined
    )
      return { ...params, executionContextName: "" };
    return params;
  }

  /** Prunes extension frames/resources/stacks from answers and rejects extension object handles. */
  sanitizeResult(method: string, result: unknown): unknown {
    if (!result || typeof result !== "object") return result;
    const record = result as Record<string, unknown>;
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
        this.#isExtensionContextId(details.executionContextId) ||
        isExtensionUrl(details.url) ||
        this.#isExtensionScriptId(details.scriptId) ||
        this.#referencesExtension(details.exception)
      )
        throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
      const scrubbed = { ...record, exceptionDetails: this.#scrubExceptionDetails(details) };
      if (this.#referencesExtension(scrubbed))
        throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
      return scrubbed;
    }
    if (this.#referencesExtension(result))
      throw new SessionCdpRouterError("forbidden", "Result is outside this browser attachment.");
    return result;
  }

  #isExtensionContextId(value: unknown): boolean {
    return typeof value === "number" && this.#contextIds.has(value);
  }

  #isExtensionScriptId(value: unknown): boolean {
    return typeof value === "string" && this.#scriptIds.has(value);
  }

  #isExtensionFrameId(value: unknown): boolean {
    return typeof value === "string" && this.#frameIds.has(value);
  }

  #stackOriginatedInExtension(stack: unknown): boolean {
    if (!stack || typeof stack !== "object") return false;
    const frames = asRecord(stack).callFrames;
    if (!Array.isArray(frames) || frames.length === 0) return false;
    return frames.every((frame) => {
      const record = asRecord(frame);
      return isExtensionUrl(record.url) || this.#isExtensionScriptId(record.scriptId);
    });
  }

  #scrubStackTrace(stack: unknown, depth = 0): unknown {
    if (depth > 16 || !stack || typeof stack !== "object") return stack;
    const record = asRecord(stack);
    const next: Record<string, unknown> = { ...record };
    if (Array.isArray(record.callFrames)) {
      next.callFrames = record.callFrames.filter((frame) => {
        const entry = asRecord(frame);
        return !isExtensionUrl(entry.url) && !this.#isExtensionScriptId(entry.scriptId);
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
        if (typeof frame.id === "string") this.#frameIds.add(frame.id);
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
          if (typeof frame.id === "string") this.#frameIds.add(frame.id);
          continue;
        }
        kept.push(this.#pruneResourceTree(entry, depth + 1));
      }
      next.childFrames = kept;
    }
    return next;
  }

  #referencesExtension(value: unknown, depth = 0): boolean {
    if (depth > 32 || !value || typeof value !== "object") return false;
    if (Array.isArray(value))
      return value.some((item) => this.#referencesExtension(item, depth + 1));
    const record = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(record)) {
      if (
        (key === "contextId" || key === "executionContextId") &&
        this.#isExtensionContextId(field)
      )
        return true;
      if (key === "uniqueContextId" && typeof field === "string" && this.#uniqueIds.has(field))
        return true;
      if (
        (key === "worldName" || key === "executionContextName") &&
        typeof field === "string" &&
        this.#contextNames.has(field)
      )
        return true;
      if (key === "scriptId" && this.#isExtensionScriptId(field)) return true;
      if (remoteObjectKeys.has(key)) {
        const id = remoteObjectContextId(field);
        if (id !== null && this.#contextIds.has(id)) return true;
      }
      if (this.#referencesExtension(field, depth + 1)) return true;
    }
    return false;
  }
}
