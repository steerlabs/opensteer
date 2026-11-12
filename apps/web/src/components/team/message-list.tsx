import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { observeTeamMessages } from "../../team/message-visibility.js";
import { Icon } from "../icon.js";
import { useStableActions } from "../use-stable-actions.js";
import { useWindowedRows } from "../workspace/windowed-rows.js";
import { AgentCardRow, type AgentCardActions } from "./agent-status-card.js";
import { MessageRow, type MessageActions } from "./message-row.js";
import type { AuthorView, MessageView, TimelineItem } from "./team-models.js";
import { clockTime, dayLabel, sameDay } from "./team-time.js";

/** Within this many pixels of the end, new rows follow; further up, the reader keeps their place. */
const followDistance = 80;
const groupWindowMs = 5 * 60_000;
const readAfterMs = 1000;

const noActions = {};
/** A message row's size before it is drawn; drawn rows are measured. */
const rowEstimate = 64;
/** The newest rows are always drawn, so the first paint at the end is whole. */
const newestDrawn = 12;

/**
 * A channel's or DM's timeline. It opens at the first unread message, with
 * its NEW line a third of the way down, or at the end; it follows new rows
 * only while the reader is at the end, and keeps the row under their eye
 * still while history loads above, a card changes or a row is first drawn.
 * Only the rows in view are drawn, and a row that did not change never
 * redraws.
 */
export function MessageList({
  actions,
  cardActions,
  editingId = null,
  firstUnreadId,
  flashId = null,
  hasOlder,
  inThread = false,
  intro,
  items,
  label,
  loadingOlder = false,
  onEditingChange,
  onLoadOlder,
  onMarkRead,
  onReadThrough,
  onVisibleMessage,
  openThreadId = null,
}: {
  readonly actions?: MessageActions | undefined;
  readonly cardActions?: AgentCardActions | undefined;
  readonly editingId?: string | null;
  /** The NEW line goes above this message; it stays until the reader leaves. */
  readonly firstUnreadId: string | null;
  /** A deep link's message: scrolled to and flashed once. */
  readonly flashId?: string | null;
  readonly hasOlder: boolean;
  readonly inThread?: boolean;
  readonly onVisibleMessage?: ((id: string) => void) | undefined;
  /** The start of the channel, shown once there is nothing older. */
  readonly intro?: ReactNode;
  readonly items: readonly TimelineItem[];
  readonly label: string;
  readonly loadingOlder?: boolean;
  readonly onEditingChange?: ((messageId: string | null) => void) | undefined;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly onMarkRead?: (() => void) | undefined;
  /** The newest message has been on screen for a second in a focused window. */
  readonly onReadThrough?: ((messageId: string) => void) | undefined;
  readonly openThreadId?: string | null;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const atEnd = useRef(true);
  const stable = useStableItems(items);
  const rowActions = useStableActions(actions ?? noActions);
  const rowCardActions = useStableActions(cardActions ?? noActions);
  const editingLatest = useRef(onEditingChange);
  editingLatest.current = onEditingChange;
  const onEditing = useCallback(
    (messageId: string, editing: boolean) => editingLatest.current?.(editing ? messageId : null),
    [],
  );
  const anchor = useRef<{ readonly id: string; readonly top: number } | null>(null);
  const lastId = useRef<string | null>(null);
  const landed = useRef<string | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const [unreadAbove, setUnreadAbove] = useState(false);

  const measure = useCallback(() => {
    const list = scroller.current;
    if (!list) return;
    atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < followDistance;
    if (atEnd.current) setNewBelow(0);
    const top = list.getBoundingClientRect().top;
    const rows = list.querySelectorAll<HTMLElement>("[data-row-id]");
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) {
        anchor.current = { id: row.dataset.rowId ?? "", top: box.top - top };
        break;
      }
    }
    const line = list.querySelector<HTMLElement>(".tlist__new");
    setUnreadAbove(line ? line.getBoundingClientRect().bottom < top : false);
    if (list.scrollTop < 240 && hasOlder && !loadingOlder) onLoadOlder?.();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  // First paint: at the first unread or a deep link, else at the end.
  useLayoutEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const target = flashId
      ? list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(flashId)}"]`)
      : list.querySelector<HTMLElement>(".tlist__new");
    if (target) {
      const offset = flashId ? list.clientHeight / 2 : list.clientHeight / 3;
      list.scrollTop = target.offsetTop - offset;
    } else {
      list.scrollTop = list.scrollHeight;
    }
    const last = items.at(-1);
    lastId.current = last ? itemId(last) : null;
    measure();
    // Only the first paint chooses where to open.
  }, []);

  useLayoutEffect(() => {
    const list = scroller.current;
    if (!list || !flashId || landed.current === flashId) return;
    const row = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(flashId)}"]`);
    if (!row) return;
    list.scrollTop = row.offsetTop - list.clientHeight / 2;
    landed.current = flashId;
    atEnd.current = false;
    measure();
  }, [flashId, items]);

  // Every later change: follow at the end, otherwise hold the row under the eye.
  useLayoutEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const last = items.at(-1);
    const newest = last ? itemId(last) : null;
    if (atEnd.current) {
      list.scrollTop = list.scrollHeight;
    } else {
      const held = anchor.current;
      const row = held
        ? list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(held.id)}"]`)
        : null;
      if (held && row) {
        const drift = row.getBoundingClientRect().top - list.getBoundingClientRect().top - held.top;
        list.scrollTop += drift;
      }
      if (newest !== lastId.current && lastId.current !== null) {
        const before = items.findIndex((item) => itemId(item) === lastId.current);
        if (before >= 0) setNewBelow((count) => count + (items.length - 1 - before));
      }
    }
    lastId.current = newest;
  }, [items]);

  // A row drawn or grown above the reader (history, a picture, a card) never moves what they read.
  useLayoutEffect(() => {
    const list = scroller.current;
    const rows = rowsRef.current;
    if (!list || !rows || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) {
        list.scrollTop = list.scrollHeight;
        return;
      }
      const held = anchor.current;
      const row = held
        ? list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(held.id)}"]`)
        : null;
      if (!held || !row) return;
      const drift = row.getBoundingClientRect().top - list.getBoundingClientRect().top - held.top;
      if (Math.abs(drift) > 0.5) list.scrollTop += drift;
    });
    observer.observe(rows);
    return () => observer.disconnect();
  }, []);

  const keys = useMemo(() => stable.map(itemId), [stable]);
  const plan = useWindowedRows({
    list: scroller,
    rows: rowsRef,
    keys,
    estimate: (index) => (stable[index]?.kind === "card" ? 82 : rowEstimate),
    pinned: [
      ...keys.slice(-newestDrawn),
      firstUnreadId ?? "",
      flashId ?? "",
      openThreadId ?? "",
      editingId ?? "",
    ],
    all: false,
  });

  // Read: the newest message on screen for a second while the window has focus.
  const newest = items.at(-1);
  const newestId = newest ? itemId(newest) : null;
  useEffect(() => {
    const list = scroller.current;
    if (!list || !newestId || !onReadThrough) return;
    const row = list.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(newestId)}"]`);
    if (!row) return;
    let timer: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        window.clearTimeout(timer);
        if (entry?.isIntersecting && document.hasFocus())
          timer = window.setTimeout(() => onReadThrough(newestId), readAfterMs);
      },
      { root: list, threshold: 0.6 },
    );
    observer.observe(row);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [newestId, onReadThrough]);

  const drawnKeys = plan
    .flatMap((entry) => ("index" in entry ? [keys[entry.index]] : []))
    .join(",");
  useEffect(() => {
    const list = scroller.current;
    if (!list || !onVisibleMessage) return;
    return observeTeamMessages(
      list,
      [...list.querySelectorAll<HTMLElement>("[data-row-id]")],
      onVisibleMessage,
    );
  }, [onVisibleMessage, items, drawnKeys]);

  const firstUnreadIndex = firstUnreadId ? keys.indexOf(firstUnreadId) : -1;
  const unreadCount =
    firstUnreadIndex < 0 ? 0 : items.slice(firstUnreadIndex).filter(isMessage).length;
  const firstUnread = firstUnreadIndex >= 0 ? items[firstUnreadIndex] : undefined;

  const toEnd = () => {
    const list = scroller.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  };
  const toNewLine = () => {
    const list = scroller.current;
    const line = list?.querySelector<HTMLElement>(".tlist__new");
    if (list && line)
      list.scrollTo({ top: line.offsetTop - list.clientHeight / 3, behavior: "smooth" });
  };

  return (
    <div className="tlist">
      {unreadAbove && firstUnread && unreadCount > 0 ? (
        <div className="tlist__jump tlist__jump--above">
          <button className="tlist__jump-main" onClick={toNewLine} type="button">
            <Icon name="arrow-up" />
            {unreadCount} new since {clockTime(itemAt(firstUnread))}
          </button>
          {onMarkRead ? (
            <button className="tlist__jump-side" onClick={onMarkRead} type="button">
              Mark read
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        aria-label={label}
        className="tlist__scroller"
        onScroll={measure}
        ref={scroller}
        role="log"
        tabIndex={-1}
      >
        <div className="tlist__rows" ref={rowsRef}>
          {hasOlder ? (
            <button
              className="tlist__older"
              disabled={loadingOlder}
              onClick={onLoadOlder}
              type="button"
            >
              {loadingOlder ? "Loading earlier messages…" : "Earlier messages"}
            </button>
          ) : (
            intro
          )}
          {plan.map((entry, order) => {
            if ("spacer" in entry)
              return (
                <div
                  aria-hidden
                  className="tlist__spacer"
                  key={`spacer:${order}`}
                  style={{ height: entry.spacer }}
                />
              );
            const index = entry.index;
            const item = stable[index]!;
            const previous = index > 0 ? stable[index - 1] : undefined;
            const at = itemAt(item);
            const newDay = !previous || !sameDay(itemAt(previous), at);
            const newLine = index === firstUnreadIndex;
            const id = itemId(item);
            return (
              <div className="tlist__row" data-motion-key={id} data-row-id={id} key={id}>
                {newDay ? (
                  <div className="tlist__day" role="separator">
                    <span>{dayLabel(at)}</span>
                  </div>
                ) : null}
                {newLine ? (
                  <div aria-label="New messages" className="tlist__new" role="separator">
                    <span>New</span>
                  </div>
                ) : null}
                {item.kind === "message" ? (
                  <MessageRow
                    actions={rowActions}
                    editing={editingId === id}
                    flash={flashId === id}
                    grouped={!newDay && !newLine && joins(previous, item.message)}
                    inThread={inThread}
                    message={item.message}
                    onEditingChange={onEditing}
                    open={openThreadId === id}
                  />
                ) : item.kind === "card" ? (
                  <AgentCardRow actions={rowCardActions} request={item.request} />
                ) : (
                  <SystemRow icon={item.icon} text={item.text} at={item.at} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {newBelow > 0 ? (
        <div className="tlist__jump tlist__jump--below">
          <button className="tlist__jump-main" onClick={toEnd} type="button">
            {newBelow} new
            <Icon name="arrow-up" className="tlist__jump-down" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A line the team wrote about itself: someone joined, a channel became people only. */
export function SystemRow({
  at,
  icon = "user",
  text,
}: {
  readonly at: string;
  readonly icon?: "user" | "users" | "lock" | "pushpin" | undefined;
  readonly text: string;
}) {
  return (
    <div className="tsystem">
      <span aria-hidden className="tsystem__mark">
        <Icon name={icon} />
      </span>
      <span className="tsystem__text">
        {text} · <time dateTime={at}>{clockTime(at)}</time>
      </span>
    </div>
  );
}

/**
 * The same row object for a row that has not changed, so its memoised row is
 * not drawn again when another row changes or a timeline is rebuilt.
 */
export function useStableItems(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const held = useRef(new Map<string, { readonly item: TimelineItem; readonly json: string }>());
  return useMemo(() => {
    const next = new Map<string, { readonly item: TimelineItem; readonly json: string }>();
    const kept = items.map((item) => {
      const id = itemId(item);
      const json = JSON.stringify(item);
      const before = held.current.get(id);
      const same = before?.json === json ? before.item : item;
      next.set(id, { item: same, json });
      return same;
    });
    held.current = next;
    return kept;
  }, [items]);
}

export function itemId(item: TimelineItem): string {
  return item.kind === "message"
    ? item.message.id
    : item.kind === "card"
      ? `card:${item.request.id}`
      : item.id;
}

function itemAt(item: TimelineItem): string {
  return item.kind === "message"
    ? item.message.at
    : item.kind === "card"
      ? item.request.askedAt
      : item.at;
}

function isMessage(item: TimelineItem): boolean {
  return item.kind === "message";
}

function authorKey(author: AuthorView): string {
  return author.kind === "agent" ? `agent:${author.owner.id}` : `person:${author.person.id}`;
}

/** A run from one author, close in time, reads as one block. */
export function joins(previous: TimelineItem | undefined, message: MessageView): boolean {
  if (!previous || previous.kind !== "message") return false;
  const before = previous.message;
  return (
    authorKey(before.author) === authorKey(message.author) &&
    Date.parse(message.at) - Date.parse(before.at) < groupWindowMs &&
    !(before.thread && before.thread.replyCount > 0) &&
    !before.work
  );
}
