import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { CdpSession } from "./backend.js";

/**
 * The centre of an element a page script aimed an event at, in the
 * coordinates `Input.dispatchMouseEvent` takes, with the page scale it was
 * measured at.
 */
export interface ScriptTarget {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

const ScriptTargetSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().finite().positive(),
});
const BindingCalledSchema = z.object({ name: z.string(), payload: z.string().max(256) });
const AddedScriptSchema = z.object({ identifier: z.string() });

/**
 * Reports the element each script-dispatched click, input, change,
 * pointerdown or mousedown in a page's top frame is aimed at, to whoever
 * watches at that moment. One per page, on the page's platform session.
 */
export class PageScriptTargets {
  readonly #cdp: CdpSession;
  readonly #binding = `opensteerTarget_${randomUUID().replaceAll("-", "")}`;
  readonly #world = `opensteer-targets-${randomUUID()}`;
  readonly #watchers = new Set<(target: ScriptTarget) => void>();
  /** The page script's identifier, once Chromium has it. */
  #script: Promise<string | null> | null = null;
  #closed = false;

  constructor(cdp: CdpSession) {
    this.#cdp = cdp;
    cdp.on("Runtime.bindingCalled", this.#onBinding);
  }

  /**
   * Installs the page script unless it is installed or installing. A failed
   * install, such as one a renderer swap interrupts, is tried again on the
   * next call. A dialog holds it until it closes; nothing waits for it.
   */
  start(): void {
    if (this.#closed || this.#script) return;
    const script: Promise<string | null> = this.#install().catch(() => {
      if (this.#script === script) this.#script = null;
      return null;
    });
    this.#script = script;
  }

  /** Hears each target until the returned stop, installing the page script if it is missing. */
  watch(watcher: (target: ScriptTarget) => void): () => void {
    this.start();
    this.#watchers.add(watcher);
    return () => {
      this.#watchers.delete(watcher);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#watchers.clear();
    this.#cdp.off("Runtime.bindingCalled", this.#onBinding);
    const script = this.#script;
    if (!script) return;
    // Electron's pages share one debugger, which keeps a script and binding
    // after this session releases, so removal is sent before it does. Only the
    // script's identifier is awaited, briefly: a dialog can hold the install.
    void this.#cdp.send("Runtime.removeBinding", { name: this.#binding }).catch(() => undefined);
    const identifier = await withTimeout(script, 250, {
      timeoutError: () => new Error("The page script is still installing."),
    }).catch(() => null);
    if (identifier !== null)
      void this.#cdp
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier })
        .catch(() => undefined);
  }

  async #install(): Promise<string> {
    // One session delivers these in order. Without Runtime enabled here,
    // Chromium reports no call of the binding.
    const [, , added] = await Promise.all([
      this.#cdp.send("Runtime.enable"),
      this.#cdp.send("Runtime.addBinding", {
        name: this.#binding,
        executionContextName: this.#world,
      }),
      // Later documents get the script only while Page is enabled on this
      // session; the surface ledger enables it for the page's lifetime.
      this.#cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: pageScript(this.#binding),
        worldName: this.#world,
        runImmediately: true,
      }),
    ]);
    return AddedScriptSchema.parse(added).identifier;
  }

  readonly #onBinding = (value: unknown): void => {
    const event = BindingCalledSchema.safeParse(value);
    if (!event.success || event.data.name !== this.#binding || !this.#watchers.size) return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data.payload);
    } catch {
      return;
    }
    const target = ScriptTargetSchema.safeParse(payload);
    if (!target.success) return;
    for (const watcher of this.#watchers) watcher(target.data);
  };
}

// Runs in a private world, so the page can neither see nor replace it. Only an
// element's centre and the page scale cross the binding: never a value, text,
// selector or attribute. Trusted events come from the person or from Input
// commands, which carry their own points.
function pageScript(binding: string): string {
  return `(() => {
  if (window !== window.top || globalThis.opensteerScriptTargets) return;
  globalThis.opensteerScriptTargets = true;
  const aimed = (event) => {
    if (event.isTrusted) return;
    const element = event.composedPath()[0];
    if (!(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const view = globalThis.visualViewport;
    globalThis[${JSON.stringify(binding)}]?.(JSON.stringify({
      x: rect.left + rect.width / 2 - (view ? view.offsetLeft : 0),
      y: rect.top + rect.height / 2 - (view ? view.offsetTop : 0),
      scale: view ? view.scale : 1,
    }));
  };
  for (const type of ["click", "input", "change", "pointerdown", "mousedown"])
    addEventListener(type, aimed, { capture: true, passive: true });
})()`;
}
