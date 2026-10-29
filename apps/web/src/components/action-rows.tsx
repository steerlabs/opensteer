import { useEffect, useRef, type KeyboardEvent } from "react";
import type { RequestOption } from "@opensteer/core";

/**
 * Option rows for a pending Request: full-width targets with the label
 * and an optional one-line description, digit shortcuts, and roving focus.
 * Presentation-only — resolution routing stays with the caller.
 */
export function ChoiceRows({
  autoFocus = false,
  disabled = false,
  onSelect,
  options,
  pendingId = null,
}: {
  /** Move focus to the first row on mount unless the reader is mid-typing. */
  autoFocus?: boolean;
  disabled?: boolean;
  onSelect: (option: RequestOption) => void;
  options: readonly RequestOption[];
  pendingId?: string | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
    if (!typing) listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [autoFocus]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = rows.findIndex((row) => row === document.activeElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      rows[(current + delta + rows.length) % rows.length]?.focus();
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length && !disabled) {
      event.preventDefault();
      const option = options[digit - 1];
      if (option && pendingId === null) onSelect(option);
    }
  };

  return (
    <div className="action-rows" onKeyDown={handleKeyDown} ref={listRef}>
      {options.map((option, index) => (
        <button
          className={isAffirmative(option) ? "action-row action-row--primary" : "action-row"}
          disabled={disabled || pendingId !== null}
          key={option.id}
          onClick={() => onSelect(option)}
          type="button"
        >
          <span aria-hidden className="action-row__key">
            {index + 1}
          </span>
          <span className="action-row__text">
            <span className="action-row__label">{option.label}</span>
            {option.description ? (
              <span className="action-row__desc">{option.description}</span>
            ) : null}
          </span>
          {pendingId === option.id ? (
            <span aria-label="Working" className="spinner action-row__busy" role="status" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function isAffirmative(option: RequestOption): boolean {
  return (
    option.hint === "allow-once" || option.hint === "allow-for-run" || option.hint === "confirm"
  );
}

/** One quiet line of context inside an action panel. */
export function ActionNote({ alert = false, children }: { alert?: boolean; children: string }) {
  return (
    <p className="action-note" role={alert ? "alert" : undefined}>
      {children}
    </p>
  );
}
