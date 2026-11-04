import {
  BrowserSurfaceIdSchema,
  samePopup,
  validatePopupAnswer,
  type BrowserPopupRef,
  type BrowserPopupState,
  type BrowserPopupAnswer,
  type BrowserServerMessage,
  type BrowserClickRefusalReason,
  type DisplayStreamId,
} from "@opensteer/protocol";
import type { BrowserCommand } from "./client.js";
export interface BrowserPopupView {
  readonly negotiated: boolean;
  readonly streamId: DisplayStreamId | null;
  readonly control: "available" | "self" | "other" | "changing";
  readonly popup: { readonly ref: BrowserPopupRef; readonly state: BrowserPopupState } | null;
  readonly pending: boolean;
  readonly notice: string | null;
  readonly highlighted: string | null;
}
export interface BrowserPopupTarget {
  get(): BrowserPopupView;
  subscribe(listener: () => void): () => void;
  answer(ref: BrowserPopupRef, answer: BrowserPopupAnswer): boolean;
  cancel(ref?: BrowserPopupRef): void;
  presentationFailed(ref: BrowserPopupRef): void;
  acquire(): void;
  release(): void;
  consumeKey(key: string, code: string, phase: "down" | "up"): boolean;
}
const empty: BrowserPopupView = {
  negotiated: false,
  streamId: null,
  control: "available",
  popup: null,
  pending: false,
  notice: null,
  highlighted: null,
};
interface Target {
  session: string;
  surface: string;
  view: BrowserPopupView;
  listeners: Set<() => void>;
  epoch: number;
  pending: { id: string; ref: BrowserPopupRef; timer: ReturnType<typeof setTimeout> } | null;
  consumed: Set<string>;
}
/** Only the current socket admission may install state. Nothing here is persisted or replayed. */
export class BrowserPopupStore {
  readonly #targets = new Map<string, Target>();
  readonly #send: (session: string, surface: string, command: BrowserCommand) => void;
  constructor(send: (session: string, surface: string, command: BrowserCommand) => void) {
    this.#send = send;
  }
  #target(session: string, surface: string): Target {
    const key = JSON.stringify([session, surface]);
    let target = this.#targets.get(key);
    if (!target) {
      if (this.#targets.size >= 128) {
        const removable = [...this.#targets].find(
          ([, t]) => !t.listeners.size && !t.view.popup && !t.pending,
        );
        if (removable) this.#targets.delete(removable[0]);
        else throw new Error("Too many browser popup views.");
      }
      target = {
        session,
        surface,
        view: empty,
        listeners: new Set(),
        epoch: 0,
        pending: null,
        consumed: new Set(),
      };
      this.#targets.set(key, target);
    }
    return target;
  }
  #set(t: Target, view: BrowserPopupView): void {
    t.view = view;
    for (const listener of t.listeners) listener();
  }
  #clearPending(t: Target): void {
    if (t.pending) clearTimeout(t.pending.timer);
    t.pending = null;
  }
  target(session: string, surface: string): BrowserPopupTarget {
    const t = this.#target(session, surface);
    return {
      get: () => t.view,
      subscribe: (fn) => {
        t.listeners.add(fn);
        return () => {
          t.listeners.delete(fn);
        };
      },
      answer: (ref, a) => this.#answer(t, ref, a),
      cancel: (ref) => this.#cancel(t, ref),
      presentationFailed: (ref) => {
        this.#cancel(t, ref);
        this.#set(t, { ...t.view, notice: "This picker is unavailable in this view." });
      },
      acquire: () => this.#control(t, "acquire"),
      release: () => {
        this.#control(t, "release");
        this.#clearPending(t);
        ++t.epoch;
        t.consumed.clear();
        this.#set(t, {
          ...t.view,
          popup: null,
          pending: false,
          highlighted: null,
          control: "available",
        });
      },
      consumeKey: (key, code, phase) => this.#key(t, key, code, phase),
    };
  }
  negotiate(session: string, surface: string, enabled: boolean): void {
    const t = this.#target(session, surface);
    this.#clearPending(t);
    ++t.epoch;
    this.#set(t, { ...empty, negotiated: enabled });
  }
  receive(session: string, m: BrowserServerMessage): void {
    if (!("surfaceId" in m) || !m.surfaceId) return;
    const t = this.#targets.get(JSON.stringify([session, m.surfaceId]));
    if (!t?.view.negotiated) return;
    if (m.type === "browser.video.attached") {
      this.#clearPending(t);
      ++t.epoch;
      this.#set(t, { ...empty, negotiated: true, streamId: m.streamId });
      return;
    }
    if (
      m.type === "browser.video.state" &&
      (m.state === "stopped" || m.state === "failed") &&
      t.view.streamId === m.streamId
    ) {
      this.#clearPending(t);
      ++t.epoch;
      this.#set(t, { ...empty, negotiated: true });
      return;
    }
    if (!("streamId" in m) || m.streamId !== t.view.streamId) return;
    if (m.type === "browser.input.control") {
      if (m.state !== "self") {
        this.#clearPending(t);
        ++t.epoch;
        t.consumed.clear();
      }
      this.#set(t, {
        ...t.view,
        control: m.state,
        ...(m.state === "self" ? {} : { popup: null, pending: false, highlighted: null }),
      });
      return;
    }
    if (t.view.control !== "self") return;
    if (m.type === "browser.popup.opened" || m.type === "browser.popup.updated") {
      const { surfaceId, streamId, documentGeneration, authorityEpoch, popupId, revision, state } =
        m;
      const ref = { surfaceId, streamId, documentGeneration, authorityEpoch, popupId, revision };
      if (
        m.type === "browser.popup.opened" &&
        t.view.popup &&
        samePopup(t.view.popup.ref, ref) &&
        BigInt(revision) <= BigInt(t.view.popup.ref.revision)
      )
        return;
      if (
        m.type === "browser.popup.updated" &&
        (!t.view.popup ||
          !samePopup(t.view.popup.ref, ref) ||
          BigInt(revision) <= BigInt(t.view.popup.ref.revision))
      )
        return;
      // An answer in flight retains its original revision and deadline.
      this.#set(t, {
        ...t.view,
        popup: { ref, state },
        highlighted: null,
        notice: m.type === "browser.popup.updated" ? "Choices changed. Choose again." : null,
      });
      return;
    }
    if (m.type === "browser.popup.closed") {
      if (t.view.popup && samePopup(t.view.popup.ref, m))
        this.#set(t, {
          ...t.view,
          popup: null,
          highlighted: null,
          notice: m.reason === "interrupted" ? "Browser control was interrupted." : null,
        });
      return;
    }
    if (m.type === "browser.popup.unavailable") {
      this.#set(t, {
        ...t.view,
        popup: null,
        highlighted: null,
        notice: "This picker is unavailable in this view.",
      });
      return;
    }
    if (m.type === "browser.popup.result") {
      if (t.pending?.id !== m.operationId || !samePopup(t.pending.ref, m)) return;
      this.#clearPending(t);
      const same = t.view.popup && samePopup(t.view.popup.ref, m);
      this.#set(t, {
        ...t.view,
        pending: false,
        ...(m.outcome === "uncertain" && same ? { popup: null, highlighted: null } : {}),
        notice:
          m.outcome === "refused"
            ? "That choice wasn't applied. Choose again."
            : m.outcome === "uncertain"
              ? "The choice may have applied. Check the page."
              : null,
      });
    }
  }
  #answer(t: Target, ref: BrowserPopupRef, answer: BrowserPopupAnswer): boolean {
    const popup = t.view.popup;
    if (
      !t.view.negotiated ||
      t.view.control !== "self" ||
      t.pending ||
      !popup ||
      !samePopup(ref, popup.ref) ||
      ref.revision !== popup.ref.revision ||
      !validatePopupAnswer(popup.state, answer)
    )
      return false;
    const id = crypto.randomUUID();
    const epoch = t.epoch;
    const timer = setTimeout(() => {
      if (t.epoch !== epoch || t.pending?.id !== id) return;
      this.#clearPending(t);
      this.#cancel(t, ref);
      this.#set(t, {
        ...t.view,
        popup: null,
        pending: false,
        highlighted: null,
        notice: "The choice may have applied. Check the page.",
      });
    }, 10_000);
    t.pending = { id, ref, timer };
    this.#set(t, { ...t.view, pending: true, notice: null });
    try {
      this.#send(t.session, t.surface, { type: "popup.answer", ...ref, operationId: id, answer });
    } catch {
      this.#clearPending(t);
      this.#set(t, {
        ...t.view,
        popup: null,
        pending: false,
        notice: "The choice may have applied. Check the page.",
      });
    }
    return true;
  }
  #cancel(t: Target, ref = t.view.popup?.ref): void {
    const live =
      t.view.negotiated && t.view.control === "self" && ref?.streamId === t.view.streamId;
    const matches = !ref || !t.view.popup || samePopup(ref, t.view.popup.ref);
    if (matches) {
      this.#clearPending(t);
      this.#set(t, { ...t.view, popup: null, pending: false, highlighted: null });
    }
    if (live && ref) {
      try {
        this.#send(t.session, t.surface, {
          type: "popup.cancel",
          ...ref,
          operationId: crypto.randomUUID(),
        });
      } catch {
        /* No reconnect replay. */
      }
    }
  }
  #control(t: Target, action: "acquire" | "release"): void {
    if (!t.view.negotiated || !t.view.streamId) return;
    this.#send(t.session, t.surface, {
      type: "input.control",
      surfaceId: BrowserSurfaceIdSchema.parse(t.surface),
      streamId: t.view.streamId,
      action,
    });
  }
  #key(t: Target, key: string, code: string, phase: "down" | "up"): boolean {
    if (phase === "up") return t.consumed.delete(code);
    const popup = t.view.popup;
    if (!popup) return false;
    if (popup.state.kind !== "datalist") {
      t.consumed.add(code);
      if (key === "Escape") this.#cancel(t);
      return true;
    }
    if (key === "Escape") {
      t.consumed.add(code);
      this.#cancel(t);
      return true;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      const items = popup.state.items.filter((i) => i.enabled && i.kind === "suggestion");
      if (!items.length) return false;
      const index = items.findIndex((i) => i.id === t.view.highlighted);
      const next =
        index < 0
          ? key === "ArrowDown"
            ? 0
            : items.length - 1
          : (index + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      t.consumed.add(code);
      this.#set(t, { ...t.view, highlighted: items[next]!.id });
      return true;
    }
    if (key === "Enter" && t.view.highlighted) {
      t.consumed.add(code);
      this.#answer(t, popup.ref, { itemIds: [t.view.highlighted] });
      return true;
    }
    return false;
  }
  mediaEnded(session: string, surface: string): void {
    const t = this.#targets.get(JSON.stringify([session, surface]));
    if (!t) return;
    this.#clearPending(t);
    ++t.epoch;
    t.consumed.clear();
    this.#set(t, { ...empty, negotiated: t.view.negotiated, notice: t.view.notice });
  }
  disconnect(session: string, surface?: string): void {
    for (const t of this.#targets.values())
      if (t.session === session && (!surface || t.surface === surface)) {
        this.#clearPending(t);
        ++t.epoch;
        t.consumed.clear();
        this.#set(t, empty);
      }
  }
  dispose(): void {
    for (const t of this.#targets.values()) this.disconnect(t.session, t.surface);
    this.#targets.clear();
  }
}
export function browserClickStatus(result: {
  outcome: "dispatched" | "refused" | "uncertain";
  reason?: BrowserClickRefusalReason | undefined;
  hostReason?: "control-lost" | "access-lost" | "stream-ended" | "unavailable" | undefined;
}): string | null {
  if (result.outcome === "dispatched") return null;
  if (result.outcome === "uncertain")
    return "The tap may have happened. Check the page before acting again.";
  if (result.hostReason)
    return result.hostReason === "control-lost"
      ? "Take control to tap the page."
      : result.hostReason === "access-lost"
        ? "Browser access ended."
        : result.hostReason === "stream-ended"
          ? "The browser stream ended. Wait for a fresh picture."
          : "Browser control is unavailable. Try a new tap when ready.";
  const messages: Record<BrowserClickRefusalReason, string> = {
    stale: "The page changed. Tap again.",
    geometry: "The page moved or resized. Tap again.",
    obstructed: "Close the open picker or dialog, then tap again.",
    busy: "The page is busy. Try a new tap when it's ready.",
    pendingInput: "The previous input is still finishing. Tap again afterward.",
    unsupported: "This part of the page can't be controlled from this view.",
  };
  return result.reason ? messages[result.reason] : "The tap wasn't applied. Tap again when ready.";
}
