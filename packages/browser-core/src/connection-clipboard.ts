/**
 * Work done under a connected agent's authority never uses the clipboard in the browser. The
 * clipboard is in no grant: on a Mac it is the person's own, and in a Home's Chromium it is the
 * browser's, shared by every profile and session in it. Whether work is a connection's is decided
 * by the one authority rule when its attachment is made; this module only refuses what follows
 * from that fact.
 */
export const connectionClipboardRefusal =
  "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";

/** Editing commands that read the clipboard or write it, as Blink names them (any case). */
const clipboardEditingCommands = new Set([
  "copy",
  "cut",
  "paste",
  "pasteandmatchstyle",
  // Reads the X11 primary selection, a second clipboard, on Linux.
  "pasteglobalselection",
]);

const alt = 1;
const control = 2;
const meta = 4;
const shift = 8;

/**
 * Chords that become a clipboard command without one being stated: the macOS editing commands
 * the router infers (Meta), and Blink's own key bindings on Linux and Windows (Control, Insert
 * and Delete), which Chromium applies in the page without any command.
 */
const clipboardChords: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [meta, new Set(["KeyC", "KeyX", "KeyV"])],
  [control, new Set(["KeyC", "KeyX", "KeyV", "Insert"])],
  [control | shift, new Set(["KeyV"])],
  [shift, new Set(["Insert", "Delete"])],
]);

const windowsKeyCodes: ReadonlyMap<number, string> = new Map([
  [67, "KeyC"],
  [86, "KeyV"],
  [88, "KeyX"],
  [45, "Insert"],
  [46, "Delete"],
]);

/** Blink reads `windowsVirtualKeyCode`; the router reads `code` and `key`. Each one counts. */
function chordKeys(parameters: Readonly<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  for (const candidate of [parameters.code, parameters.key]) {
    if (typeof candidate !== "string") continue;
    keys.push(/^[a-z]$/iu.test(candidate) ? `Key${candidate.toUpperCase()}` : candidate);
  }
  const windowsCode = parameters.windowsVirtualKeyCode;
  if (typeof windowsCode === "number") {
    const key = windowsKeyCodes.get(windowsCode);
    if (key) keys.push(key);
  }
  return keys;
}

function clipboardKeyEvent(parameters: Readonly<Record<string, unknown>>): boolean {
  const { commands } = parameters;
  if (Array.isArray(commands))
    for (const command of commands)
      if (
        typeof command === "string" &&
        clipboardEditingCommands.has(command.replace(/:$/u, "").toLowerCase())
      )
        return true;
  if (parameters.type !== "keyDown" && parameters.type !== "rawKeyDown") return false;
  const modifiers =
    typeof parameters.modifiers === "number"
      ? parameters.modifiers & (alt | control | meta | shift)
      : 0;
  const keys = clipboardChords.get(modifiers);
  return keys !== undefined && chordKeys(parameters).some((key) => keys.has(key));
}

const clipboardPermissionTypes = new Set(["clipboardReadWrite", "clipboardSanitizedWrite"]);
const clipboardPermissionNames = new Set(["clipboard-read", "clipboard-write"]);

function clipboardPermission(method: string, parameters: Readonly<Record<string, unknown>>) {
  if (method === "Browser.grantPermissions")
    return (
      Array.isArray(parameters.permissions) &&
      parameters.permissions.some(
        (permission) => typeof permission === "string" && clipboardPermissionTypes.has(permission),
      )
    );
  if (method === "Browser.setPermission") {
    const descriptor = parameters.permission;
    return (
      typeof descriptor === "object" &&
      descriptor !== null &&
      clipboardPermissionNames.has(String((descriptor as { name?: unknown }).name))
    );
  }
  return false;
}

/** How deep `Target.sendMessageToTarget` may nest before a command is refused unread. */
const maximumNesting = 8;

/**
 * Whether a connection's command would use the clipboard in the browser: a key event that
 * copies, cuts or pastes, stated or by its chord, or a grant of a clipboard permission that would
 * let page script read it. A nested `Target.sendMessageToTarget` message is read the same way.
 */
export function usesBrowserClipboard(
  method: string,
  parameters: Readonly<Record<string, unknown>> | undefined,
  depth = 0,
): boolean {
  const values = parameters ?? {};
  if (method === "Input.dispatchKeyEvent") return clipboardKeyEvent(values);
  if (clipboardPermission(method, values)) return true;
  if (method !== "Target.sendMessageToTarget" || typeof values.message !== "string") return false;
  if (depth >= maximumNesting) return true;
  let nested: unknown;
  try {
    nested = JSON.parse(values.message);
  } catch {
    // The router refuses a message it cannot read.
    return false;
  }
  if (typeof nested !== "object" || nested === null) return false;
  const { method: nestedMethod, params } = nested as { method?: unknown; params?: unknown };
  return (
    typeof nestedMethod === "string" &&
    usesBrowserClipboard(
      nestedMethod,
      typeof params === "object" && params !== null
        ? (params as Readonly<Record<string, unknown>>)
        : undefined,
      depth + 1,
    )
  );
}
