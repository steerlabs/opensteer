import { useRef } from "react";

export interface SegmentedOption<Value extends string> {
  readonly label: string;
  readonly value: Value;
}

/**
 * A short, closed set of answers, all of them visible at once.
 *
 * Two or three named choices that a person compares before picking one — an
 * app's access levels, say — read better as a row than as a dropdown, which
 * hides every answer but the current one behind a click. It is a radio group,
 * not a set of buttons: one tab stop lands on the chosen option and the arrow
 * keys move between them, which is what a screen reader and a keyboard both
 * expect from "pick exactly one".
 */
export function SegmentedControl<Value extends string>({
  ariaLabel,
  className,
  disabled = false,
  onChange,
  options,
  value,
}: {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SegmentedOption<Value>[];
  readonly value: Value;
}) {
  const group = useRef<HTMLDivElement>(null);

  /**
   * Arrow keys move the selection, as they do in every radio group: the
   * selected option is the only tab stop, so the keys are the whole of the
   * navigation once focus is inside.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={`segmented${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
      ref={group}
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          // `aria-disabled`, not `disabled`: a control that goes busy for the
          // moment its change is saving must not throw away the keyboard focus
          // that just used it, which the real attribute does.
          aria-disabled={disabled}
          className="segmented__option"
          data-value={option.value}
          key={option.value}
          onClick={() => {
            if (!disabled) onChange(option.value);
          }}
          role="radio"
          tabIndex={option.value === value ? 0 : -1}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
