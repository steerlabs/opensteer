import type { CdpParameters } from "./session-cdp-router.js";

/**
 * One execution context a CDP session reported. Only a frame's own main world
 * is `mainWorld`: Chromium describes it with `auxData.isDefault` true,
 * `auxData.type` "default" and the frame's ID. Isolated, preload and platform
 * worlds, and anything described otherwise, are not.
 */
export interface ExecutionContextEntry {
  /** The `context` of the `Runtime.executionContextCreated` that reported it. */
  readonly description: CdpParameters;
  readonly frameId: string | null;
  readonly id: number;
  readonly mainWorld: boolean;
  readonly uniqueId: string | null;
}

/**
 * The execution contexts that exist in one CDP session, kept from that
 * session's own Runtime events. Whoever keeps it must enable Runtime there
 * before relying on it: Chromium reports every existing context to a session
 * that enables Runtime, then each creation, destruction and reset.
 */
export class ExecutionContextInventory {
  readonly #entries = new Map<number, ExecutionContextEntry>();

  /** Applies a Runtime context event. Returns the context it reported or removed. */
  observe(method: string, parameters: CdpParameters): ExecutionContextEntry | null {
    switch (method) {
      case "Runtime.executionContextCreated": {
        const entry = contextEntry(parameters.context);
        if (!entry) return null;
        // A renderer that replaces another numbers its contexts afresh; the
        // newest report of an ID describes the context that now has it.
        this.#entries.delete(entry.id);
        this.#entries.set(entry.id, entry);
        return entry;
      }
      case "Runtime.executionContextDestroyed": {
        const uniqueId = parameters.executionContextUniqueId;
        const id = parameters.executionContextId;
        // A unique ID names one context; a numeric ID may be reused by a newer one.
        const entry =
          typeof uniqueId === "string"
            ? [...this.#entries.values()].find((candidate) => candidate.uniqueId === uniqueId)
            : typeof id === "number"
              ? this.#entries.get(id)
              : undefined;
        if (!entry) return null;
        this.#entries.delete(entry.id);
        return entry;
      }
      case "Runtime.executionContextsCleared":
        this.#entries.clear();
        return null;
      default:
        return null;
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Every live context, oldest first, as Chromium reports them to a new session. */
  entries(): readonly ExecutionContextEntry[] {
    return [...this.#entries.values()];
  }

  isMainWorld(contextId: unknown): boolean {
    return typeof contextId === "number" && this.#entries.get(contextId)?.mainWorld === true;
  }
}

const maximumInt32 = 2 ** 31 - 1;
const minimumInt64 = -(2n ** 63n);
const maximumInt64 = 2n ** 63n - 1n;
// Canonical decimal only. V8 reads each part with strtoll, which also takes
// whitespace, signs and leading zeros; anything but its own output is refused.
const remoteObjectIdPattern = /^(0|-?[1-9][0-9]{0,18})\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})$/u;

/**
 * The execution context a V8 RemoteObjectId names, or null when the value is
 * not one. V8 serializes it as `<isolateId>.<executionContextId>.<objectId>`.
 */
export function remoteObjectContextId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = remoteObjectIdPattern.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const isolateId = BigInt(match[1]);
  const contextId = Number(match[2]);
  if (
    isolateId < minimumInt64 ||
    isolateId > maximumInt64 ||
    contextId > maximumInt32 ||
    Number(match[3]) > maximumInt32
  ) {
    return null;
  }
  return contextId;
}

/** Every parameter or field the CDP spec types as a Runtime.RemoteObjectId. */
const objectHandleKeys: ReadonlySet<string> = new Set([
  "bodyGetterId",
  "errorObjectId",
  "objectId",
  "promiseObjectId",
  "prototypeObjectId",
]);

/**
 * Finds the first object handle that does not name an object in a known main
 * world, and returns where it is; null when every handle does. Commands are
 * read whole. In results and events a RemoteObject's `value` and its deep
 * serialization are page data, whose `objectId` fields are not handles.
 */
export function foreignObjectHandle(
  value: unknown,
  contexts: ExecutionContextInventory,
  source: "command" | "message",
): string | null {
  const pending: { readonly path: string; readonly value: unknown }[] = [{ path: "", value }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (Array.isArray(next.value)) {
      next.value.forEach((item, index) =>
        pending.push({ path: `${next?.path}[${index}]`, value: item }),
      );
      continue;
    }
    if (next.value === null || typeof next.value !== "object") continue;
    const record = next.value as Record<string, unknown>;
    const byValue = source === "message" && typeof record.type === "string";
    for (const [key, field] of Object.entries(record)) {
      const path = next.path ? `${next.path}.${key}` : key;
      if (objectHandleKeys.has(key)) {
        const contextId = remoteObjectContextId(field);
        if (contextId === null || !contexts.isMainWorld(contextId)) return path;
        continue;
      }
      if (source === "message" && key === "deepSerializedValue") continue;
      if (byValue && key === "value") continue;
      pending.push({ path, value: field });
    }
  }
  return null;
}

function contextEntry(value: unknown): ExecutionContextEntry | null {
  const description = asRecord(value);
  const id = description.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > maximumInt32) {
    return null;
  }
  const auxData = asRecord(description.auxData);
  const frameId =
    typeof auxData.frameId === "string" && auxData.frameId.length > 0 ? auxData.frameId : null;
  return {
    description,
    frameId,
    id,
    mainWorld: auxData.isDefault === true && auxData.type === "default" && frameId !== null,
    uniqueId: typeof description.uniqueId === "string" ? description.uniqueId : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
