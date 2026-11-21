import { ExecutionContextInventory, remoteObjectContextId } from "./execution-contexts.js";
import { SessionCdpRouterError, type CdpParameters } from "./portable-session-cdp-router.js";

/** Isolates the product's preload/IPC and platform state while leaving page worlds unrestricted. */
export class CdpProductIsolation {
  readonly #contexts = new ExecutionContextInventory();
  readonly #scripts = new Map<string, boolean>();
  readonly #frames = new Set<string>();
  readonly #bindings = new Set<string>();
  readonly #newDocumentScripts = new Set<string>();
  observePlatformCommand(method: string, params: CdpParameters = {}): void {
    if (method === "Runtime.addBinding" && typeof params.name === "string")
      this.#bindings.add(params.name);
  }
  observe(method: string, params: CdpParameters): boolean {
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
    const syntheticFrames =
      method === "Profiler.stop"
        ? new Set(profileFrames(result).filter(isSyntheticFrame))
        : undefined;
    if (this.#referencesInternal(result, true, syntheticFrames))
      throw new SessionCdpRouterError(
        "forbidden",
        `${method} returned Opensteer's preload or platform state.`,
      );
  }
  async observeProfileResult(
    result: unknown,
    inspectScripts: (observe: (method: string, parameters: CdpParameters) => void) => Promise<void>,
  ): Promise<void> {
    if (!profileFrames(result).some((frame) => !isSyntheticFrame(frame))) {
      this.observeResult("Profiler.stop", {}, result);
      return;
    }
    const inventory = new CdpProductIsolation();
    await inspectScripts((method, parameters) => inventory.observe(method, parameters));
    inventory.observeResult("Profiler.stop", {}, result);
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
    const context = this.#contexts
      .entries()
      .find((entry) => entry.id === id || entry.uniqueId === id);
    return context ? internalName(context.description.name) : true;
  }
  #referencesInternal(
    value: unknown,
    message: boolean,
    syntheticFrames?: ReadonlySet<object>,
  ): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value))
      return value.some((item) => this.#referencesInternal(item, message, syntheticFrames));
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
        !syntheticFrames?.has(record)
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
      if (this.#referencesInternal(field, message, syntheticFrames)) return true;
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
