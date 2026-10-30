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
  ) {
    this.#cdp = cdp;
    this.#mapGeometry = geometry;
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
        );
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
        source: editingObserverSource(this.#binding),
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
    if (frame.success && this.#focused?.frame === frame.data.frame.id) this.#clear();
  };
  #contextsCleared = (): void => {
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

function editingObserverSource(binding: string): string {
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
    mirrorPrefix.data = element.value.slice(0, position);
    mirrorSuffix.data = element.value.slice(position);
    if (!mirror.isConnected) document.documentElement.append(mirror);
    mirror.scrollLeft = element.scrollLeft;
    mirror.scrollTop = element.scrollTop;
    const result = mirrorMarker.getBoundingClientRect();
    mirrorPrefix.data = "";
    mirrorSuffix.data = "";
    return result;
  };
  const publish = () => {
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
    beginInput,
    finishInput,
    publish: () => {
      last = null;
      schedule();
    },
    prepare,
    stop: () => {
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
