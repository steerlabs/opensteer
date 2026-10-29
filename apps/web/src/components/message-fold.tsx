import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "./icon.js";

/**
 * A sent message's words, folded to `lines` until the reader opens them. Show
 * more appears only when the words run past the fold, or when `more` says what
 * is drawn is an excerpt; it sits inside the message, and the fold never
 * changes the message's width.
 */
export function MessageFold({
  children,
  lines,
  more = false,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode;
  readonly lines: number;
  /** What is drawn is an excerpt of the message, so there is more to open even if it fits. */
  readonly more?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const id = useId();
  const foldRef = useRef<HTMLDivElement | null>(null);
  const wordsRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const fold = foldRef.current;
    const words = wordsRef.current;
    if (!fold || !words) return;
    // Measured against the fold's own line, not its clamped box, so a message
    // opened before it was ever folded still knows whether it needs Show less.
    // The words' box grows as Markdown arrives or the column narrows.
    const measure = () =>
      setOverflowing(
        words.offsetHeight > lines * parseFloat(getComputedStyle(fold).lineHeight) + 1,
      );
    measure();
    return observeResize([words], measure);
  }, [lines]);
  return (
    <>
      <div
        className="message-fold"
        data-open={open || undefined}
        data-overflowing={(!open && overflowing) || undefined}
        id={id}
        // A link the fold hides can still take focus from Tab: it opens the
        // fold rather than sit focused out of sight, as a closed <details> does.
        onFocus={(event) => {
          const fold = foldRef.current;
          if (open || !fold) return;
          if (event.target.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom + 1)
            onOpenChange(true);
        }}
        ref={foldRef}
        style={{ "--fold-lines": lines } as CSSProperties}
      >
        <div ref={wordsRef}>{children}</div>
      </div>
      {overflowing || more ? (
        <button
          aria-controls={id}
          aria-expanded={open}
          className="message-fold__toggle"
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          {open ? "Show less" : "Show more"}
          <Icon name="chevron-down" />
        </button>
      ) : null}
    </>
  );
}
