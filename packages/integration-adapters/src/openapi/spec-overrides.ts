// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/spec-overrides.ts (MIT).
import type { JsonPatchOperation } from "./config.js";
import { asRecord } from "../shared.js";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "string"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every(isJsonValue);
}

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(clone);
  const record = asRecord(value);
  if (record)
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, clone(entry as JsonValue)]),
    );
  return value;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/u.test(pointer)) {
    throw new TypeError(`Invalid JSON Pointer ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function arrayIndex(segment: string, length: number, append: boolean): number {
  if (segment === "-" && append) return length;
  if (!/^(0|[1-9]\d*)$/u.test(segment)) throw new TypeError(`Invalid array index ${segment}`);
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index > (append ? length : length - 1)) {
    throw new RangeError(`Array index ${segment} is out of range`);
  }
  return index;
}

function at(root: JsonValue, pointer: string): JsonValue {
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length, false)]!;
    else {
      const record = asRecord(current) as Record<string, JsonValue> | undefined;
      if (!record || !Object.hasOwn(record, segment))
        throw new TypeError(`Pointer ${pointer} does not exist`);
      current = record[segment]!;
    }
  }
  return current;
}

function parentAt(
  root: JsonValue,
  pointer: string,
): { parent: JsonValue[] | Record<string, JsonValue>; key: string } {
  const segments = pointerSegments(pointer);
  const key = segments.pop();
  if (key === undefined) throw new TypeError("The document root has no parent");
  const parentPointer = segments.length
    ? `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
    : "";
  const parent = at(root, parentPointer);
  if (!Array.isArray(parent) && !asRecord(parent))
    throw new TypeError(`Pointer ${pointer} has no container`);
  return { parent: parent as JsonValue[] | Record<string, JsonValue>, key };
}

function add(root: JsonValue, pointer: string, value: JsonValue): JsonValue {
  if (pointer === "") return clone(value);
  const { parent, key } = parentAt(root, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length, true), 0, clone(value));
  else parent[key] = clone(value);
  return root;
}

function remove(root: JsonValue, pointer: string): { root: JsonValue; value: JsonValue } {
  if (pointer === "") return { root: null, value: root };
  const { parent, key } = parentAt(root, pointer);
  if (Array.isArray(parent))
    return { root, value: parent.splice(arrayIndex(key, parent.length, false), 1)[0]! };
  if (!Object.hasOwn(parent, key)) throw new TypeError(`Pointer ${pointer} does not exist`);
  const value = parent[key]!;
  delete parent[key];
  return { root, value };
}

function replace(root: JsonValue, pointer: string, value: JsonValue): JsonValue {
  if (pointer === "") return clone(value);
  at(root, pointer);
  const { parent, key } = parentAt(root, pointer);
  if (Array.isArray(parent)) parent[arrayIndex(key, parent.length, false)] = clone(value);
  else parent[key] = clone(value);
  return root;
}

function equal(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => equal(entry, right[index]!))
    );
  }
  const leftRecord = asRecord(left) as Record<string, JsonValue> | undefined;
  const rightRecord = asRecord(right) as Record<string, JsonValue> | undefined;
  if (!leftRecord || !rightRecord) return false;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && equal(leftRecord[key]!, rightRecord[key]!),
    )
  );
}

export function applySpecOverrides(
  document: unknown,
  overrides: readonly JsonPatchOperation[],
): Record<string, unknown> {
  if (!isJsonValue(document) || !asRecord(document))
    throw new TypeError("OpenAPI document must be a JSON object");
  let result = clone(document);
  for (const [index, operation] of overrides.entries()) {
    try {
      switch (operation.op) {
        case "add":
          if (!isJsonValue(operation.value)) throw new TypeError("add requires a JSON value");
          result = add(result, operation.path, operation.value);
          break;
        case "copy":
          result = add(result, operation.path, at(result, operation.from));
          break;
        case "move": {
          if (operation.path.startsWith(`${operation.from}/`))
            throw new TypeError("cannot move a value into its child");
          const removed = remove(result, operation.from);
          result = add(removed.root, operation.path, removed.value);
          break;
        }
        case "remove":
          result = remove(result, operation.path).root;
          break;
        case "replace":
          if (!isJsonValue(operation.value)) throw new TypeError("replace requires a JSON value");
          result = replace(result, operation.path, operation.value);
          break;
        case "test":
          if (!isJsonValue(operation.value) || !equal(at(result, operation.path), operation.value))
            throw new TypeError("test value did not match");
          break;
      }
    } catch (cause) {
      throw new Error(
        `Spec override ${index + 1} (${operation.op} ${operation.path || "/"}) failed`,
        { cause },
      );
    }
  }
  const record = asRecord(result);
  if (!record) throw new TypeError("Spec overrides must leave the document as an object");
  return record;
}
