import {
  autofillAccountMark,
  autofillChooserLabel,
  autofillCodeTitle,
  autofillResultMessage,
  type BrowserEditingTarget,
} from "@opensteer/client/host";
import type { PersonFillRole } from "@opensteer/protocol";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { Icon } from "../icon.js";
import { useToast } from "../toast.js";
import "./autofill-chooser.css";

export interface AutofillChooserAccount {
  readonly id: string;
  readonly username: string;
  readonly label: string | null;
}

/** The narrowest and widest a chooser is drawn; between them it takes its field's width. */
export const autofillChooserMinWidth = 240;
export const autofillChooserMaxWidth = 360;
export function autofillChooserWidth(fieldWidth: number): number {
  return Math.max(autofillChooserMinWidth, Math.min(autofillChooserMaxWidth, fieldWidth));
}

export function autofillOptionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

/**
 * The saved logins for a sign-in field: rows only, the highlighted one lit.
 * The same list on a streamed page and in the desktop's popup over a native one.
 */
export function AutofillChooser({
  accounts,
  className,
  highlighted,
  listId,
  onChoose,
  open = true,
  ref,
  role,
  side = "below",
  still = false,
  style,
}: {
  readonly accounts: readonly AutofillChooserAccount[];
  readonly className?: string;
  readonly highlighted: number;
  readonly listId: string;
  readonly onChoose: (accountId: string) => void;
  /** Mounted but closed, it fades out and leaves the accessibility tree. */
  readonly open?: boolean;
  readonly ref?: RefObject<HTMLDivElement | null>;
  readonly role: PersonFillRole;
  /** Which side of its field it is drawn on; it opens from that edge. */
  readonly side?: "below" | "above";
  /** No movement: the person asked for reduced motion. */
  readonly still?: boolean;
  readonly style?: CSSProperties;
}) {
  const code = role === "code";
  const detailed = code || accounts.some((account) => account.label !== null);
  const own = useRef<HTMLDivElement | null>(null);
  const list = ref ?? own;
  useEffect(() => {
    const panel = list.current;
    if (!panel) return;
    // Over a streamed page these belong to the list, not the page beneath it.
    const keep = (event: Event) => event.stopPropagation();
    for (const type of ["wheel", "pointermove", "pointerup"]) panel.addEventListener(type, keep);
    return () => {
      for (const type of ["wheel", "pointermove", "pointerup"])
        panel.removeEventListener(type, keep);
    };
  }, [list]);
  useLayoutEffect(() => {
    const panel = list.current;
    const row = panel?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`);
    if (!panel || !row) return;
    // The panel's own padding stays visible around the first and last rows.
    const top = highlighted === 0 ? 0 : row.offsetTop;
    const bottom =
      highlighted === accounts.length - 1 ? panel.scrollHeight : row.offsetTop + row.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = top;
    else if (bottom > panel.scrollTop + panel.clientHeight)
      panel.scrollTop = bottom - panel.clientHeight;
  }, [accounts.length, highlighted, list]);
  return (
    <div
      aria-activedescendant={open ? autofillOptionId(listId, highlighted) : undefined}
      aria-label={autofillChooserLabel}
      className={[
        "autofill-chooser",
        open ? "is-open" : "",
        detailed ? "is-detailed" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-side={side}
      data-still={still || undefined}
      id={listId}
      ref={list}
      role="listbox"
      style={{ ...style, "--autofill-index": highlighted } as CSSProperties}
      // The page keeps the keyboard: a press here must not take focus from its field.
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
      }}
    >
      <span aria-hidden className="autofill-chooser__highlight" />
      {accounts.map((account, index) => {
        const mark = autofillAccountMark(account);
        const name = code ? autofillCodeTitle : account.username || account.label || "";
        const detail = code ? account.username : account.username ? account.label : null;
        return (
          <div
            aria-selected={index === highlighted}
            className="autofill-chooser__row"
            data-index={index}
            id={autofillOptionId(listId, index)}
            key={account.id}
            onClick={() => onChoose(account.id)}
            role="option"
          >
            {code ? (
              <span aria-hidden className="autofill-chooser__glyph">
                <Icon name="clock" />
              </span>
            ) : (
              <span
                aria-hidden
                className="pavatar autofill-chooser__mark"
                style={{ "--pavatar-tint": mark.tint } as CSSProperties}
              >
                {mark.initial}
              </span>
            )}
            <span className="autofill-chooser__text">
              <span className="autofill-chooser__name">{name}</span>
              {detail ? <span className="autofill-chooser__detail">{detail}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A fill that did not happen says why, once, without stopping the person.
 * Read from the store itself: a withdrawal may follow the result at once.
 */
export function useAutofillResultNotice(target: BrowserEditingTarget | null): void {
  const toast = useToast();
  useEffect(() => {
    if (!target) return;
    let previous = target.get().autofill;
    return target.subscribe(() => {
      const before = previous;
      const next = target.get().autofill;
      previous = next;
      if (!before?.pending || !next || next.pending || next.offer.offerId !== before.offer.offerId)
        return;
      const message = autofillResultMessage(next.result);
      if (message) toast.error(message);
    });
  }, [target, toast]);
}
