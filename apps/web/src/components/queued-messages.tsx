import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ArtifactContentPart, PlaceContentPart, ThreadInputQueue } from "@opensteer/core";
import {
  messageDraftParts,
  queuedMessages,
  type HostClient,
  type QueuedMessage,
} from "@opensteer/client/host";
import { artifactParts } from "./attachments/attachment-parts.js";
import { Icon } from "./icon.js";

/** Past this many cards the middle folds into a stack, so the tray never buries the thread. */
const collapseAfter = 4;
const ease = "cubic-bezier(0.22, 1, 0.36, 1)";

type Exit = "down" | "side" | "up";

interface Drag {
  readonly from: number;
  readonly id: string;
  readonly nodes: readonly HTMLLIElement[];
  readonly order: readonly string[];
  readonly rects: readonly DOMRect[];
  readonly startY: number;
  readonly step: number;
  to: number;
}

/**
 * The messages waiting behind the current turn, docked on the composer.
 *
 * Each message is its own card, numbered in the order Runs will take them;
 * the one the next Run takes is filled in. Only people's messages appear (see
 * `queuedMessages`). A card's number turns into a grip under the pointer:
 * drag it, or press Alt with an arrow key, to rearrange your own messages.
 * Steer, Edit and Remove appear on hover and focus, and only when the Host
 * will honour them.
 *
 * Motion follows the message. A new one rises out of the composer into its
 * place, one a Run takes lifts toward the conversation, Edit drops it back
 * into the composer, and Remove slides it away. Cards move by transform
 * alone, and reduced motion leaves only the end state.
 */
export function QueuedMessages({
  client,
  disabled,
  onEdit,
  onError,
  queue,
}: {
  readonly client: HostClient;
  readonly disabled: boolean;
  /** Puts a message taken back from the queue, files included, into the composer to be reworded. */
  readonly onEdit: (message: {
    readonly attachments: readonly ArtifactContentPart[];
    readonly places: readonly PlaceContentPart[];
    readonly text: string;
  }) => void;
  readonly onError: (error: unknown) => void;
  readonly queue: ThreadInputQueue;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState<{ readonly id: string; readonly to: number } | null>(
    null,
  );
  const cards = useRef(new Map<string, HTMLLIElement>());
  const layout = useRef({
    nodes: new Map<string, HTMLLIElement>(),
    rects: new Map<string, DOMRect>(),
    painted: false,
  });
  const exits = useRef(new Map<string, Exit>());
  const drag = useRef<Drag | null>(null);
  const refocus = useRef<string | null>(null);
  const ghosts = useRef<HTMLDivElement | null>(null);

  const shown = queuedMessages(queue);
  const ids: string[] = shown.map(({ item }) => item.message.id);
  const collapsed = !expanded && shown.length > collapseAfter;
  // The first shown card is filled in only when the next Run really takes it.
  const firstIsNext = shown[0]?.next === true;

  useLayoutEffect(() => {
    // Mid-drag the cards stand where the pointer put them; the drop settles it.
    if (drag.current) return;
    const previous = layout.current;
    const rects = new Map<string, DOMRect>();
    for (const [id, node] of cards.current) rects.set(id, node.getBoundingClientRect());
    if (previous.painted && !prefersReducedMotion()) {
      for (const [id, rect] of rects) {
        const node = cards.current.get(id);
        const before = previous.rects.get(id);
        if (!node) continue;
        if (before) {
          const dy = before.top - rect.top;
          if (Math.abs(dy) > 0.5)
            node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
              duration: 260,
              easing: ease,
            });
        } else {
          node.animate(
            [
              { opacity: 0.25, transform: "translateY(28px) scale(0.97)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 340, easing: ease },
          );
          node
            .querySelector(".queue-card__ord")
            ?.animate(
              [
                { opacity: 0, transform: "scale(0.3)" },
                { offset: 0.7, opacity: 1, transform: "scale(1.15)" },
                { transform: "scale(1)" },
              ],
              { delay: 180, duration: 260, easing: ease, fill: "backwards" },
            );
        }
      }
      for (const [id, rect] of previous.rects) {
        const node = previous.nodes.get(id);
        if (!rects.has(id) && node && ghosts.current) {
          leave(ghosts.current, node, rect, exits.current.get(id) ?? "up");
        }
      }
    }
    for (const id of exits.current.keys()) if (!rects.has(id)) exits.current.delete(id);
    layout.current = { nodes: new Map(cards.current), painted: true, rects };
    if (refocus.current) {
      cards.current.get(refocus.current)?.focus();
      refocus.current = null;
    }
  });

  if (!queue.paused && shown.length === 0) return null;

  const act = (messageId: string, exit: Exit | null, run: () => Promise<void>) => {
    if (busyId !== null || disabled) return;
    setBusyId(messageId);
    if (exit) exits.current.set(messageId, exit);
    void run()
      .catch((error: unknown) => {
        exits.current.delete(messageId);
        onError(error);
      })
      .finally(() => setBusyId(null));
  };

  // A card dropped among the shown messages stands in front of the one that
  // now follows it, or at the back of the queue when none does.
  const move = (messageId: string, order: readonly string[], to: number) => {
    const arranged = placeAt(order, messageId, to);
    if (arranged.join() === order.join()) return;
    act(messageId, null, () =>
      client.moveThreadInput(queue.threadId, messageId, arranged[to + 1] ?? null),
    );
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || disabled || busyId !== null) return;
    event.preventDefault();
    if (collapsed) {
      setExpanded(true);
      return;
    }
    const nodes = ids.map((candidate) => cards.current.get(candidate));
    if (nodes.some((node) => node === undefined)) return;
    const present = nodes as HTMLLIElement[];
    const rects = present.map((node) => node.getBoundingClientRect());
    const from = ids.indexOf(id);
    drag.current = {
      from,
      id,
      nodes: present,
      order: ids,
      rects,
      startY: event.clientY,
      step: rects.length > 1 ? rects[1]!.top - rects[0]!.top : 0,
      to: from,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ id, to: from });
  };

  const continueDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const dy = event.clientY - current.startY;
    const lifted = current.rects[current.from]!;
    current.nodes[current.from]!.style.transform = `translateY(${dy}px) scale(1.02)`;
    // Rising, the card passes a neighbour once its top edge crosses that
    // neighbour's middle; sinking, once its bottom edge does.
    const top = lifted.top + dy;
    let to = current.from;
    for (const [index, rect] of current.rects.entries()) {
      const middle = rect.top + rect.height / 2;
      if (index < current.from && top < middle) to -= 1;
      if (index > current.from && top + lifted.height > middle) to += 1;
    }
    if (to === current.to) return;
    current.to = to;
    for (const [index, node] of current.nodes.entries()) {
      if (index === current.from) continue;
      const shift =
        current.from < to && index > current.from && index <= to
          ? -current.step
          : current.from > to && index >= to && index < current.from
            ? current.step
            : 0;
      node.style.transform = shift ? `translateY(${shift}px)` : "";
    }
    setDragging({ id: current.id, to });
  };

  const endDrag = () => {
    const current = drag.current;
    if (!current) return;
    // The drop animates from where each card visibly stands to its new place.
    const rects = new Map(layout.current.rects);
    for (const [index, node] of current.nodes.entries()) {
      rects.set(current.order[index]!, node.getBoundingClientRect());
      node.style.transform = "";
    }
    layout.current = { ...layout.current, rects };
    drag.current = null;
    // The client reorders its queue before the Host answers, in this same
    // render as the lifted card settling, so the drop never snaps back first.
    move(current.id, current.order, current.to);
    setDragging(null);
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLLIElement>, message: QueuedMessage) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    if (!message.item.canMove) return;
    event.preventDefault();
    const id = message.item.message.id;
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + (event.key === "ArrowUp" ? -1 : 1)));
    if (to === from) return;
    refocus.current = id;
    move(id, ids, to);
  };

  // While a card is lifted its neighbours are numbered where they will land.
  const numbering = dragging ? placeAt(ids, dragging.id, dragging.to) : null;

  const card = (message: QueuedMessage, index: number) => {
    const { item, text } = message;
    const id = item.message.id;
    const attachments = artifactParts(item.message.content);
    const attached =
      attachments.length === 0
        ? ""
        : `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`;
    const busy = busyId === id;
    const blocked = disabled || busyId !== null;
    const position = numbering ? numbering.indexOf(id) : index;
    const className = [
      "queue-card",
      firstIsNext && position === 0 ? "queue-card--next" : "",
      item.canMove && !disabled ? "queue-card--movable" : "",
      dragging?.id === id ? "queue-card--lifted" : "",
      busy ? "queue-card--busy" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li
        aria-keyshortcuts={item.canMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-label={`Queued message ${position + 1} of ${shown.length}: ${text}${
          attached ? `, ${attached}` : ""
        }`}
        className={className}
        key={id}
        onKeyDown={(event) => onCardKeyDown(event, message)}
        ref={(node) => {
          if (node) cards.current.set(id, node);
          else cards.current.delete(id);
        }}
        tabIndex={0}
      >
        <span
          aria-hidden
          className="queue-card__ord"
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={item.canMove ? (event) => startDrag(event, id) : undefined}
          onPointerMove={continueDrag}
          onPointerUp={endDrag}
        >
          <span className="queue-card__num">{position + 1}</span>
          <Icon className="queue-card__grip" name="grip" />
        </span>
        {attached ? (
          <span aria-hidden className="queue-card__attachments" title={attached}>
            <Icon name="paperclip" />
            {attachments.length}
          </span>
        ) : null}
        <span className="queue-card__text" title={text}>
          {text}
        </span>
        <span className="queue-card__actions">
          {item.canSteer ? (
            <button
              aria-label="Steer the current run with this message"
              className="queue-card__action"
              disabled={blocked}
              onClick={() => act(id, "up", () => client.steerThreadInput(queue.threadId, id))}
              title="Send into the current turn"
              type="button"
            >
              <Icon name="corner-down-right" />
              Steer
            </button>
          ) : null}
          {item.canCancel ? (
            <>
              <button
                aria-label="Edit this message"
                className="queue-card__action queue-card__action--icon"
                disabled={blocked}
                onClick={() =>
                  act(id, "down", async () => {
                    await client.cancelThreadInput(queue.threadId, id);
                    // Every place goes back as a chip; none is an empty choice that sticks.
                    const draft = messageDraftParts(item.message.content);
                    onEdit({
                      attachments: draft.attachments,
                      places: draft.places,
                      text: draft.body,
                    });
                  })
                }
                title="Edit"
                type="button"
              >
                <Icon name="pencil" />
              </button>
              <button
                aria-label="Remove this message from the queue"
                className="queue-card__action queue-card__action--icon queue-card__action--remove"
                disabled={blocked}
                onClick={() => act(id, "side", () => client.cancelThreadInput(queue.threadId, id))}
                title="Remove"
                type="button"
              >
                <Icon name="close" />
              </button>
            </>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <section
      aria-label="Queued messages"
      className={dragging ? "queue-tray queue-tray--dragging" : "queue-tray"}
    >
      <div className="queue-tray__head">
        {queue.paused ? (
          <>
            <span aria-hidden className="queue-tray__paused-dot" />
            <span className="queue-tray__label queue-tray__label--paused">Paused</span>
          </>
        ) : (
          <span className="queue-tray__label">Queued</span>
        )}
        {shown.length > 0 ? <span className="queue-tray__count">{shown.length}</span> : null}
        {shown.length > collapseAfter && expanded ? (
          <button
            aria-label="Fold the queue"
            className="queue-tray__fold"
            onClick={() => setExpanded(false)}
            type="button"
          >
            <Icon name="chevron-down" />
          </button>
        ) : null}
        {queue.paused ? (
          <button
            className="btn btn--small queue-tray__resume"
            disabled={disabled || resuming}
            onClick={() => {
              setResuming(true);
              void client
                .resumeThreadInputQueue(queue.threadId)
                .catch(onError)
                .finally(() => setResuming(false));
            }}
            type="button"
          >
            {resuming ? "Resuming…" : "Resume"}
          </button>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <ol className="queue-tray__list">
          {collapsed ? (
            <>
              {card(shown[0]!, 0)}
              <li className="queue-tray__stack">
                <button
                  aria-label={`Show ${shown.length - 2} more queued messages`}
                  className="queue-tray__more"
                  onClick={() => setExpanded(true)}
                  type="button"
                >
                  +{shown.length - 2} more
                </button>
              </li>
              {card(shown.at(-1)!, shown.length - 1)}
            </>
          ) : (
            shown.map(card)
          )}
        </ol>
      ) : null}
      <div aria-hidden className="queue-tray__ghosts" ref={ghosts} />
    </section>
  );
}

/**
 * A card that left the queue keeps moving after React has removed it: a copy
 * stands where it was and finishes the gesture its exit belongs to.
 */
function leave(host: HTMLElement, node: HTMLLIElement, rect: DOMRect, exit: Exit): void {
  const origin = host.getBoundingClientRect();
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("tabindex");
  ghost.style.cssText = `position:absolute;left:${rect.left - origin.left}px;top:${
    rect.top - origin.top
  }px;width:${rect.width}px;margin:0;`;
  host.append(ghost);
  const to =
    exit === "up"
      ? "translateY(-16px)"
      : exit === "down"
        ? "translateY(22px) scale(0.97)"
        : "translateX(24px)";
  ghost
    .animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: to },
      ],
      {
        duration: 180,
        easing: "ease-in",
        fill: "forwards",
      },
    )
    .finished.finally(() => ghost.remove())
    .catch(() => undefined);
}

function placeAt(order: readonly string[], id: string, to: number): string[] {
  const arranged = order.filter((candidate) => candidate !== id);
  arranged.splice(to, 0, id);
  return arranged;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
