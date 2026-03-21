import {
  createBodyPayload,
  type BodyPayload,
  type CookieRecord,
  type NetworkResourceType,
  type ScreenshotFormat,
  type StepEvent,
  type StorageEntry,
} from "@opensteer/browser-core";
import type { ConsoleMessage, Cookie } from "playwright";
import type { DomTreeNode, RareIntegerData, RareStringData, ShadowBoundaryInfo } from "./types.js";

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function normalizeSameSite(value: Cookie["sameSite"]): CookieRecord["sameSite"] {
  switch (value) {
    case "Strict":
      return "strict";
    case "Lax":
      return "lax";
    case "None":
      return "none";
  }
}

export function normalizeResourceType(value: string): NetworkResourceType {
  switch (value) {
    case "document":
    case "stylesheet":
    case "image":
    case "media":
    case "font":
    case "script":
    case "texttrack":
    case "xhr":
    case "fetch":
    case "websocket":
    case "manifest":
      return value;
    case "eventsource":
      return "event-stream";
    default:
      return "other";
  }
}

export function normalizeDialogType(
  value: string,
): Extract<StepEvent, { readonly kind: "dialog-opened" }>["dialogType"] {
  switch (value) {
    case "alert":
    case "beforeunload":
    case "confirm":
    case "prompt":
      return value;
    default:
      return "alert";
  }
}

export function normalizeConsoleLevel(
  value: ReturnType<ConsoleMessage["type"]>,
): Extract<StepEvent, { readonly kind: "console" }>["level"] {
  switch (value) {
    case "warning":
      return "warn";
    case "debug":
    case "info":
    case "error":
    case "trace":
      return value;
    default:
      return "log";
  }
}

export function parseMimeType(value: string | undefined): {
  readonly mimeType?: string;
  readonly charset?: string;
} {
  if (value === undefined) {
    return {};
  }
  const [mimeTypePart, ...parts] = value.split(";");
  const mimeType = mimeTypePart?.trim();
  let charset: string | undefined;
  for (const part of parts) {
    const [name, rawValue] = part.split("=");
    if (name?.trim().toLowerCase() === "charset" && rawValue) {
      charset = rawValue.trim();
    }
  }
  return {
    ...(mimeType ? { mimeType } : {}),
    ...(charset ? { charset } : {}),
  };
}

export function captureBodyPayload(
  bytes: Buffer | Uint8Array | null,
  contentType: string | undefined,
  limit: number,
): BodyPayload | undefined {
  if (bytes === null) {
    return undefined;
  }

  const buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const truncated = buffer.byteLength > limit;
  const captured = truncated ? buffer.subarray(0, limit) : buffer;
  const { mimeType, charset } = parseMimeType(contentType);
  return createBodyPayload(new Uint8Array(captured), {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(charset === undefined ? {} : { charset }),
    truncated,
    ...(truncated ? { originalByteLength: buffer.byteLength } : {}),
  });
}

export function combineFrameUrl(url: string, fragment?: string): string {
  return `${url}${fragment ?? ""}`;
}

export function parseStringTable(strings: readonly string[], index: number | undefined): string {
  if (index === undefined) {
    return "";
  }
  return strings[index] ?? "";
}

export function rareStringValue(
  strings: readonly string[],
  data: RareStringData | undefined,
  index: number,
): string | undefined {
  if (!data) {
    return undefined;
  }
  const rareIndex = data.index.indexOf(index);
  if (rareIndex === -1) {
    return undefined;
  }
  const stringIndex = data.value[rareIndex];
  return parseStringTable(strings, stringIndex);
}

export function rareIntegerValue(
  data: RareIntegerData | undefined,
  index: number,
): number | undefined {
  if (!data) {
    return undefined;
  }
  const rareIndex = data.index.indexOf(index);
  if (rareIndex === -1) {
    return undefined;
  }
  return data.value[rareIndex];
}

export function normalizeShadowRootType(
  value: string | undefined,
): "open" | "closed" | "user-agent" | undefined {
  if (value === "open" || value === "closed" || value === "user-agent") {
    return value;
  }
  return undefined;
}

export function buildShadowBoundaryIndex(
  root: DomTreeNode,
): ReadonlyMap<number, ShadowBoundaryInfo> {
  const byBackendNodeId = new Map<number, ShadowBoundaryInfo>();

  const visit = (node: DomTreeNode, boundary: ShadowBoundaryInfo): void => {
    if (node.backendNodeId !== undefined) {
      byBackendNodeId.set(node.backendNodeId, boundary);
    }

    for (const child of node.children ?? []) {
      visit(child, boundary);
    }

    for (const shadowRoot of node.shadowRoots ?? []) {
      const shadowBoundary: ShadowBoundaryInfo = {
        ...(node.backendNodeId === undefined
          ? {}
          : { shadowHostBackendNodeId: node.backendNodeId }),
        ...(shadowRoot.shadowRootType === undefined
          ? {}
          : { shadowRootType: shadowRoot.shadowRootType }),
      };

      for (const child of shadowRoot.children ?? []) {
        visit(child, shadowBoundary);
      }
    }

    if (node.contentDocument) {
      visit(node.contentDocument, {});
    }
  };

  visit(root, {});
  return byBackendNodeId;
}

export function interleavedAttributesToEntries(values: readonly string[]): StorageEntry[] {
  const entries: StorageEntry[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key !== undefined && value !== undefined) {
      entries.push({ key, value });
    }
  }
  return entries;
}

export function mapScreenshotFormat(format: ScreenshotFormat | undefined): ScreenshotFormat {
  return format ?? "png";
}
