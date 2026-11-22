/**
 * Work under a connected agent's authority never presses a clipboard chord in a Mac app: the Mac's
 * clipboard is the person's own and is in no grant. The Home refuses the chord before the action
 * is sent, so a connected agent working in the background can neither read what the person copied
 * nor replace it. The app's own menus and buttons (Edit › Paste pressed through accessibility) are
 * not covered here.
 */
export const computerClipboardRefusal =
  "The clipboard is not available to a connected agent. Use type to enter text.";

/** The modifier spellings the helper's `KeyComboParser` accepts (KeyCombo.swift). */
const modifierAliases: Readonly<Record<string, string>> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  fn: "fn",
  function: "fn",
};

/**
 * Copy, cut and the paste variants: Command with C, X or V, Command-Option-C (copy a path or a
 * style), and Command-V with Shift, Option or both (paste and match style, move). Fn changes none
 * of them and is ignored.
 */
const clipboardChords = new Set([
  "cmd+c",
  "cmd+x",
  "alt+cmd+c",
  "cmd+v",
  "cmd+shift+v",
  "alt+cmd+v",
  "alt+cmd+shift+v",
]);

/** Whether a `key` action's keys name a clipboard chord, read as the helper reads them. */
export function computerClipboardChord(raw: string): boolean {
  const components = raw.trim().toLowerCase().split("+");
  if (components.length > 1 && components.at(-1) === "") {
    components.pop();
    components[components.length - 1] = "+";
  }
  const key = components.pop();
  if (!key) return false;
  const modifiers = new Set<string>();
  for (const component of components) {
    const modifier = modifierAliases[component];
    // The helper refuses an unknown modifier itself, before anything is pressed.
    if (!modifier) return false;
    if (modifier !== "fn") modifiers.add(modifier);
  }
  return clipboardChords.has([...[...modifiers].sort(), key].join("+"));
}

/** Whether one `act` request's actions press a clipboard chord. */
export function computerActionsUseClipboard(args: Readonly<Record<string, unknown>>): boolean {
  const { actions } = args;
  return (
    Array.isArray(actions) &&
    actions.some((action: unknown) => {
      if (typeof action !== "object" || action === null) return false;
      const { type, keys } = action as { type?: unknown; keys?: unknown };
      return type === "key" && typeof keys === "string" && computerClipboardChord(keys);
    })
  );
}
