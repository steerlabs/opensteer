import type { EditingProxyEvent, EditingProxyInstruction } from "@opensteer/client/editing";
import {
  EditingContextSchema,
  editingClipboardMaxBytes,
  editingClipboardMaxItems,
} from "@opensteer/protocol/editing";
import { decodeBase64Url, encodeBase64Url } from "@opensteer/shared/base64url";
import { z } from "zod";

const offset = z.number().int().nonnegative();
const proxy = z
  .object({
    value: z.string().max(100_000),
    selectionStart: offset,
    selectionEnd: offset,
    markedRange: z.object({ start: offset, end: offset }).optional(),
  })
  .refine(
    (p) =>
      p.selectionStart <= p.selectionEnd &&
      p.selectionEnd <= p.value.length &&
      (!p.markedRange ||
        (p.markedRange.start <= p.markedRange.end && p.markedRange.end <= p.value.length)),
  )
  .transform(({ markedRange, ...state }) => ({
    ...state,
    ...(markedRange === undefined ? {} : { markedRange }),
  }));
const base64 = z
  .string()
  .max(Math.ceil(editingClipboardMaxBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const key = z.object({
  type: z.enum(["keydown", "keyup"]),
  key: z.string().max(100),
  code: z.string().max(100),
  alt: z.boolean(),
  control: z.boolean(),
  meta: z.boolean(),
  shift: z.boolean(),
  altGraph: z.boolean(),
  location: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  repeat: z.boolean(),
  composing: z.boolean(),
});
const event = z.union([
  key,
  z.object({ type: z.literal("compositionstart"), proxy }),
  z.object({
    type: z.enum(["compositionupdate", "compositionend"]),
    data: z.string().max(100_000),
    proxy,
  }),
  z.object({
    type: z.literal("beforeinput"),
    inputType: z.string().max(100),
    data: z.string().max(100_000).nullable(),
  }),
  z.object({
    type: z.literal("input"),
    inputType: z.string().max(100),
    composing: z.boolean(),
    proxy,
  }),
  z.object({ type: z.literal("selection"), proxy }),
  z.object({
    type: z.literal("paste"),
    items: z
      .array(
        z.object({
          type: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
          name: z.string().max(255).optional(),
          data: base64,
        }),
      )
      .max(editingClipboardMaxItems),
  }),
  z.object({ type: z.enum(["copy", "cut", "blur", "pointerdown"]) }),
  z.object({ type: z.literal("context"), context: EditingContextSchema.nullable() }),
]);
const packet = z.object({
  id: z.number().int().positive(),
  contextId: z.string().nullable().optional(),
  event,
});
export function decodeBase64(value: string): Uint8Array {
  return decodeBase64Url(value.replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_"));
}
export function encodeBase64(bytes: Uint8Array): string {
  const raw = encodeBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
  return raw.padEnd(Math.ceil(raw.length / 4) * 4, "=");
}
export function decodeNativeEvent(value: unknown): {
  id: number;
  contextId?: string | null;
  event: EditingProxyEvent;
} {
  const decoded = packet.parse(value);
  const metadata = {
    id: decoded.id,
    ...(decoded.contextId === undefined ? {} : { contextId: decoded.contextId }),
  };
  if (decoded.event.type !== "paste") return { ...metadata, event: decoded.event };
  const items = decoded.event.items.map(({ data, type, name }) => ({
    type,
    ...(name === undefined ? {} : { name }),
    bytes: decodeBase64(data),
  }));
  if (items.reduce((size, item) => size + item.bytes.byteLength, 0) > editingClipboardMaxBytes)
    throw new Error("Clipboard data exceeds its bound.");
  return { ...metadata, event: { type: "paste", items } };
}
export function nativeInstruction(
  id: number,
  instruction: EditingProxyInstruction,
): EditingProxyInstruction & { id: number } {
  if (instruction.set) proxy.parse(instruction.set);
  return { id, ...instruction };
}
