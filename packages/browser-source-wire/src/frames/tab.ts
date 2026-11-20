import { z } from "zod";
import { BrowserSourcePairInputSchema } from "./v4.js";

export const browserSourceTabWire = 6;
export const BrowserSourceLiveTabsCapabilitySchema = z.literal("live-tabs");
export const BrowserSourcePairV6InputSchema = BrowserSourcePairInputSchema.extend({
  capability: BrowserSourceLiveTabsCapabilitySchema.optional(),
});
export const browserSourceTabMessageBytes = 8 * 1024 * 1024;
export const browserSourceTabBufferedBytes = 2 * browserSourceTabMessageBytes;
export const browserSourceTabPending = 128;
const partBytes = 192 * 1024;
export const browserSourceTabFrameBytes = (partBytes / 3) * 4 + 1024;

function frameSchema<Type extends "tab.command" | "tab.result" | "tab.event">(type: Type) {
  return z.strictObject({
    type: z.literal(type),
    offset: z
      .number()
      .int()
      .min(0)
      .max(browserSourceTabMessageBytes - 1),
    last: z.boolean(),
    data: z
      .string()
      .min(4)
      .max((partBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  });
}

export const browserSourceTabHostSchemas = { "tab.command": frameSchema("tab.command") };
export const browserSourceTabClientSchemas = {
  "tab.result": frameSchema("tab.result"),
  "tab.event": frameSchema("tab.event"),
  "tab.shared": z.strictObject({
    type: z.literal("tab.shared"),
    shareId: z.uuid(),
    targetId: z.string().min(1).max(512),
    browserVersion: z
      .string()
      .regex(/^\d{1,4}(?:\.\d{1,8}){3}$/u)
      .optional(),
    openerShareId: z.uuid().optional(),
    title: z.string().max(1024),
    url: z.string().max(8192),
  }),
  "tab.unshared": z.strictObject({ type: z.literal("tab.unshared"), shareId: z.uuid() }),
};

const address = { shareId: z.uuid(), attachmentId: z.uuid() };
const parameters = z.record(z.string(), z.unknown());
const cdpSessionId = z.string().min(1).max(512);
const method = z
  .string()
  .max(256)
  .regex(/^[A-Za-z][\w]*\.[A-Za-z][\w]*$/u);
export const BrowserSourceTabCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...address,
    requestId: z.uuid(),
    action: z.literal("cdp"),
    method,
    params: parameters.optional(),
    sessionId: cdpSessionId.optional(),
  }),
  z.strictObject({ ...address, requestId: z.uuid(), action: z.literal("detach") }),
  z.strictObject({ ...address, requestId: z.uuid(), action: z.literal("unshare") }),
]);
export const BrowserSourceTabResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...address, requestId: z.uuid(), ok: z.literal(true), result: parameters }),
  z.strictObject({
    ...address,
    requestId: z.uuid(),
    ok: z.literal(false),
    error: z.string().max(4096),
  }),
]);
export const BrowserSourceTabEventSchema = z.strictObject({
  ...address,
  method,
  params: parameters,
  sessionId: cdpSessionId.optional(),
});

export type BrowserSourceTabCommand = z.infer<typeof BrowserSourceTabCommandSchema>;
export type BrowserSourceTabResult = z.infer<typeof BrowserSourceTabResultSchema>;
export type BrowserSourceTabEvent = z.infer<typeof BrowserSourceTabEventSchema>;
export type BrowserSourceTabShared = z.infer<(typeof browserSourceTabClientSchemas)["tab.shared"]>;
export type BrowserSourceTabUnshared = z.infer<
  (typeof browserSourceTabClientSchemas)["tab.unshared"]
>;
type TabPartType = "tab.command" | "tab.result" | "tab.event";

export interface BrowserSourceTabPart<Type extends TabPartType = TabPartType> {
  readonly type: Type;
  readonly offset: number;
  readonly last: boolean;
  readonly data: string;
}

export function* browserSourceTabParts<Type extends TabPartType>(
  type: Type,
  bytes: Uint8Array,
): Generator<BrowserSourceTabPart<Type>> {
  if (bytes.length === 0 || bytes.length > browserSourceTabMessageBytes)
    throw new RangeError("Chrome tab message exceeds the CDP message limit");
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const end = Math.min(offset + partBytes, bytes.length);
    let data = "";
    for (let i = offset; i < end; i += 4096) {
      data += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, end)));
    }
    yield { type, offset, last: end === bytes.length, data: btoa(data) };
  }
}

export class BrowserSourceTabAssembly {
  #parts: Uint8Array[] = [];
  #type: TabPartType | undefined;
  #bytes = 0;

  read(part: BrowserSourceTabPart): unknown {
    const bytes = Uint8Array.from(atob(part.data), (byte) => byte.charCodeAt(0));
    if (
      part.offset !== this.#bytes ||
      (this.#type && this.#type !== part.type) ||
      bytes.length === 0 ||
      bytes.length > partBytes ||
      (!part.last && bytes.length !== partBytes) ||
      this.#bytes + bytes.length > browserSourceTabMessageBytes
    ) {
      throw new RangeError("Invalid Chrome tab message parts");
    }
    this.#type = part.type;
    this.#bytes += bytes.length;
    this.#parts.push(bytes);
    if (!part.last) return undefined;
    const message = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const bytes of this.#parts) {
      message.set(bytes, offset);
      offset += bytes.length;
    }
    this.#parts = [];
    this.#type = undefined;
    this.#bytes = 0;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message));
  }
}
