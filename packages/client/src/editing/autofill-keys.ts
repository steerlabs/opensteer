export interface AutofillKey {
  readonly key: string;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * The keys a shown autofill chooser keeps from the page: ↑, ↓ and Return on
 * their own, and Esc. Every viewer and desktop main apply this one rule.
 */
export function autofillKeeps(key: AutofillKey): boolean {
  if (key.key === "Escape") return true;
  return (
    !key.alt &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    (key.key === "ArrowUp" || key.key === "ArrowDown" || key.key === "Enter")
  );
}
