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

/**
 * CY4: what a composition's commit adds to a field that already holds `held` from that same
 * composition (the change of its context committed it, or the page ended it keeping its text):
 * nothing when it is that text, the rest when it extends it, all of it when it differs, an
 * insertion that deletes nothing. Each committed text is applied exactly once. The one rule for
 * both cases, wherever a side knows what the field already holds: the phone's reducer (the
 * change of context) and the page's applier (a composition the page ended).
 */
export function committedRemainder(held: string, commit: string): string {
  if (commit === held) return "";
  return commit.startsWith(held) ? commit.slice(held.length) : commit;
}

/**
 * The plain caret moves the phone sends. They are also what a client computes from an edit
 * (moving the caret back where the person had it): after the far side refuses an edit, the moves
 * of that producer under that context go with it until its next edit applies (CY5).
 */
export const caretMoveEditingCommands: ReadonlySet<EditingCommand> = new Set([
  "moveBackward",
  "moveForward",
]);
/**
 * CY7: the commands relative to the caret, the single backward deletion (always a Backspace the
 * person pressed at a caret) and the plain caret moves. Made under an earlier context of the
 * focused field, one of these still applies at the caret as it now is; every other command made
 * under any context but the current one is refused alone.
 */
export const caretRelativeEditingCommands: ReadonlySet<EditingCommand> = new Set([
  "deleteBackward",
  ...caretMoveEditingCommands,
]);

/**
 * Identity of a focused field under the shared editing-admission rule (docs/editing-admission.md).
 * A different element, a recreated element, a changed kind, a changed sensitive flag, or a changed
 * editability flag is another field.
 */
export interface EditingFieldIdentity {
  readonly id: string;
  readonly kind: string;
  readonly sensitive: boolean;
  readonly editable?: boolean | undefined;
}

/**
 * Snapshot of a focused field's selection and optional trailing text before the caret,
 * used to distinguish the viewer's own edit effects from external changes (P4(b)).
 */
export interface EditingObservedState {
  readonly location: number;
  readonly length: number;
  readonly text?: string | null | undefined;
}

function sameObservedState(a: EditingObservedState, b: EditingObservedState): boolean {
  return (
    a.location === b.location && a.length === b.length && (a.text ?? null) === (b.text ?? null)
  );
}

function matchesExpectedState(
  observed: EditingObservedState,
  expected: EditingObservedState,
): boolean {
  if (observed.location !== expected.location || observed.length !== expected.length) return false;
  // Q2: an expected (or observed) state whose text could not be predicted is NOT a match: rotate.
  if (expected.text == null || observed.text == null) return false;
  return observed.text === expected.text;
}

/**
 * The three admission classes in docs/editing-admission.md:
 * - `relative`: insertion, backward deletion, plain caret move, paste (Rule 2)
 * - `named`: text-naming replacement or forward deletion of named text (Rule 3)
 * - `exact`: commands with nothing to verify against live text (Rule 4)
 */
export type EditingAdmissionKind = "relative" | "named" | "exact";

/**
 * Bounded wait decision for a text-naming edit when a target renders input late (Rule 3).
 */
export type NamedTextWaitDecision = "apply" | "wait" | "refuse-mismatch" | "refuse-field";

/** How long a late-rendering target waits for named text to appear before refusing (Rule 3). */
export const editingNamedTextWaitSeconds = 0.5;

export function namedTextWaitDecision(
  sameField: boolean,
  matches: boolean,
  waitedSeconds: number,
  limitSeconds: number = editingNamedTextWaitSeconds,
): NamedTextWaitDecision {
  if (!sameField) return "refuse-field";
  if (matches) return "apply";
  return waitedSeconds < limitSeconds ? "wait" : "refuse-mismatch";
}

export function sameEditingField(
  a: EditingFieldIdentity | null,
  b: EditingFieldIdentity | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.sensitive === b.sensitive &&
    (a.editable ?? true) === (b.editable ?? true)
  );
}

/**
 * Shared state machine for the five-part editing-admission rule (docs/editing-admission.md),
 * verified against packages/protocol/fixtures/editing-admission.json in both TypeScript and Swift.
 */
export class EditingContexts {
  static readonly kept = 64;
  static readonly namedTextWaitSeconds = editingNamedTextWaitSeconds;

  readonly #nextId: () => string;
  #current: string;
  #earlier: string[] = [];
  #field: EditingFieldIdentity | null = null;
  #currentPublished = false;
  #baseline: EditingObservedState | null = null;
  #expected: EditingObservedState[] = [];

  constructor(nextId: () => string = () => crypto.randomUUID()) {
    this.#nextId = nextId;
    this.#current = nextId();
  }

  get current(): string {
    return this.#current;
  }

  get field(): EditingFieldIdentity | null {
    return this.#field;
  }

  get earlier(): readonly string[] {
    return this.#earlier;
  }

  get predictedState(): EditingObservedState | null {
    return this.#expected.at(-1) ?? this.#baseline;
  }

  hasEarlier(contextId: string): boolean {
    return this.#earlier.includes(contextId);
  }

  /**
   * Marks `current` as published to the viewer. Only published contexts enter `earlier` on
   * same-field rotation (P4(c)), so unpublished rotations while batches are pending never evict
   * the viewer's published context.
   */
  markPublished(): void {
    this.#currentPublished = true;
  }

  /** Records the state expected after dispatching one of the viewer's own edits (P4(b)). */
  expectOwnEffect(state: EditingObservedState): void {
    if (this.#field === null) return;
    this.#expected.push(state);
    if (this.#expected.length > EditingContexts.kept) this.#expected.shift();
  }

  /**
   * Observes the currently focused field. Returns true only when the context changed (Rule 5):
   * the field identity changed, or `changed` reports a content/selection change on the same field.
   */
  observe(field: EditingFieldIdentity | null, changed = false): boolean {
    if (!sameEditingField(this.#field, field)) {
      this.#field = field;
      this.#earlier = [];
      this.#expected = [];
      this.#baseline = null;
      this.#current = this.#nextId();
      this.#currentPublished = false;
      return true;
    }
    if (!changed) return false;
    this.rotate(field !== null);
    return true;
  }

  /**
   * Observes the live focused field together with its live selection/text state (P4(b)):
   * - Equal to baseline (unchanged or app has not caught up yet): rotates nothing.
   * - Equal to any expected prefix in `#expected`: consumes that prefix, advances baseline,
   *   rotates nothing.
   * - Anything else (or `forceChanged`, e.g. agent mutation): rotates, clears `#expected`,
   *   and updates baseline.
   */
  observeState(
    field: EditingFieldIdentity | null,
    state: EditingObservedState | null,
    forceChanged = false,
  ): boolean {
    if (!sameEditingField(this.#field, field)) {
      this.#field = field;
      this.#earlier = [];
      this.#expected = [];
      this.#baseline = state;
      this.#current = this.#nextId();
      this.#currentPublished = false;
      return true;
    }
    if (forceChanged) {
      this.#expected = [];
      this.#baseline = state;
      this.rotate(field !== null);
      return true;
    }
    if (state === null) {
      if (this.#baseline === null) return false;
      this.#expected = [];
      this.#baseline = null;
      this.rotate(field !== null);
      return true;
    }
    if (this.#baseline === null) {
      this.#baseline = state;
      return false;
    }
    if (sameObservedState(state, this.#baseline)) return false;
    const matchIndex = this.#expected.findIndex((expected) =>
      matchesExpectedState(state, expected),
    );
    if (matchIndex >= 0) {
      this.#baseline = state;
      this.#expected.splice(0, matchIndex + 1);
      return false;
    }
    this.#expected = [];
    this.#baseline = state;
    this.rotate(field !== null);
    return true;
  }

  /**
   * Rotates to a fresh context. Keeps the previous context in `earlier` only for the same field
   * AND only if that context was published to the viewer (P4(c)).
   */
  rotate(sameField: boolean): string {
    if (sameField && this.#field !== null) {
      if (this.#currentPublished && !this.#earlier.includes(this.#current)) {
        this.#earlier.push(this.#current);
        if (this.#earlier.length > EditingContexts.kept) this.#earlier.shift();
      }
    } else {
      this.#earlier = [];
    }
    this.#expected = [];
    this.#current = this.#nextId();
    this.#currentPublished = false;
    return this.#current;
  }

  /**
   * A text-naming edit mismatched live text in the current field: rotate while a field is focused,
   * without forgetting earlier contexts. With no focused field, rotates nothing (S6).
   */
  mismatch(): string {
    if (this.#field === null) return this.#current;
    return this.rotate(true);
  }

  /** Clears focus and forgets all earlier contexts. */
  reset(): string {
    this.#field = null;
    this.#baseline = null;
    this.#expected = [];
    return this.rotate(false);
  }

  /**
   * Decides whether an edit made under `contextId` is admitted now (Rules 1-4).
   * Under an earlier context of the same field, a relative edit requires a collapsed live
   * selection (`collapsed: true`); under the current context, any selection is admitted.
   * A refusal never mutates state (Rule 5).
   */
  admits(
    contextId: string,
    kind: EditingAdmissionKind,
    options?: {
      readonly namedMatches?: boolean;
      readonly exactNamed?: boolean;
      readonly collapsed?: boolean;
    },
  ): boolean {
    const isCurrent = contextId === this.#current;
    const sameField = isCurrent || (this.#field !== null && this.#earlier.includes(contextId));
    if (!sameField) return false;
    switch (kind) {
      case "relative":
        return isCurrent || (options?.collapsed ?? true);
      case "named":
        if (options?.exactNamed && !isCurrent) return false;
        return options?.namedMatches ?? true;
      case "exact":
        return isCurrent;
    }
  }
}

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
