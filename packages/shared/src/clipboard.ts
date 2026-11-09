/// <reference lib="dom" />

/** `execCommand` is what a Host reached over plain HTTP has left: there is no clipboard API there. */
function copyWithSelection(text: string): boolean {
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return copyWithSelection(text);
    } catch {
      return false;
    }
  }
}
