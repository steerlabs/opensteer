import { ExecutionContextInventory, remoteObjectContextId } from "./execution-contexts.js";
import { SessionCdpRouterError, type CdpParameters } from "./portable-session-cdp-router.js";

/**
 * Why a CPU profile was refused, for the Home's own log; the agent is told
 * only that the profile held Opensteer's state.
 * - `platform-script`: a frame of a script parsed in a preload or platform world.
 * - `native-frame`: a frame with no script that is not one of V8's own nodes.
 * - `unknown-script`: a frame of a script the inventory never learned.
 * - `uninspected`: frames of scripts, but no inventory could be taken.
 * - `platform-state`: a reference to platform state outside the frames.
 */
export type CdpProfileRefusal =
  "platform-script" | "native-frame" | "unknown-script" | "uninspected" | "platform-state";

const profileRefusals = new WeakMap<SessionCdpRouterError, CdpProfileRefusal>();

/** Why the guard refused this profile, if `error` is that refusal. */
export function cdpProfileRefusal(error: unknown): CdpProfileRefusal | null {
  return error instanceof SessionCdpRouterError ? (profileRefusals.get(error) ?? null) : null;
}

function profileRefused(reason: CdpProfileRefusal): SessionCdpRouterError {
  const error = new SessionCdpRouterError(
    "forbidden",
    "Profiler.stop returned Opensteer's preload or platform state.",
  );
  profileRefusals.set(error, reason);
  return error;
}

/** Isolates the product's preload/IPC and platform state while leaving page worlds unrestricted. */
export class CdpProductIsolation {
  readonly #contexts = new ExecutionContextInventory();
  readonly #scripts = new Map<string, boolean>();
  readonly #frames = new Set<string>();
  readonly #bindings = new Set<string>();
  readonly #newDocumentScripts = new Set<string>();
  /** Whether this inventory has heard anything of the page. */
  #observed = false;
  observePlatformCommand(method: string, params: CdpParameters = {}): void {
    if (method === "Runtime.addBinding" && typeof params.name === "string")
      this.#bindings.add(params.name);
  }
  observe(method: string, params: CdpParameters): boolean {
    this.#observed = true;
    const context = this.#contexts.observe(method, params);
    if (method === "Debugger.scriptParsed" || method === "Debugger.scriptFailedToParse") {
      const internal = this.#internalContext(params.executionContextId);
      this.#scripts.set(String(params.scriptId), internal);
      return !internal;
    }
    if (method === "Debugger.paused") {
      this.#frames.clear();
      for (const frame of Array.isArray(params.callFrames) ? params.callFrames : []) {
        const record = frame as Record<string, unknown>;
        const location = record.location as Record<string, unknown> | undefined;
        if (this.#scripts.get(String(location?.scriptId)) !== false) return false;
        this.#frames.add(String(record.callFrameId));
      }
    }
    if (context && internalName(context.description.name)) return false;
    return !this.#referencesInternal(params, true);
  }
  observeResult(method: string, params: CdpParameters, result: unknown): void {
    if (!result || typeof result !== "object") return;
    const record = result as Record<string, unknown>;
    if (method === "Page.createIsolatedWorld" && typeof record.executionContextId === "number")
      this.#contexts.observe("Runtime.executionContextCreated", {
        context: { id: record.executionContextId, name: params.worldName ?? "agent-world" },
      });
    if (
      (method === "Runtime.evaluate" || method === "DOM.resolveNode") &&
      params.contextId === undefined &&
      params.uniqueContextId === undefined &&
      params.executionContextId === undefined
    ) {
      const object = (record.result ?? record.object) as Record<string, unknown> | undefined;
      const id = remoteObjectContextId(object?.objectId);
      if (id !== null && !this.#contexts.entries().some((entry) => entry.id === id))
        this.#contexts.observe("Runtime.executionContextCreated", { context: { id, name: "" } });
    }
    if (method === "Runtime.compileScript" && typeof record.scriptId === "string")
      this.#scripts.set(record.scriptId, false);
    if (method === "Page.addScriptToEvaluateOnNewDocument" && typeof record.identifier === "string")
      this.#newDocumentScripts.add(record.identifier);
    if (method === "Profiler.stop") {
      const refusal = this.#profileRefusal(result);
      if (refusal) throw profileRefused(refusal);
      return;
    }
    if (this.#referencesInternal(result, true))
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} returned Opensteer's preload or platform state.`,
      );
  }
  /**
   * Checks a CPU profile's frames against what is known of the page's scripts:
   * `scripts` is an inventory that has watched the page since the profile
   * started, or takes one now. A script that ran and was collected before an
   * inventory taken now is unknown to it, so it can only be refused.
   */
  async observeProfileResult(
    result: unknown,
    scripts:
      | CdpProductIsolation
      | ((observe: (method: string, parameters: CdpParameters) => void) => Promise<void>),
  ): Promise<void> {
    if (!profileFrames(result).some((frame) => !isSyntheticFrame(frame))) {
      this.observeResult("Profiler.stop", {}, result);
      return;
    }
    let inventory: CdpProductIsolation;
    if (scripts instanceof CdpProductIsolation) inventory = scripts;
    else {
      inventory = new CdpProductIsolation();
      await scripts((method, parameters) => inventory.observe(method, parameters));
    }
    inventory.observeResult("Profiler.stop", {}, result);
  }
  #profileRefusal(result: unknown): CdpProfileRefusal | null {
    let refusal: CdpProfileRefusal | null = null;
    const page = new Set<object>();
    for (const frame of profileFrames(result)) {
      if (isSyntheticFrame(frame)) {
        page.add(frame);
        continue;
      }
      const known = this.#scripts.get(String(frame.scriptId));
      if (known === false) page.add(frame);
      // A preload or platform frame is the reason whatever else the profile holds.
      else if (known === true) return "platform-script";
      else if (frame.scriptId === "0") refusal ??= "native-frame";
      else refusal ??= this.#observed ? "unknown-script" : "uninspected";
    }
    if (refusal) return refusal;
    return this.#referencesInternal(result, true, page) ? "platform-state" : null;
  }
  assertCommand(method: string, params: CdpParameters = {}): void {
    if (
      method === "Page.removeScriptToEvaluateOnNewDocument" &&
      !this.#newDocumentScripts.has(String(params.identifier))
    )
      throw new SessionCdpRouterError(
        "forbidden",
        "Page script registration belongs to another channel or Opensteer platform code.",
      );
    if (
      method.startsWith("HeapProfiler.") ||
      method.startsWith("Memory.") ||
      method.startsWith("Tracing.")
    )
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} spans Opensteer's preload/platform heap or the shared browser process.`,
      );
    if (this.#referencesInternal(params, false))
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} cannot reach Opensteer's preload, platform worlds or IPC bridges.`,
      );
  }
  #internalContext(id: unknown): boolean {
    // A numeric id names a context's id and a string its unique id; nothing else
    // names one, so a context reported without a unique id never matches `null`.
    const context = this.#contexts
      .entries()
      .find(
        (entry) =>
          (typeof id === "number" && entry.id === id) ||
          (typeof id === "string" && entry.uniqueId === id),
      );
    return context ? internalName(context.description.name) : true;
  }
  #referencesInternal(value: unknown, message: boolean, pageFrames?: ReadonlySet<object>): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value))
      return value.some((item) => this.#referencesInternal(item, message, pageFrames));
    const record = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(record)) {
      if (
        ["contextId", "executionContextId", "uniqueContextId"].includes(key) &&
        this.#internalContext(field)
      )
        return true;
      if (["worldName", "executionContextName"].includes(key) && internalName(field)) return true;
      if (key === "name" && typeof field === "string" && this.#bindings.has(field)) return true;
      if (
        key === "scriptId" &&
        this.#scripts.get(String(field)) !== false &&
        !pageFrames?.has(record)
      )
        return true;
      if (key === "callFrameId" && !this.#frames.has(String(field))) return true;
      if (
        [
          "objectId",
          "promiseObjectId",
          "prototypeObjectId",
          "bodyGetterId",
          "errorObjectId",
        ].includes(key) &&
        this.#internalContext(remoteObjectContextId(field))
      )
        return true;
      if (
        message &&
        (key === "deepSerializedValue" || (key === "value" && typeof record.type === "string"))
      )
        continue;
      if (this.#referencesInternal(field, message, pageFrames)) return true;
    }
    return false;
  }
}
function internalName(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith("opensteer-") ||
      value === "Electron Isolated Context" ||
      value === "Electron Sandbox Context")
  );
}

function profileFrames(result: unknown): Record<string, unknown>[] {
  const nodes = asRecord(asRecord(result).profile).nodes;
  return Array.isArray(nodes) ? nodes.map((node) => asRecord(asRecord(node).callFrame)) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const syntheticProfileFunctions = new Set(["(root)", "(idle)", "(program)", "(garbage collector)"]);

function isSyntheticFrame(frame: Record<string, unknown>): boolean {
  return (
    frame.scriptId === "0" &&
    typeof frame.functionName === "string" &&
    syntheticProfileFunctions.has(frame.functionName) &&
    frame.url === "" &&
    frame.lineNumber === -1 &&
    frame.columnNumber === -1
  );
}
