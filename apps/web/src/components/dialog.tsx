import { NativeBrowserOverlay } from "./native-browser-overlays.js";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icon.js";
import { fromLivePage } from "../ui-utils.js";
import { interact } from "./workspace/interaction.js";

const focusableSelector =
  'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  children: ReactNode;
  footer?: ReactNode;
  /** Names the dialog for the control whose `aria-controls` points at it. */
  id?: string | undefined;
  labelledBy?: string;
  onClose: () => void;
  /** Where focus goes back to on close, when that is not what had it as the dialog opened. */
  returnFocusTo?: HTMLElement | null;
  title: ReactNode;
  wide?: boolean;
}

/**
 * The shared modal: scrim, Escape/scrim close, focus trap, and focus
 * restoration to the opener. Every overlay in the product uses this shell so
 * behavior is consistent.
 */
export function Dialog(props: DialogProps) {
  return (
    <NativeBrowserOverlay>
      <DialogContent {...props} />
    </NativeBrowserOverlay>
  );
}

function DialogContent({
  children,
  footer,
  id,
  labelledBy,
  onClose,
  returnFocusTo = null,
  title,
  wide,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Read while the dialog first renders, before a field inside it takes focus.
  const openerRef = useRef(
    returnFocusTo ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );

  useEffect(() => {
    // Opening a modal is the person's own step: a presentation pending since must not land after it closes.
    interact();
    const opener = openerRef.current;
    // A field that asked for focus (`autoFocus`) is where the person starts;
    // only a dialog with none lands on its close button.
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) =>
    handleModalKeyDown(event, dialogRef.current, onClose);

  return (
    <div className="dialog-layer" role="presentation" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="dialog-scrim"
        aria-label="Close dialog"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className={wide ? "dialog dialog--wide" : "dialog"}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <header className="dialog__header">
          <h2 className="dialog__title" id={labelledBy}>
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * A modal's keyboard: Escape closes it, and Tab stays inside it. Shared by
 * every overlay so they behave alike.
 */
export function handleModalKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
  onClose: () => void,
): void {
  if (event.key === "Escape") {
    if (fromLivePage(event)) return;
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
