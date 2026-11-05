import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { z } from "zod";
import type { EditingComposition, EditingTextEdit } from "./editing.js";
import { browserBase } from "./browser-message-base.js";
import { BrowserVideoU64Schema } from "./browser-video.js";
import { DisplayStreamIdSchema } from "./media-frame.js";

export const browserPopupContentBytes = 65_536;
export const browserPopupJsonBytes = 524_288;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const bounded = (max: number) =>
  z.string().refine((s) => bytes(s) <= max, "Text exceeds byte budget");
const identity = bounded(512).refine((s) => s.length > 0);
const itemId = bounded(64).refine((s) => s.length > 0);
export const BrowserPopupItemSchema = z.strictObject({
  id: itemId,
  groupId: itemId.optional(),
  kind: z.enum(["option", "group", "separator", "suggestion"]),
  label: bounded(browserPopupContentBytes),
  secondaryLabel: bounded(browserPopupContentBytes).optional(),
  enabled: z.boolean(),
  selected: z.boolean(),
  rtl: z.boolean(),
  directionOverride: z.boolean(),
});
const base = { rtl: z.boolean(), items: z.array(BrowserPopupItemSchema).max(1024) };
const calendar = {
  ...base,
  value: bounded(4096),
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  step: z.number().finite().positive(),
  stepBase: z.number().finite(),
  stepAny: z.boolean(),
  required: z.boolean(),
};
export const BrowserPopupStateSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...base, kind: z.literal("select"), multiple: z.boolean() }),
    z.strictObject({
      ...base,
      kind: z.literal("datalist"),
      items: z.array(BrowserPopupItemSchema).max(512),
    }),
    z.strictObject({ ...calendar, kind: z.literal("date") }),
    z.strictObject({ ...calendar, kind: z.literal("time") }),
    z.strictObject({ ...calendar, kind: z.literal("datetime-local") }),
    z.strictObject({ ...calendar, kind: z.literal("month") }),
    z.strictObject({ ...calendar, kind: z.literal("week") }),
    z.strictObject({
      ...base,
      kind: z.literal("color"),
      value: bounded(4096),
      alpha: z.boolean(),
      colorSpace: z.enum(["srgb", "display-p3"]),
    }),
  ])
  .refine((s) => {
    const ids = new Set(s.items.map((i) => i.id));
    const budget = s.items.reduce(
      (sum, i) =>
        sum +
        32 +
        bytes(i.kind) +
        bytes(i.id) +
        bytes(i.groupId ?? "") +
        bytes(i.label) +
        bytes(i.secondaryLabel ?? ""),
      bytes(s.kind) +
        ("value" in s ? bytes(s.value) : 0) +
        (s.kind === "color" ? bytes(s.colorSpace) : 0),
    );
    return (
      s.items.every((i) =>
        s.kind === "select" ? i.kind !== "suggestion" : i.kind === "suggestion",
      ) &&
      s.items.every(
        (i) =>
          !i.groupId ||
          (i.kind === "option" && s.items.some((g) => g.kind === "group" && g.id === i.groupId)),
      ) &&
      ids.size === s.items.length &&
      budget <= browserPopupContentBytes &&
      bytes(JSON.stringify(s)) <= browserPopupJsonBytes
    );
  }, "Popup exceeds content budget");
export type BrowserPopupState = z.infer<typeof BrowserPopupStateSchema>;
export const BrowserPopupAnswerSchema = z
  .union([
    z.strictObject({ itemIds: z.array(itemId).max(1024) }),
    z.strictObject({ value: bounded(4096) }),
  ])
  .refine((a) => bytes(JSON.stringify(a)) < 63_000, "Answer exceeds private request budget");
export type BrowserPopupAnswer = z.infer<typeof BrowserPopupAnswerSchema>;
export const BrowserPopupRefSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
  streamId: DisplayStreamIdSchema,
  documentGeneration: identity,
  authorityEpoch: identity,
  popupId: identity,
  revision: BrowserVideoU64Schema.refine((v) => v !== "0", "Positive revision required"),
});
export type BrowserPopupRef = z.infer<typeof BrowserPopupRefSchema>;
export const BrowserInputBindingSchema = z.strictObject({
  producerId: z.uuid(),
  viewerSlot: z.uuid(),
  inputGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BrowserInputBinding = z.infer<typeof BrowserInputBindingSchema>;
const route = {
  producerId: z.uuid().optional(),
  viewerSlot: z.uuid().optional(),
  inputGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
const target = { surfaceId: BrowserSurfaceIdSchema, streamId: DisplayStreamIdSchema };
export const BrowserPopupClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...browserBase,
    ...BrowserPopupRefSchema.shape,
    viewerSlot: z.uuid().optional(),
    type: z.literal("popup.answer"),
    operationId: z.uuid(),
    answer: BrowserPopupAnswerSchema,
  }),
  z.strictObject({
    ...browserBase,
    ...BrowserPopupRefSchema.shape,
    viewerSlot: z.uuid().optional(),
    type: z.literal("popup.cancel"),
    operationId: z.uuid(),
  }),
  z.strictObject({
    ...browserBase,
    ...target,
    viewerSlot: z.uuid().optional(),
    type: z.literal("input.control"),
    action: z.enum(["acquire", "release"]),
  }),
]);
export const BrowserPopupServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...BrowserPopupRefSchema.shape,
    ...route,
    type: z.literal("browser.popup.opened"),
    state: BrowserPopupStateSchema,
  }),
  z.strictObject({
    ...BrowserPopupRefSchema.shape,
    ...route,
    type: z.literal("browser.popup.updated"),
    state: BrowserPopupStateSchema,
  }),
  z.strictObject({
    ...BrowserPopupRefSchema.shape,
    ...route,
    type: z.literal("browser.popup.closed"),
    reason: z.enum(["canceled", "applied", "interrupted", "unavailable", "expired"]),
  }),
  z.strictObject({
    ...target,
    ...route,
    type: z.literal("browser.popup.unavailable"),
    reason: z.enum(["limit", "unsupported", "unavailable"]),
  }),
  z.strictObject({
    ...BrowserPopupRefSchema.shape,
    ...route,
    type: z.literal("browser.popup.result"),
    operationId: z.uuid(),
    outcome: z.enum(["applied", "canceled", "refused", "uncertain"]),
    reason: z.enum(["stale", "unavailable", "invalid"]).optional(),
  }),
  z.strictObject({
    ...target,
    type: z.literal("browser.input.control"),
    state: z.enum(["available", "self", "other", "changing"]),
  }),
]);
export type BrowserPopupServerMessage = z.infer<typeof BrowserPopupServerMessageSchema>;
export type BrowserPopupEvent = Extract<
  BrowserPopupServerMessage,
  {
    type:
      | "browser.popup.opened"
      | "browser.popup.updated"
      | "browser.popup.closed"
      | "browser.popup.unavailable";
  }
>;
export function samePopup(a: BrowserPopupRef, b: BrowserPopupRef): boolean {
  return (
    a.surfaceId === b.surfaceId &&
    a.streamId === b.streamId &&
    a.documentGeneration === b.documentGeneration &&
    a.authorityEpoch === b.authorityEpoch &&
    a.popupId === b.popupId
  );
}
export function sameInputBinding(
  a: BrowserInputBinding | null,
  b: BrowserInputBinding | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.producerId === b.producerId &&
    a.viewerSlot === b.viewerSlot &&
    a.inputGeneration === b.inputGeneration
  );
}
export function validatePopupAnswer(state: BrowserPopupState, input: BrowserPopupAnswer): boolean {
  const parsed = BrowserPopupAnswerSchema.safeParse(input);
  if (!parsed.success) return false;
  const a = parsed.data;
  if ("value" in a)
    return (
      state.kind !== "select" &&
      state.kind !== "datalist" &&
      (a.value !== "" || !("required" in state) || !state.required)
    );
  if (new Set(a.itemIds).size !== a.itemIds.length) return false;
  if (!(state.kind === "select" && state.multiple) && a.itemIds.length !== 1) return false;
  return a.itemIds.every((id) =>
    state.items.some(
      (i) => i.id === id && i.enabled && (i.kind === "option" || i.kind === "suggestion"),
    ),
  );
}
/** Native state has irrelevant empty fields. Project explicitly before disclosure. */
export function projectNativePopupState(raw: unknown): BrowserPopupState {
  const record = z
    .object({
      kind: z.string(),
      rtl: z.boolean(),
      items: z
        .array(
          z.object({
            id: z.string(),
            groupId: z.string().optional(),
            kind: z.string(),
            label: z.string(),
            secondaryLabel: z.string().optional(),
            enabled: z.boolean(),
            selected: z.boolean(),
            rtl: z.boolean(),
            directionOverride: z.boolean(),
          }),
        )
        .max(1024),
    })
    .safeParse(raw);
  if (!record.success) throw new Error("Invalid browser popup state.");
  const { kind, rtl } = record.data;
  const items = record.data.items.map(({ groupId, secondaryLabel, ...i }) => ({
    ...i,
    ...(groupId ? { groupId } : {}),
    ...(secondaryLabel && secondaryLabel !== i.label ? { secondaryLabel } : {}),
  }));
  const extra = z.record(z.string(), z.unknown()).safeParse(raw);
  const fields = extra.success ? extra.data : {};
  const result = BrowserPopupStateSchema.safeParse({
    kind,
    rtl,
    items,
    ...(kind === "select"
      ? { multiple: fields.multiple }
      : kind === "datalist"
        ? {}
        : kind === "color"
          ? {
              value: fields.value,
              alpha: fields.alpha,
              colorSpace: fields.colorSpace === "limited-srgb" ? "srgb" : fields.colorSpace,
            }
          : {
              value: fields.value,
              minimum: fields.minimum,
              maximum: fields.maximum,
              step: fields.step,
              stepBase: fields.stepBase,
              stepAny: fields.stepAny,
              required: fields.required,
            }),
  });
  if (!result.success) throw new Error("Invalid browser popup state.");
  return result.data;
}

/** Composition/replacement require a future native contract; never translate them to CDP. */
export type BrowserPrivateEdit =
  | {
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      modifiers: number;
      text: string;
    }
  | { type: "insertText"; text: string };
/** Optional native extension. The supplied owner deliberately implements neither operation. */
export interface BrowserPrivateCompositionPort {
  readonly compositionVersion: 1;
  compose(input: EditingComposition): Promise<{ dispatched: boolean }>;
  replace(input: EditingTextEdit): Promise<{ dispatched: boolean }>;
}
export const BrowserClickRefusalReasonSchema = z.enum([
  "stale",
  "geometry",
  "obstructed",
  "busy",
  "pendingInput",
  "unsupported",
]);
export type BrowserClickRefusalReason = z.infer<typeof BrowserClickRefusalReasonSchema>;
