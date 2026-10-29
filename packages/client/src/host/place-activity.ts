import {
  PlaceActivityNoticeSchema,
  placeIdentityKey,
  type PlaceActivity as WireActivity,
} from "@opensteer/protocol";
import type { BrowserBinaryFrameHeader } from "@opensteer/protocol/browser";
export interface PlaceActivity extends WireActivity {
  readonly placeKey: string;
}
const empty: readonly PlaceActivity[] = [];
/** Every Run brings new keys; the oldest are forgotten first. */
const ledgerLimit = 4096;

/**
 * Agents present in each place. A record stays until a clear notice, a newer
 * record for its thread there, the same Run acting in another place,
 * `reconcile` or `clear`: an agent that is thinking is still there. High-
 * frequency presence has no dependency on HostSnapshot or its subscribers.
 */
export class PlaceActivityStore {
  readonly #values = new Map<string, readonly PlaceActivity[]>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #taskOrders = new Map<string, number>();
  readonly #marks = new Map<string, { generation: number; seq: number }>();
  /**
   * Where each Run acted last. Runs, not threads: an unlisted delegated Run
   * carries its ancestor's thread id while it works in a place of its own.
   */
  readonly #runPlaces = new Map<string, { placeKey: string; order: number }>();
  readonly get = (key: string): readonly PlaceActivity[] => this.#values.get(key) ?? empty;
  readonly subscribe = (key: string, listener: () => void): (() => void) => {
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  };
  apply(input: unknown): void {
    const notice = PlaceActivityNoticeSchema.safeParse(input);
    if (!notice.success) return;
    const message = notice.data;
    const value = message.type === "host.place-activity" ? message.activity : message;
    const key = placeIdentityKey(value.place);
    const elsewhere = this.#runPlaces.get(value.runId);
    // Places flush on separate timers, so a Run's older record from the place
    // it left can arrive after its newer one from the place it is in now.
    if (
      message.type === "host.place-activity" &&
      elsewhere &&
      elsewhere.placeKey !== key &&
      message.activity.order <= elsewhere.order
    )
      return;
    const actor = `${key}:${value.runId}`;
    const previous = this.#marks.get(actor);
    if (
      previous &&
      (value.generation < previous.generation ||
        (value.generation === previous.generation && value.seq <= previous.seq))
    )
      return;
    remember(this.#marks, actor, { generation: value.generation, seq: value.seq });
    if (message.type === "host.place-activity") {
      const taskKey = `${key}:${message.activity.threadId}`;
      const order = this.#taskOrders.get(taskKey);
      if (order !== undefined && message.activity.order <= order) return;
      remember(this.#taskOrders, taskKey, message.activity.order);
      remember(this.#runPlaces, value.runId, { placeKey: key, order: message.activity.order });
      if (elsewhere && elsewhere.placeKey !== key)
        this.#set(
          elsewhere.placeKey,
          this.get(elsewhere.placeKey).filter((activity) => activity.runId !== value.runId),
        );
    }
    const held = this.get(key).filter(
      (activity) =>
        activity.runId !== value.runId &&
        (message.type !== "host.place-activity" || activity.threadId !== message.activity.threadId),
    );
    if (message.type === "host.place-activity") held.push({ ...message.activity, placeKey: key });
    this.#set(key, held);
  }
  reconcile(allowedPlaces: ReadonlySet<string>): void {
    for (const key of this.#values.keys()) if (!allowedPlaces.has(key)) this.#set(key, []);
  }
  clear(): void {
    for (const key of this.#values.keys()) this.#set(key, []);
    this.#marks.clear();
    this.#taskOrders.clear();
    this.#runPlaces.clear();
  }
  dispose(): void {
    this.clear();
    this.#listeners.clear();
  }
  #set(key: string, values: readonly PlaceActivity[]): void {
    const current = this.#values.get(key);
    if (!values.length && !current) return;
    if (current && values.length === current.length && values.every((v, i) => v === current[i]))
      return;
    if (values.length) this.#values.set(key, values);
    else this.#values.delete(key);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
}

function remember<V>(ledger: Map<string, V>, key: string, value: V): void {
  ledger.delete(key);
  ledger.set(key, value);
  if (ledger.size > ledgerLimit) ledger.delete(ledger.keys().next().value!);
}

/** Where one record puts its agent's cursor on a drawn picture. */
export type PlaceActivityPoint =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "hidden" }
  | { readonly kind: "unknown" };

/** The geometry a picture is drawn in: a frame header, or a native page's placement. */
export type PlaceActivityGeometry = Pick<
  BrowserBinaryFrameHeader,
  "capture" | "geometryRevision" | "surfaceId" | "viewportHeight" | "viewportWidth"
>;

const unknownPoint: PlaceActivityPoint = { kind: "unknown" };
const hiddenPoint: PlaceActivityPoint = { kind: "hidden" };

/**
 * A pointer is a fraction of the page's view, valid only against the exact
 * geometry it was measured in. It is re-normalised into the captured region,
 * and a point outside that region is hidden. A record without a valid pointer
 * says nothing about where the cursor is: `unknown` keeps it where it was.
 */
export function placeActivityPoint(
  activity: WireActivity,
  geometry: PlaceActivityGeometry,
): PlaceActivityPoint {
  if (
    activity.place.kind !== "browser" ||
    activity.place.surfaceId !== geometry.surfaceId ||
    activity.geometryRevision !== geometry.geometryRevision ||
    !activity.pointer
  )
    return unknownPoint;
  const region = geometry.capture;
  if (!region) return { kind: "point", x: activity.pointer.x, y: activity.pointer.y };
  const x = (activity.pointer.x * geometry.viewportWidth) / region.width;
  const y = (activity.pointer.y * geometry.viewportHeight) / region.height;
  return x <= 1 && y <= 1 ? { kind: "point", x, y } : hiddenPoint;
}
