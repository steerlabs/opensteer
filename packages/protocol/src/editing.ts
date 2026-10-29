import { z } from "zod";

/**
 * The editing vocabulary every streamed surface shares: a browser page, an
 * Agent Phone display and a Mac app view. A viewer sends what the person did,
 * each edit exactly once, and the target applies it through its own editing
 * machinery.
 */

/**
 * `primary` is the viewer platform's command modifier: ⌘ on Apple devices and
 * Ctrl elsewhere. A Mac viewer's Ctrl stays `control` and a PC viewer's
 * Windows key stays `meta`; each target maps `primary` to its own.
 */
export const EditingModifierSchema = z.enum(["alt", "control", "meta", "shift", "primary"]);
export type EditingModifier = z.infer<typeof EditingModifierSchema>;
export const EditingModifiersSchema = z.array(EditingModifierSchema).max(5);

/**
 * What a chord means on the viewer's platform, named as Blink's editing
 * commands. The target performs it as its own platform's chord for the same
 * meaning, so ⌘← from a Mac reaches a Linux page as Home.
 */
export const EditingCommandSchema = z.enum([
  "selectAll",
  "undo",
  "redo",
  "moveBackward",
  "moveForward",
  "moveUp",
  "moveDown",
  "moveWordLeft",
  "moveWordRight",
  "moveWordLeftAndModifySelection",
  "moveWordRightAndModifySelection",
  "moveToLeftEndOfLine",
  "moveToRightEndOfLine",
  "moveToLeftEndOfLineAndModifySelection",
  "moveToRightEndOfLineAndModifySelection",
  "moveToBeginningOfLine",
  "moveToEndOfLine",
  "moveToBeginningOfLineAndModifySelection",
  "moveToEndOfLineAndModifySelection",
  "moveToBeginningOfParagraph",
  "moveToEndOfParagraph",
  "moveToBeginningOfParagraphAndModifySelection",
  "moveToEndOfParagraphAndModifySelection",
  "moveToBeginningOfDocument",
  "moveToEndOfDocument",
  "moveToBeginningOfDocumentAndModifySelection",
  "moveToEndOfDocumentAndModifySelection",
  "deleteBackward",
  "deleteForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteToBeginningOfLine",
  "deleteToEndOfLine",
  "deleteToEndOfParagraph",
  "transpose",
  "yank",
]);
export type EditingCommand = z.infer<typeof EditingCommandSchema>;

/** One grapheme, which a single keystroke types; long enough for ZWJ sequences. */
export const editingKeystrokeTextMaxLength = 64;
/** The most text one composition or text edit carries. */
export const editingTextMaxLength = 10_000;

/**
 * A physical key. `text` is what this keystroke types, applied as part of the
 * key event itself so the page sees one keystroke it may cancel.
 */
export const EditingKeystrokeSchema = z.strictObject({
  action: z.enum(["down", "up"]),
  code: z.string().max(100),
  key: z.string().max(100),
  modifiers: EditingModifiersSchema,
  location: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  repeat: z.boolean().optional(),
  text: z.string().min(1).max(editingKeystrokeTextMaxLength).optional(),
});
export type EditingKeystroke = z.infer<typeof EditingKeystrokeSchema>;

/**
 * Names the focused field an edit was computed against. It changes with the
 * field, and the target also rotates it when it refuses an edit as stale, so a
 * viewer resets what it assumed about the field whenever it changes.
 */
export const EditingContextIdSchema = z.uuid();
export type EditingContextId = z.infer<typeof EditingContextIdSchema>;

/**
 * The composition in progress, replacing the previous one; empty text cancels
 * it. On a transaction's first update, `before` and `after` are the exact text
 * around the caret the composition takes over (a keyboard re-composing a word).
 */
export const EditingCompositionSchema = z
  .strictObject({
    contextId: EditingContextIdSchema,
    text: z.string().max(editingTextMaxLength),
    selectionStart: z.number().int().nonnegative().max(editingTextMaxLength),
    selectionEnd: z.number().int().nonnegative().max(editingTextMaxLength),
    before: z.string().max(editingTextMaxLength).optional(),
    after: z.string().max(editingTextMaxLength).optional(),
  })
  .refine(
    ({ text, selectionStart, selectionEnd }) =>
      selectionStart <= selectionEnd && selectionEnd <= text.length,
    "A composition's selection must lie within its text.",
  );
export type EditingComposition = z.infer<typeof EditingCompositionSchema>;

/**
 * Commits the composition in progress with `text`, or, with none, replaces the
 * exact text `before` (immediately before the caret) and `after` (immediately
 * after it) with `text`. The target verifies both against its own model and
 * refuses a mismatch as stale, so an edit never lands on text it was not
 * computed against. Plain insertion has both empty and replaces a non-collapsed
 * selection as typing does; a range edit requires a collapsed caret.
 */
export const EditingTextEditSchema = z
  .strictObject({
    contextId: EditingContextIdSchema,
    text: z.string().max(editingTextMaxLength),
    before: z.string().max(editingTextMaxLength),
    after: z.string().max(editingTextMaxLength),
  })
  .refine(
    ({ text, before, after }) => text.length > 0 || before.length > 0 || after.length > 0,
    "A text edit must insert or delete something.",
  );
export type EditingTextEdit = z.infer<typeof EditingTextEditSchema>;

/**
 * Where the caret is, in the same normalized picture coordinates as pointer
 * input on that surface: fractions of its width and height.
 */
export const EditingCaretSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type EditingCaret = z.infer<typeof EditingCaretSchema>;

/**
 * The focused field's editing facts, never its contents. `sensitive` marks a
 * password or other secret field: viewers use a secure proxy and the target
 * refuses copy and cut there.
 */
export const EditingFieldSchema = z.strictObject({
  kind: z.enum(["text", "rich"]),
  multiline: z.boolean(),
  sensitive: z.boolean(),
  inputMode: z
    .enum(["text", "decimal", "numeric", "tel", "search", "email", "url", "none"])
    .optional(),
  enterKeyHint: z.enum(["enter", "done", "go", "next", "previous", "search", "send"]).optional(),
  autocapitalize: z.enum(["off", "none", "on", "sentences", "words", "characters"]).optional(),
});
export type EditingField = z.infer<typeof EditingFieldSchema>;

export const EditingContextSchema = z.strictObject({
  contextId: EditingContextIdSchema,
  field: EditingFieldSchema.nullable(),
  caret: EditingCaretSchema.nullable(),
});
export type EditingContext = z.infer<typeof EditingContextSchema>;

/** The most clipboard data one copy, cut, paste or page write carries. */
export const editingClipboardMaxBytes = 16 * 1024 * 1024;
/** Clipboard bytes travel in parts that fit every socket's frame bound. */
export const editingClipboardPartMaxBytes = 512 * 1024;
export const editingClipboardMaxParts = Math.ceil(
  editingClipboardMaxBytes / editingClipboardPartMaxBytes,
);
export const editingClipboardMaxItems = 16;

/**
 * One clipboard representation. Its bytes (UTF-8 for text) follow in order
 * across the operation's parts, after the bytes of the items before it.
 */
export const EditingClipboardItemSchema = z.strictObject({
  type: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  name: z.string().min(1).max(255).optional(),
  size: z.number().int().nonnegative().max(editingClipboardMaxBytes),
});
export type EditingClipboardItem = z.infer<typeof EditingClipboardItemSchema>;
export const EditingClipboardItemsSchema = z
  .array(EditingClipboardItemSchema)
  .min(1)
  .max(editingClipboardMaxItems)
  .refine(
    (items) => items.reduce((total, item) => total + item.size, 0) <= editingClipboardMaxBytes,
    "Clipboard data exceeds its bound.",
  );

export const EditingClipboardOperationIdSchema = z.uuid();
export type EditingClipboardOperationId = z.infer<typeof EditingClipboardOperationIdSchema>;

/** One part of an operation's clipboard bytes, base64-encoded. */
export const EditingClipboardPartSchema = z.strictObject({
  operationId: EditingClipboardOperationIdSchema,
  index: z
    .number()
    .int()
    .nonnegative()
    .max(editingClipboardMaxParts - 1),
  data: z
    .string()
    .max(Math.ceil(editingClipboardPartMaxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type EditingClipboardPart = z.infer<typeof EditingClipboardPartSchema>;

export function editingClipboardPartCount(items: readonly EditingClipboardItem[]): number {
  const bytes = items.reduce((total, item) => total + item.size, 0);
  return Math.max(1, Math.ceil(bytes / editingClipboardPartMaxBytes));
}

export const EditingClipboardOutcomeSchema = z.enum([
  "copied",
  "cut",
  "pasted",
  "empty",
  "refused",
  "too-large",
  "stale",
]);
export type EditingClipboardOutcome = z.infer<typeof EditingClipboardOutcomeSchema>;
