import {
  personSaveVerdictMaxMs,
  PersonFillRoleSchema,
  type PersonFillAnchor,
  type PersonFillRole,
  type PersonFillSlot,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EditingContextSchema,
  type EditingContext,
  type EditingComposition,
  type EditingTextEdit,
} from "@opensteer/protocol/editing";
import { ExecutionContextInventory } from "@opensteer/browser-core";
import { FrameCdpSessions } from "./frame-cdp.js";
import type { CdpSession } from "./backend.js";

const contextReport = z.object({
  fieldId: z.string().nullable(),
  selectionRevision: z.number().int().nonnegative().optional().default(0),
  field: EditingContextSchema.shape.field,
  caret: z
    .object({ x: z.number().finite(), y: z.number().finite(), height: z.number().finite() })
    .nullable(),
});
const bindingReport = z.object({
  name: z.string(),
  payload: z.string().max(8192),
  executionContextId: z.number(),
});
const prepared = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  replacementStart: z.number().optional(),
  replacementEnd: z.number().optional(),
});

type MenuFacts = {
  x: number;
  y: number;
  editable: boolean;
  selection: boolean;
  linkUrl?: string | undefined;
};
type MenuPublisher = (menu: MenuFacts, coordinates: Promise<EditingContext["caret"]>) => void;

const personReport = z.object({
  kind: z.literal("person-fill"),
  bindingId: z.uuid(),
  role: PersonFillRoleSchema,
  activated: z.boolean(),
  box: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative().finite(),
    height: z.number().nonnegative().finite(),
  }),
  slots: z.object({ partner: z.boolean(), group: z.boolean() }),
});
const frameTree = z.object({
  frame: z.object({ id: z.string(), securityOrigin: z.string().optional() }),
  childFrames: z.array(z.unknown()).optional(),
});
/** An exact HTTPS origin, or null for an opaque, insecure or malformed one. */
function exactHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function committedOrigin(tree: unknown, frameId: string): string | null {
  const parsed = frameTree.safeParse(tree);
  if (!parsed.success) return null;
  if (parsed.data.frame.id === frameId) {
    try {
      const origin = new URL(parsed.data.frame.securityOrigin ?? "");
      return origin.protocol === "https:" ? origin.origin : null;
    } catch {
      return null;
    }
  }
  for (const child of parsed.data.childFrames ?? []) {
    const origin = committedOrigin(child, frameId);
    if (origin) return origin;
  }
  return null;
}

const saveSnapshotReport = z.object({
  kind: z.literal("person-save"),
  snapshotId: z.uuid(),
  fieldIds: z.array(z.uuid()).min(1).max(2),
  username: z.string().min(1).max(1_024),
  password: z.string().min(1).max(4_096),
  origin: z.string().max(2_048),
});
const saveEditReport = z.object({
  kind: z.literal("person-save-edit"),
  fieldId: z.uuid(),
  at: z.number().finite().positive(),
});
const saveGoneReport = z.object({ kind: z.literal("person-save-gone"), snapshotId: z.uuid() });
/** How long a page must stay without a password field before a sign-in looks done. */
export const personSaveSettleMs = 2_000;

/**
 * A login a person submitted, read once in the private world. Its values
 * never enter an event, a log or the wire; see docs/passwords.md#saving-for-people.
 */
export interface PersonSaveSnapshot {
  /** The password fields it came from, as their edits were reported. */
  readonly fieldIds: readonly string[];
  readonly username: string;
  readonly password: string;
  /** The submitting document's HTTPS origin, read in the page as it submitted. */
  readonly origin: string;
  /**
   * Whether the sign-in looks done: its form left the page, or the frame
   * moved on, and no password field is shown there `personSaveSettleMs`
   * later. A page can fake this; it decides only when to ask.
   */
  verdict(signal: AbortSignal): Promise<boolean>;
}
export type PersonSaveObservation =
  /** A trusted edit into a password field, at `at` by this machine's clock. */
  | { type: "edit"; fieldId: string; at: number }
  | { type: "snapshot"; snapshot: PersonSaveSnapshot };

export interface PersonFillBinding {
  readonly bindingId: string;
  readonly frame: string;
  readonly role: PersonFillRole;
  readonly slots: { partner: boolean; group: boolean };
  origin(): Promise<string | null>;
  write(slot: PersonFillSlot, value: string, expectedOrigin: string): Promise<boolean>;
  release(): void;
}
export type PersonFillObservation =
  | {
      type: "binding";
      binding: PersonFillBinding;
      activated: boolean;
      anchor: Promise<PersonFillAnchor | null>;
    }
  | { type: "withdrawn"; bindingId: string }
  | { type: "focus"; bindingId: string | null };

/** Owns one private editing world in every frame of a page's renderer. */
export class PageEditingObserver {
  readonly #cdp: CdpSession;
  readonly #frames: FrameCdpSessions;
  readonly #children = new Map<CdpSession, PageEditingObserver>();
  readonly #mapGeometry:
    | ((
        frameId: string,
        caret: z.infer<typeof contextReport>["caret"],
      ) => Promise<EditingContext["caret"]>)
    | undefined;
  #activeChild: PageEditingObserver | null = null;
  readonly #binding = `opensteerEditing_${randomUUID().replaceAll("-", "")}`;
  readonly #world = `opensteer-editing-${randomUUID()}`;
  readonly #publish: (context: EditingContext) => void;
  readonly #menu: MenuPublisher;
  readonly #person: ((event: PersonFillObservation) => void) | undefined;
  readonly #personBindings = new Map<string, { binding: PersonFillBinding; context: number }>();
  readonly #save: ((event: PersonSaveObservation) => void) | undefined;
  /** The page's own observer, which holds every verdict so one outlives its frame's renderer. */
  #root: PageEditingObserver | null = null;
  readonly #saveWatchers = new Map<
    string,
    { frame: string; left: () => void; end: (done: boolean) => void }
  >();
  readonly #contexts = new Map<number, string>();
  readonly #inventory = new ExecutionContextInventory();
  #focused: { context: number; frame: string; fieldId: string; selectionRevision: number } | null =
    null;
  #context: EditingContext = { contextId: randomUUID(), field: null, caret: null };
  #composition = false;
  #script: string | null = null;
  #closed = false;
  #generation = 0;
  #geometrySequence = 0;
  #rootFrame: string | null = null;

  constructor(
    cdp: CdpSession,
    publish: (context: EditingContext) => void,
    menu: MenuPublisher = () => {},
    geometry?: (
      frameId: string,
      caret: z.infer<typeof contextReport>["caret"],
    ) => Promise<EditingContext["caret"]>,
    person?: (event: PersonFillObservation) => void,
    save?: (event: PersonSaveObservation) => void,
  ) {
    this.#cdp = cdp;
    this.#mapGeometry = geometry;
    this.#person = person;
    this.#save = save;
    this.#frames = new FrameCdpSessions(
      cdp,
      (session) => {
        const child = new PageEditingObserver(
          session,
          (context) => {
            if (context.field) {
              this.#activeChild = child;
              this.#context = context;
              this.#publish(context);
            } else if (this.#activeChild === child) {
              this.#activeChild = null;
              this.#clear();
            }
          },
          (menu, coordinates) => this.#menu(menu, coordinates),
          (frame, caret) => this.#geometry(frame, caret),
          this.#person,
          this.#save,
        );
        child.#root = this.#root ?? this;
        this.#children.set(session, child);
        void session
          .send("Page.enable")
          .then(() => child.start())
          .catch(() => undefined);
      },
      (session) => {
        const child = this.#children.get(session);
        this.#children.delete(session);
        if (child) {
          if (this.#activeChild === child) {
            this.#activeChild = null;
            this.#clear();
          }
          void child.close();
        }
      },
    );
    this.#publish = publish;
    this.#menu = menu;
    cdp.on("Runtime.bindingCalled", this.#onBinding);
    cdp.on("Runtime.executionContextCreated", this.#onContext);
    cdp.on("Runtime.executionContextsCleared", this.#contextsCleared);
    cdp.on("Page.frameNavigated", this.#navigated);
    cdp.on("Runtime.executionContextDestroyed", this.#destroyed);
  }

  get context(): EditingContext {
    return this.#context;
  }

  async sensitive(): Promise<boolean> {
    for (const child of this.#children.values()) if (await child.sensitive()) return true;
    for (const contextId of this.#contexts.keys()) {
      const result = await this.#cdp
        .send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
          contextId,
          expression: "globalThis.editingOwner?.sensitive()",
          returnByValue: true,
          silent: true,
        })
        .catch(() => null);
      if (result?.result?.value === true) return true;
    }
    return false;
  }

  async start(): Promise<void> {
    const tree = await this.#cdp.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
    );
    this.#rootFrame = tree.frameTree.frame.id;
    // A streamed page has DOM focus without owning a native foreground window.
    if (!this.#mapGeometry)
      await this.#cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.#cdp.send("Runtime.enable");
    await this.#cdp.send("Runtime.addBinding", {
      name: this.#binding,
      executionContextName: this.#world,
    });
    const result = await this.#cdp.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: editingObserverSource(
          this.#binding,
          this.#person !== undefined,
          this.#save !== undefined,
        ),
        worldName: this.#world,
        runImmediately: true,
      },
    );
    this.#script = result.identifier;
    await this.#frames.start();
  }

  refresh(): void {
    for (const child of this.#children.values()) child.refresh();
    for (const contextId of this.#contexts.keys())
      void this.#cdp
        .send("Runtime.evaluate", {
          contextId,
          expression: "globalThis.editingOwner?.publish()",
          silent: true,
        })
        .catch(() => undefined);
  }

  async edit(
    edit: EditingComposition | EditingTextEdit,
    composition: boolean,
    admitted?: () => void,
  ): Promise<boolean> {
    if (this.#activeChild) return this.#activeChild.edit(edit, composition, admitted);
    const focus = this.#focused;
    if (!focus || edit.contextId !== this.#context.contextId) return this.#stale();
    const generation = this.#generation;
    const response = await this.#cdp
      .send<{
        result?: { value?: unknown; type?: string };
        exceptionDetails?: { text?: string; exception?: { className?: string } };
      }>("Runtime.evaluate", {
        contextId: focus.context,
        expression: `globalThis.editingOwner?.prepare(${JSON.stringify({ fieldId: focus.fieldId, revision: focus.selectionRevision, before: edit.before ?? "", after: edit.after ?? "", composing: this.#composition, deleting: !composition && edit.text.length === 0 })})`,
        returnByValue: true,
        silent: true,
      })
      .catch(() => null);
    const parsed = prepared.safeParse(response?.result?.value);
    if (!parsed.success || !parsed.data.ok || generation !== this.#generation) {
      if (parsed.success && parsed.data.ok) await this.#finishInput(focus.context);
      if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
        console.info(
          JSON.stringify({
            editingRefusal: parsed.success
              ? (parsed.data.reason ?? "context-changed")
              : "invalid-verification",
            responseType: response?.result?.type,
            exceptionClass: response?.exceptionDetails?.exception?.className,
            transportFailed: response === null,
          }),
        );
      return this.#stale();
    }
    try {
      admitted?.();
      if (composition && "selectionStart" in edit) {
        await this.#cdp.send("Input.imeSetComposition", {
          text: edit.text,
          selectionStart: edit.selectionStart,
          selectionEnd: edit.selectionEnd,
          ...(parsed.data.replacementStart === undefined
            ? {}
            : {
                replacementStart: parsed.data.replacementStart,
                replacementEnd: parsed.data.replacementEnd,
              }),
        });
        this.#composition = edit.text.length > 0;
      } else {
        if (
          parsed.data.replacementStart !== undefined &&
          ((edit.before?.length ?? 0) > 0 || (edit.after?.length ?? 0) > 0)
        )
          await this.#cdp.send("Input.imeSetComposition", {
            text: edit.text,
            selectionStart: edit.text.length,
            selectionEnd: edit.text.length,
            replacementStart: parsed.data.replacementStart,
            replacementEnd: parsed.data.replacementEnd,
          });
        if (edit.text.length) await this.#cdp.send("Input.insertText", { text: edit.text });
        else
          await this.#cdp.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
            commands: ["deleteBackward"],
          });
        this.#composition = false;
      }
      return true;
    } finally {
      await this.#finishInput(focus.context);
    }
  }

  async input<T>(action: () => Promise<T>): Promise<T> {
    if (this.#activeChild) return this.#activeChild.input(action);
    const context = this.#focused?.context;
    if (context === undefined) return action();
    await this.#cdp.send("Runtime.evaluate", {
      contextId: context,
      expression: "globalThis.editingOwner?.beginInput()",
      silent: true,
    });
    try {
      return await action();
    } finally {
      await this.#finishInput(context);
    }
  }

  async #finishInput(contextId: number): Promise<void> {
    await this.#cdp
      .send("Runtime.evaluate", {
        contextId,
        expression: "globalThis.editingOwner?.finishInput()",
        silent: true,
      })
      .catch(() => undefined);
  }

  #stale(): false {
    this.#generation++;
    this.#composition = false;
    this.#context = { ...this.#context, contextId: randomUUID() };
    this.#publish(this.#context);
    this.refresh();
    return false;
  }

  #clear = (): void => {
    this.#generation++;
    this.#focused = null;
    this.#composition = false;
    if (!this.#activeChild) {
      this.#context = { contextId: randomUUID(), field: null, caret: null };
      this.#publish(this.#context);
    }
  };
  #navigated = (value: unknown): void => {
    const frame = z.object({ frame: z.object({ id: z.string() }) }).safeParse(value);
    if (frame.success) {
      for (const watcher of (this.#root ?? this).#saveWatchers.values())
        if (watcher.frame === frame.data.frame.id) watcher.left();
      this.#withdrawBindings((entry) => entry.binding.frame === frame.data.frame.id);
      if (this.#focused?.frame === frame.data.frame.id) this.#clear();
    }
  };
  #contextsCleared = (): void => {
    this.#withdrawBindings(() => true);
    this.#inventory.clear();
    this.#contexts.clear();
    this.#activeChild = null;
    this.#clear();
  };
  #destroyed = (value: unknown): void => {
    const event = z.record(z.string(), z.unknown()).safeParse(value);
    if (!event.success) return;
    const entry = this.#inventory.observe("Runtime.executionContextDestroyed", event.data);
    if (!entry) return;
    this.#withdrawBindings((binding) => binding.context === entry.id);
    this.#contexts.delete(entry.id);
    if (this.#focused?.context === entry.id) this.#clear();
  };
  #onContext = (value: unknown): void => {
    const event = z.record(z.string(), z.unknown()).safeParse(value);
    if (!event.success) return;
    const entry = this.#inventory.observe("Runtime.executionContextCreated", event.data);
    if (entry?.description.name === this.#world && entry.frameId)
      this.#contexts.set(entry.id, entry.frameId);
  };
  #onBinding = (value: unknown): void => {
    const parsed = bindingReport.safeParse(value);
    if (!parsed.success || parsed.data.name !== this.#binding || this.#closed) return;
    const frame = this.#contexts.get(parsed.data.executionContextId);
    if (!frame) return;
    let payload: unknown;
    try {
      payload = JSON.parse(parsed.data.payload);
    } catch {
      return;
    }
    if (this.#saveReport(payload, frame)) return;
    if (this.#personReport(payload, parsed.data.executionContextId, frame)) return;
    const menu = z
      .object({
        kind: z.literal("menu"),
        x: z.number().finite(),
        y: z.number().finite(),
        editable: z.boolean(),
        selection: z.boolean(),
        linkUrl: z.string().max(16384).optional(),
      })
      .safeParse(payload);
    if (menu.success) {
      const { kind: _kind, x, y, ...facts } = menu.data;
      this.#menu({ ...facts, x, y }, this.#geometry(frame, { x, y, height: 0 }));
      return;
    }
    const report = contextReport.safeParse(payload);
    if (!report.success) return;
    const { fieldId, field, caret, selectionRevision } = report.data;
    if (!fieldId || !field) {
      if (this.#focused?.context === parsed.data.executionContextId) this.#clear();
      return;
    }
    const childWasActive = this.#activeChild !== null;
    this.#activeChild = null;
    const changed =
      childWasActive ||
      this.#focused?.context !== parsed.data.executionContextId ||
      this.#focused?.fieldId !== fieldId ||
      this.#focused?.selectionRevision !== selectionRevision;
    if (changed) {
      this.#generation++;
      this.#composition = false;
    }
    this.#focused = { context: parsed.data.executionContextId, frame, fieldId, selectionRevision };
    const contextId = changed ? randomUUID() : this.#context.contextId;
    this.#context = { contextId, field, caret: this.#context.caret };
    // Resolve frame ownership through CDP, including cross-origin frames; the
    // private world's payload contains only geometry and field facts.
    const generation = this.#generation;
    const sequence = ++this.#geometrySequence;
    void this.#geometry(frame, caret)
      .then((mapped) => {
        if (this.#closed || generation !== this.#generation || sequence !== this.#geometrySequence)
          return;
        this.#context = { contextId, field, caret: mapped };
        this.#publish(this.#context);
      })
      .catch(() => undefined);
  };

  #withdrawBindings(
    matches: (entry: { binding: PersonFillBinding; context: number }) => boolean,
  ): void {
    for (const [id, entry] of this.#personBindings) {
      if (!matches(entry)) continue;
      entry.binding.release();
      this.#person?.({ type: "withdrawn", bindingId: id });
    }
  }

  /** Consumes every save report, even a malformed one, so a value is never handled twice. */
  #saveReport(payload: unknown, frame: string): boolean {
    if (!this.#save || !payload || typeof payload !== "object" || !("kind" in payload))
      return false;
    const kind = (payload as { kind: unknown }).kind;
    if (kind === "person-save-edit") {
      const edit = saveEditReport.safeParse(payload);
      if (edit.success) this.#save({ type: "edit", fieldId: edit.data.fieldId, at: edit.data.at });
      return true;
    }
    if (kind === "person-save-gone") {
      const gone = saveGoneReport.safeParse(payload);
      if (gone.success) (this.#root ?? this).#saveWatchers.get(gone.data.snapshotId)?.left();
      return true;
    }
    if (kind !== "person-save") return false;
    const report = saveSnapshotReport.safeParse(payload);
    if (!report.success) return true;
    const { snapshotId, fieldIds, username, password } = report.data;
    const origin = exactHttpsOrigin(report.data.origin);
    if (!origin) return true;
    // Watched from the report on: the page can move on before anyone asks for the verdict.
    const verdict = this.#watchSave(snapshotId, frame);
    this.#save({ type: "snapshot", snapshot: { fieldIds, username, password, origin, verdict } });
    return true;
  }

  #watchSave(snapshotId: string, frame: string): PersonSaveSnapshot["verdict"] {
    const owner = this.#root ?? this;
    let resolve: (done: boolean) => void = () => {};
    const result = new Promise<boolean>((settle) => (resolve = settle));
    let settling: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const end = (done: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(settling);
      clearTimeout(expiry);
      owner.#saveWatchers.delete(snapshotId);
      resolve(done);
    };
    const left = () => {
      if (settling !== undefined || ended || owner.#closed) return;
      settling = setTimeout(
        () => void owner.#passwordShownAnywhere(frame).then((shown) => end(shown === false)),
        personSaveSettleMs,
      );
    };
    const expiry = setTimeout(() => end(false), personSaveVerdictMaxMs);
    owner.#saveWatchers.set(snapshotId, { frame, left, end });
    return (signal) => {
      if (signal.aborted) end(false);
      else signal.addEventListener("abort", () => end(false), { once: true });
      return result;
    };
  }

  /** Asks whichever renderer holds the frame now; a frame keeps its id across renderers. */
  async #passwordShownAnywhere(frame: string): Promise<boolean | null> {
    const own = await this.#passwordShown(frame);
    if (own !== null) return own;
    for (const child of this.#children.values()) {
      const shown = await child.#passwordShownAnywhere(frame);
      if (shown !== null) return shown;
    }
    return null;
  }

  /** Null when the frame has no private world to ask, such as one that left this renderer. */
  async #passwordShown(frame: string): Promise<boolean | null> {
    const context = [...this.#contexts].findLast(([, owner]) => owner === frame)?.[0];
    if (context === undefined) return null;
    const response = await this.#cdp
      .send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        contextId: context,
        expression: "globalThis.editingOwner?.passwordShown()",
        returnByValue: true,
        silent: true,
      })
      .catch(() => null);
    const value = response?.result?.value;
    return typeof value === "boolean" ? value : null;
  }

  #personReport(payload: unknown, context: number, frame: string): boolean {
    if (!this.#person || !payload || typeof payload !== "object" || !("kind" in payload))
      return false;
    const focus = z
      .object({ kind: z.literal("person-focus"), bindingId: z.uuid().nullable() })
      .safeParse(payload);
    if (focus.success) {
      this.#person({ type: "focus", bindingId: focus.data.bindingId });
      return true;
    }
    const report = personReport.safeParse(payload);
    if (!report.success) return false;
    const { bindingId, role, slots, box, activated } = report.data;
    let entry = this.#personBindings.get(bindingId);
    if (!entry) {
      if (!activated) return true;
      this.#withdrawBindings(() => true);
      const binding: PersonFillBinding = {
        bindingId,
        frame,
        role,
        slots,
        origin: async () => {
          const tree = await this.#cdp
            .send<{ frameTree?: unknown }>("Page.getFrameTree")
            .catch(() => null);
          return this.#personBindings.has(bindingId)
            ? committedOrigin(tree?.frameTree, frame)
            : null;
        },
        write: async (slot, value, expectedOrigin) => {
          if (!this.#personBindings.has(bindingId) || (await binding.origin()) !== expectedOrigin)
            return false;
          const response = await this.#cdp
            .send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
              contextId: context,
              expression: `globalThis.editingOwner?.write(${JSON.stringify(bindingId)},${JSON.stringify(slot)},${JSON.stringify(value)},${JSON.stringify(expectedOrigin)})`,
              returnByValue: true,
              silent: true,
            })
            .catch(() => null);
          return response?.result?.value === true;
        },
        release: () => {
          if (!this.#personBindings.delete(bindingId)) return;
          void this.#cdp
            .send("Runtime.evaluate", {
              contextId: context,
              expression: `globalThis.editingOwner?.release(${JSON.stringify(bindingId)})`,
              silent: true,
            })
            .catch(() => undefined);
        },
      };
      entry = { binding, context };
      this.#personBindings.set(bindingId, entry);
    }
    const anchor = Promise.all([
      this.#geometry(frame, box),
      this.#geometry(frame, { x: box.x + box.width, y: box.y + box.height, height: 0 }),
    ])
      // Corners clamp to the viewport, so a field scrolled out of view has no visible area.
      .then(([start, end]) =>
        start && end && end.x > start.x && end.y > start.y
          ? { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
          : null,
      )
      .catch(() => null);
    this.#person({ type: "binding", binding: entry.binding, activated, anchor });
    return true;
  }

  async #geometry(
    frameId: string,
    caret: z.infer<typeof contextReport>["caret"],
  ): Promise<EditingContext["caret"]> {
    if (!caret) return null;
    let x = caret.x,
      y = caret.y;
    const owner =
      frameId === this.#rootFrame
        ? null
        : await this.#cdp
            .send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId })
            .catch(() => null);
    if (!owner && frameId !== this.#rootFrame) return null;
    if (owner) {
      const box = await this.#cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", {
        backendNodeId: owner.backendNodeId,
      });
      x += box.model.content[0] ?? 0;
      y += box.model.content[1] ?? 0;
    }
    if (this.#mapGeometry)
      return this.#rootFrame
        ? this.#mapGeometry(this.#rootFrame, { x, y, height: caret.height })
        : null;
    const metrics = await this.#cdp.send<{
      cssVisualViewport?: { clientWidth: number; clientHeight: number };
      visualViewport: { clientWidth: number; clientHeight: number };
    }>("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
      x: clamp(x / viewport.clientWidth),
      y: clamp(y / viewport.clientHeight),
      height: clamp(caret.height / viewport.clientHeight),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#withdrawBindings(() => true);
    // A frame's renderer going is its document leaving it: the page's observer
    // judges what comes next. The page's own closing ends every verdict.
    const frames = new Set(this.#contexts.values());
    if (this.#root)
      for (const watcher of this.#root.#saveWatchers.values()) {
        if (frames.has(watcher.frame)) watcher.left();
      }
    else for (const watcher of this.#saveWatchers.values()) watcher.end(false);
    await Promise.all([...this.#children.values()].map((child) => child.close()));
    await this.#frames.close();
    this.#children.clear();
    this.#cdp.off("Runtime.bindingCalled", this.#onBinding);
    this.#cdp.off("Runtime.executionContextCreated", this.#onContext);
    this.#cdp.off("Runtime.executionContextsCleared", this.#contextsCleared);
    this.#cdp.off("Runtime.executionContextDestroyed", this.#destroyed);
    this.#cdp.off("Page.frameNavigated", this.#navigated);
    for (const contextId of this.#contexts.keys())
      void this.#cdp
        .send("Runtime.evaluate", {
          contextId,
          expression: "globalThis.editingOwner?.stop()",
          silent: true,
        })
        .catch(() => undefined);
    if (this.#script)
      void this.#cdp
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.#script })
        .catch(() => undefined);
    void this.#cdp.send("Runtime.removeBinding", { name: this.#binding }).catch(() => undefined);
    this.#contexts.clear();
    if (!this.#mapGeometry)
      void this.#cdp
        .send("Emulation.setFocusEmulationEnabled", { enabled: false })
        .catch(() => undefined);
  }
}

function editingObserverSource(binding: string, personFill: boolean, personSave: boolean): string {
  return `(() => {
  if (globalThis.editingOwner) return;
  const listeners = [],
    ids = new WeakMap();
  let next = 0,
    scheduled = 0,
    last = null,
    anchor = null,
    selectionRevision = 0,
    ownInput = 0,
    mirror = null,
    mirrorPrefix = null,
    mirrorSuffix = null,
    mirrorMarker = null,
    observedEditContext = null,
    stopEditContext = () => {};
  const on = (target, type, fn, options = true) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };
  const active = () => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const identity = (element) => {
    if (!ids.has(element)) ids.set(element, String(++next));
    return ids.get(element);
  };
  const mechanism = (element) =>
    element?.editContext
      ? "editcontext"
      : element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLInputElement &&
            /^(text|search|url|tel|email|password|number)$/i.test(element.type))
        ? "control"
        : element?.isContentEditable
          ? "rich"
          : null;
  const root = (element) => {
    let result = element;
    while (result.parentElement?.isContentEditable) result = result.parentElement;
    return result;
  };
  const selection = (element) => {
    const scope = element.getRootNode();
    return scope.getSelection?.() ?? document.getSelection();
  };
  const selectionAnchor = () => {
    const element = active(), kind = mechanism(element);
    if (!kind) return [element];
    if (kind === "control") return [element, element.selectionStart, element.selectionEnd, element.selectionDirection];
    if (kind === "editcontext") return [element, element.editContext, element.editContext.selectionStart, element.editContext.selectionEnd];
    const s = selection(element);
    return [element, s?.anchorNode, s?.anchorOffset, s?.focusNode, s?.focusOffset];
  };
  const syncSelection = () => {
    if (ownInput) return;
    const current = selectionAnchor();
    if (anchor && (anchor.length !== current.length || anchor.some((value, index) => value !== current[index]))) selectionRevision++;
    anchor = current;
  };
  const beginInput = () => {syncSelection();ownInput++;};
  const finishInput = () => {anchor = selectionAnchor();ownInput = Math.max(0, ownInput - 1);publish();};
  const accept = (result = {ok:true}) => {ownInput++;return result;};
  const rect = (range) => {
    const boxes = range.getClientRects();
    return boxes[boxes.length - 1] ?? range.getBoundingClientRect();
  };
  const caretRect = (element, kind) => {
    if (kind === "editcontext") {
      const ec = element.editContext;
      const boxes = ec.characterBounds();
      const box = boxes[ec.selectionEnd - ec.characterBoundsRangeStart - 1];
      return box ? { x: box.right, y: box.y, height: box.height } : null;
    }
    if (kind === "rich") {
      const s = selection(element);
      if (!s?.rangeCount) return null;
      const r = s.getRangeAt(0).cloneRange();
      r.collapse(false);
      return rect(r);
    }
    const position = element.selectionEnd;
    if (position === null) return null;
    // Removing even an unrelated node closes Blink's native typing command.
    // Keep the measurement tree and update CharacterData without replacing nodes.
    if (!mirror) {
      mirror = document.createElement("div");
      mirrorPrefix = document.createTextNode("");
      mirrorSuffix = document.createTextNode("");
      mirrorMarker = document.createElement("span");
      mirrorMarker.textContent = "​";
      mirror.append(mirrorPrefix, mirrorMarker, mirrorSuffix);
    }
    const style = getComputedStyle(element);
    // The mirror is connected: interleaved style reads/writes would recalculate per property.
    const properties = Array.from(style, name => [name, style.getPropertyValue(name)]);
    const box = element.getBoundingClientRect();
    for (const [name, value] of properties) mirror.style.setProperty(name, value);
    Object.assign(mirror.style, {
      position: "fixed",
      left: box.left + "px",
      top: box.top + "px",
      width: box.width + "px",
      height: box.height + "px",
      visibility: "hidden",
      pointerEvents: "none",
      boxSizing: "border-box",
      margin: "0",
      whiteSpace: element.tagName === "TEXTAREA" ? "pre-wrap" : "pre",
      overflow: "hidden",
    });
    const prefix = element.value.slice(0, position), suffix = element.value.slice(position);
    if (mirrorPrefix.data !== prefix) mirrorPrefix.data = prefix;
    if (mirrorSuffix.data !== suffix) mirrorSuffix.data = suffix;
    if (!mirror.isConnected) document.documentElement.append(mirror);
    mirror.scrollLeft = element.scrollLeft;
    mirror.scrollTop = element.scrollTop;
    const result = mirrorMarker.getBoundingClientRect();
    if (mirrorPrefix.data) mirrorPrefix.data = "";
    if (mirrorSuffix.data) mirrorSuffix.data = "";
    return result;
  };
  const personBindings = new Map(),
    inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let personBinding = null;
  const writable = (element) => {
    if (!(element instanceof HTMLInputElement) || element.ownerDocument !== document ||
        !element.isConnected || element.matches(":disabled") || element.readOnly || element.type === "hidden") return false;
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return style.visibility === "visible" && style.display !== "none" && box.width > 0 && box.height > 0;
  };
  const codeGroup = (element) => {
    if (!element.parentElement) return null;
    const children = Array.from(element.parentElement.children), index = children.indexOf(element);
    const digit = (node) => writable(node) && /^(text|tel|number|password)$/.test(node.type) && node.maxLength === 1;
    if (!digit(element)) return null;
    let start = index, end = index;
    while (start > 0 && digit(children[start - 1])) start--;
    while (end + 1 < children.length && digit(children[end + 1])) end++;
    return end - start + 1 >= 4 && end - start + 1 <= 8 ? children.slice(start, end + 1) : null;
  };
  const loginRole = (element) => {
    if (!writable(element)) return null;
    const autocomplete = (element.autocomplete || "").toLowerCase().split(/\\s+/);
    if (autocomplete.includes("new-password")) return null;
    if (autocomplete.includes("one-time-code") ||
        (/^(text|tel|number)$/.test(element.type) && /otp|totp|2fa|mfa|one.?time|verification|security.?code|auth.?code|passcode/i.test(
          [element.name, element.id, element.autocomplete, element.getAttribute("aria-label"), element.placeholder].join(" "))) || codeGroup(element)) return "code";
    if (element.type === "password") return "password";
    if (autocomplete.includes("username") || autocomplete.includes("email") || element.type === "email" ||
        (/^(text|tel)$/.test(element.type) && /user|email|login|account|identifier/i.test(element.name + " " + element.id))) return "username";
    return null;
  };
  const release = (id) => {
    personBindings.delete(id);
    if (personBinding === id) personBinding = null;
  };
  const publishPerson = (activated = false) => {
    const bound = personBindings.get(personBinding), target = bound?.target.deref();
    if (!bound) return;
    if (!writable(target) || bound.document.deref() !== document) {
      release(personBinding);
      globalThis[${JSON.stringify(binding)}](JSON.stringify({kind:"person-focus",bindingId:null}));
      return;
    }
    const box = target.getBoundingClientRect();
    globalThis[${JSON.stringify(binding)}](JSON.stringify({kind:"person-fill",bindingId:personBinding,role:bound.role,activated,
      box:{x:box.x,y:box.y,width:box.width,height:box.height},slots:{partner:!!bound.partner,group:!!bound.group}}));
  };
  const activatePerson = (element) => {
    const role = loginRole(element);
    if (!role) return;
    if (personBinding) release(personBinding);
    const inputs = element.form ? Array.from(element.form.elements).filter(input => input instanceof HTMLInputElement)
      : Array.from(element.getRootNode().querySelectorAll("input"));
    const index = inputs.indexOf(element), candidates = inputs;
    const partner = role === "username" ? candidates.find(input => inputs.indexOf(input) > index && loginRole(input) === "password")
      : role === "password" ? candidates.findLast(input => inputs.indexOf(input) < index && loginRole(input) === "username") : null;
    const group = role === "code" ? codeGroup(element) : null;
    personBinding = crypto.randomUUID();
    personBindings.set(personBinding, {document:new WeakRef(document),target:new WeakRef(element),role,
      partner:partner ? new WeakRef(partner) : null,group:group?.map(input => new WeakRef(input))});
    publishPerson(true);
  };
  const write = (id, slot, value, expectedOrigin) => {
    const bound = personBindings.get(id);
    const valid = (element) => bound?.document.deref() === document && location.origin === expectedOrigin && writable(element);
    if (!bound || !valid(bound.target.deref())) return false;
    const elements = slot === "group" ? bound.group?.map(input => input.deref())
      : slot === "target" ? [bound.target.deref()] : slot === "partner" && bound.partner ? [bound.partner.deref()] : null;
    if (!elements || (slot === "group" && value.length !== elements.length) || !elements.every(valid)) return false;
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!personBindings.has(id) || !valid(element)) return false;
      inputSetter.call(element, slot === "group" ? value[index] : value);
      element.dispatchEvent(new Event("input", {bubbles:true,composed:true}));
      element.dispatchEvent(new Event("change", {bubbles:true,composed:true}));
    }
    return true;
  };
  if (${personFill}) {
    on(document, "pointerdown", event => {
      if (event.isTrusted) activatePerson(event.composedPath().find(node => node instanceof HTMLInputElement));
    });
    on(document, "keydown", event => {
      if (event.isTrusted && event.key === "ArrowDown") activatePerson(active());
    });
    // Focus moving among the bound fields keeps the binding: code widgets advance
    // to the next box as each digit is written.
    on(document, "focusin", () => {
      const bound = personBindings.get(personBinding);
      const fields = bound ? [bound.target, bound.partner, ...(bound.group ?? [])] : [];
      if (!fields.some(field => field?.deref() === active())) {
        if (personBinding) release(personBinding);
        globalThis[${JSON.stringify(binding)}](JSON.stringify({kind:"person-focus",bindingId:null}));
      }
    });
  }
  // Every password field this document shows, open shadow roots included.
  const passwordShown = (root = document) =>
    Array.from(root.querySelectorAll('input[type="password"]')).some(writable) ||
    Array.from(root.querySelectorAll("*")).some(element => element.shadowRoot && passwordShown(element.shadowRoot));
  // Held weakly, so a field the page drops takes the typed value with it.
  let saveFields = new WeakMap();
  const pendingSaves = new Map();
  let saveWatch = null, lastAttempt = null;
  if (${personSave}) {
    const report = (message) => globalThis[${JSON.stringify(binding)}](JSON.stringify(message));
    const eventTarget = (event) => event.composedPath()[0];
    // Never offered: codes, cards and PINs, whatever the page calls the field.
    const saveExcluded = (element) => {
      const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
      return autocomplete.includes("one-time-code") || autocomplete.some(token => token.startsWith("cc-")) ||
        !!codeGroup(element) ||
        /otp|totp|2fa|mfa|one.?time|verification|security.?code|auth.?code|passcode|\\bpin\\b|pin.?code|cvv|cvc|csc|card/i.test(
          [element.name, element.id, element.getAttribute("aria-label"), element.placeholder].join(" "));
    };
    // A field counts only from a trusted edit into it while empty; a script's
    // edit taints it, and a later value the person did not type never matches.
    on(document, "beforeinput", event => {
      const element = eventTarget(event);
      if (!(element instanceof HTMLInputElement)) return;
      const field = saveFields.get(element);
      if (!event.isTrusted) {
        if (field) field.tainted = true;
        return;
      }
      if (!field && element.type === "password" && element.value === "" && !saveExcluded(element))
        saveFields.set(element, { id: crypto.randomUUID(), value: "", edits: 0, tainted: false });
    });
    on(document, "input", event => {
      const element = eventTarget(event);
      const field = element instanceof HTMLInputElement ? saveFields.get(element) : undefined;
      if (!field) return;
      if (!event.isTrusted) {
        field.tainted = true;
        return;
      }
      field.value = element.value;
      field.edits++;
      report({ kind: "person-save-edit", fieldId: field.id, at: Date.now() });
    });
    const watchSaves = (roots) => {
      saveWatch ??= new MutationObserver(() => {
        for (const [snapshotId, fields] of pendingSaves) {
          if (fields.some(field => writable(field.deref()))) continue;
          pendingSaves.delete(snapshotId);
          report({ kind: "person-save-gone", snapshotId });
        }
        if (!pendingSaves.size) {
          saveWatch?.disconnect();
          saveWatch = null;
        }
      });
      for (const root of roots)
        saveWatch.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    };
    const takeSave = (node) => {
      if (!(node instanceof Node)) return;
      const scope = node.form ?? (node instanceof Element ? node.closest("form") : null) ?? node.getRootNode();
      if (!scope?.querySelectorAll) return;
      const inputs = Array.from(scope.querySelectorAll("input"));
      // One password, or a new one and its confirmation; a change of password is not offered.
      const filled = inputs.filter(input => (input.type === "password" || saveFields.has(input)) && writable(input) && input.value !== "");
      if (!filled.length || filled.length > 2 || (filled.length === 2 && filled[0].value !== filled[1].value)) return;
      if (!filled.every(input => {
        const field = saveFields.get(input);
        return field && !field.tainted && field.value === input.value && !saveExcluded(input);
      })) return;
      const usable = (input) => /^(text|email|tel|hidden)$/.test(input.type) && input.value !== "" && !saveFields.has(input) && !saveExcluded(input);
      const hinted = inputs.find(input => usable(input) && /(^|\\s)(username|email)(\\s|$)/i.test(input.getAttribute("autocomplete") || ""));
      const typed = inputs.filter(input => usable(input) && input.type !== "hidden" && writable(input) &&
        input.compareDocumentPosition(filled[0]) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      const username = (hinted ?? typed)?.value;
      const password = filled[0].value;
      if (!username) return;
      const fieldIds = filled.map(input => saveFields.get(input).id);
      // One attempt sends once, however many submit signals it raises; a new
      // edit or a corrected username is a new attempt. Nothing secret is kept.
      const attempt = JSON.stringify([...filled.map(input => [saveFields.get(input).id, saveFields.get(input).edits]), username]);
      if (attempt === lastAttempt) return;
      lastAttempt = attempt;
      const snapshotId = crypto.randomUUID();
      // The document's effective origin, read before it can navigate: "null" for
      // a sandboxed frame, the creator's for about:blank and srcdoc.
      report({ kind: "person-save", snapshotId, fieldIds, username, password, origin: globalThis.origin });
      pendingSaves.set(snapshotId, filled.map(input => new WeakRef(input)));
      setTimeout(() => pendingSaves.delete(snapshotId), 30000);
      watchSaves(new Set([document, ...filled.map(input => input.getRootNode())]));
    };
    on(document, "submit", event => takeSave(eventTarget(event)));
    on(document, "keydown", event => {
      if (event.isTrusted && event.key === "Enter") takeSave(eventTarget(event));
    });
    on(document, "click", event => {
      if (!event.isTrusted) return;
      const button = event.composedPath().find(node => node instanceof Element &&
        (node.closest("form")
          ? node.matches('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]')
          : node.matches('button:not([type="reset"]), input[type="submit"], input[type="image"], [role="button"]')));
      if (button) takeSave(button);
    });
  }
  const publish = () => {
    publishPerson();
    syncSelection();
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = 0;
    const element = active(),
      kind = mechanism(element);
    if (!document.hasFocus() || !kind || element.disabled || element.readOnly) {
      const message = JSON.stringify({ fieldId: null, field: null, caret: null });
      if (last !== message) {
        last = message;
        globalThis[${JSON.stringify(binding)}](message);
      }
      return;
    }
    if (observedEditContext !== element.editContext) {
      stopEditContext();
      observedEditContext = element.editContext;
      if (observedEditContext) {
        const context = observedEditContext,
          events = [
            "textupdate",
            "textformatupdate",
            "characterboundsupdate",
            "compositionstart",
            "compositionend",
          ];
        for (const event of events) context.addEventListener(event, schedule);
        stopEditContext = () => {
          for (const event of events) context.removeEventListener(event, schedule);
        };
      } else stopEditContext = () => {};
    }
    const field = {
      kind: kind === "control" ? "text" : "rich",
      multiline: kind !== "control" || element.tagName === "TEXTAREA",
      sensitive:
        element.type === "password" ||
        /(?:^|\\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:$|\\s)/.test(
          element.autocomplete ?? "",
        ),
    };
    for (const [attribute, property, allowed] of [
      [
        "inputmode",
        "inputMode",
        ["text", "decimal", "numeric", "tel", "search", "email", "url", "none"],
      ],
      [
        "enterkeyhint",
        "enterKeyHint",
        ["enter", "done", "go", "next", "previous", "search", "send"],
      ],
      [
        "autocapitalize",
        "autocapitalize",
        ["off", "none", "on", "sentences", "words", "characters"],
      ],
    ]) {
      const value = element.getAttribute(attribute);
      if (allowed.includes(value)) field[property] = value;
    }
    if (!field.inputMode && element instanceof HTMLInputElement) {
      const modes = { email: "email", url: "url", tel: "tel", search: "search", number: "decimal" };
      if (modes[element.type]) field.inputMode = modes[element.type];
    }
    let caret = null;
    try {
      const r = caretRect(element, kind);
      if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.height))
        caret = { x: r.x, y: r.y, height: r.height };
    } catch {}
    const message = JSON.stringify({ fieldId: identity(element), selectionRevision, field, caret });
    if (message !== last) {
      last = message;
      globalThis[${JSON.stringify(binding)}](message);
    }
    if (kind === "editcontext" && !scheduled) scheduled = requestAnimationFrame(publish);
  };
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(publish);
  };
  const prepare = (request) => {
    const element = active(),
      kind = mechanism(element);
    if (!kind || !document.hasFocus() || identity(element) !== request.fieldId)
      return { ok: false, reason: "focus-changed" };
    syncSelection();
    if (selectionRevision !== request.revision) return {ok:false,reason:"selection-changed"};
    if (request.composing) return accept();
    const before = request.before,
      after = request.after,
      rangeEdit = !!(before.length || after.length);
    if (kind === "control" || kind === "editcontext") {
      const model = kind === "control" ? element : element.editContext;
      const value = kind === "control" ? model.value : model.text;
      const start = model.selectionStart,
        end = model.selectionEnd;
      if (start === null || end === null)
        return rangeEdit ? {ok:false,reason:"range-unavailable"} : accept();
      if (
        rangeEdit &&
        (start !== end ||
          start < before.length ||
          value.slice(start - before.length, start) !== before ||
          value.slice(end, end + after.length) !== after)
      )
        return { ok: false, reason: "range-mismatch" };
      if (kind === "editcontext" && request.deleting && rangeEdit) {
        model.updateSelection(start - before.length, end + after.length);
        return accept();
      }
      if (kind === "editcontext")
        return accept({
          ok: true,
          replacementStart: start - before.length,
          replacementEnd: end + after.length,
        });
      if (rangeEdit) element.setSelectionRange(start - before.length, end + after.length);
      return accept();
    }
    const s = selection(element);
    if (!s?.rangeCount) return { ok: false };
    const current = s.getRangeAt(0),
      container = root(element);
    if (
      !container.contains(current.startContainer) ||
      !container.contains(current.endContainer) ||
      (rangeEdit && !s.isCollapsed)
    )
      return { ok: false };
    if (!rangeEdit) return accept();
    const prefix = document.createRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(current.startContainer, current.startOffset);
    const start = prefix.toString().length;
    const text = container.textContent;
    if (
      start < before.length ||
      text.slice(start - before.length, start) !== before ||
      text.slice(start, start + after.length) !== after
    )
      return { ok: false };
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node,
      offset = 0,
      from = null,
      to = null;
    while ((node = walker.nextNode())) {
      const end = offset + node.length;
      if (!from && start - before.length <= end) from = [node, start - before.length - offset];
      if (start + after.length <= end) {
        to = [node, start + after.length - offset];
        break;
      }
      offset = end;
    }
    if (!from || !to) return { ok: false };
    const replacement = document.createRange();
    replacement.setStart(...from);
    replacement.setEnd(...to);
    s.removeAllRanges();
    s.addRange(replacement);
    return accept();
  };
  for (const event of [
    "focusin",
    "selectionchange",
    "input",
    "compositionupdate",
    "scroll",
    "resize",
  ])
    on(event === "resize" ? window : document, event, () => {syncSelection();schedule();});
  on(document, "compositionend", () => {
    if (!ownInput) selectionRevision++;
    schedule();
  });
  on(document, "focusout", () => {
    last = null;
    publish();
    queueMicrotask(schedule);
  });
  on(window, "blur", () => {
    last = null;
    publish();
  });
  const resize = new ResizeObserver(schedule);
  if (document.documentElement) resize.observe(document.documentElement);
  else
    on(document, "DOMContentLoaded", () => {
      resize.observe(document.documentElement);
      schedule();
    });
  if (visualViewport) {
    on(visualViewport, "resize", schedule);
    on(visualViewport, "scroll", schedule);
  }
  const isSensitive = (element) =>
    element?.type === "password" ||
    /(?:current-password|new-password|one-time-code|cc-number|cc-csc)/.test(
      element?.autocomplete ?? "",
    );
  const sensitive = () => document.hasFocus() && isSensitive(active());
  on(document, "contextmenu", (event) => {
    const path = event.composedPath(),
      element = path.find((node) => node instanceof HTMLElement),
      link = path.find((node) => node instanceof Element && node.matches("a[href],area[href]"));
    let linkUrl;
    try {
      if (link) linkUrl = new URL(link.getAttribute("href"), link.baseURI).href;
    } catch {}
    const facts = {
      kind: "menu",
      x: event.clientX,
      y: event.clientY,
      editable: !!mechanism(element) && !element.disabled && !element.readOnly,
      selection:
        !isSensitive(element) &&
        !!(
          element?.selectionEnd > element?.selectionStart ||
          String(selection(element ?? document.body))
        ),
      ...(linkUrl && linkUrl.length <= 16384 ? { linkUrl } : {}),
    };
    // Chromium checkpoints microtasks between listeners; wait for the whole dispatch.
    setTimeout(() => {
      if (!event.defaultPrevented) globalThis[${JSON.stringify(binding)}](JSON.stringify(facts));
    }, 0);
  });
  globalThis.editingOwner = {
    sensitive,
    release,
    write,
    passwordShown,
    beginInput,
    finishInput,
    publish: () => {
      last = null;
      schedule();
    },
    prepare,
    stop: () => {
      personBindings.clear();
      saveFields = new WeakMap();
      pendingSaves.clear();
      saveWatch?.disconnect();
      listeners.forEach((fn) => fn());
      stopEditContext();
      resize.disconnect();
      cancelAnimationFrame(scheduled);
      mirror?.remove();
      delete globalThis.editingOwner;
    },
  };
  publish();
})();
`;
}
