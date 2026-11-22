/**
 * CDP commands refused before any effect, by who sends them.
 *
 * Work done under a connected agent's authority never uses the clipboard in the browser and never
 * changes a browser permission: neither the clipboard nor the person's camera, microphone or
 * location is in any grant. Whether work is a connection's is decided by the one authority rule
 * when its attachment is made; this module only refuses what follows from that fact.
 *
 * Nobody grants a page a clipboard permission through CDP, the person's own agents included: a
 * grant lasts for the browser context, so it would later serve a connected agent's page script.
 */
export const connectionClipboardRefusal =
  "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";

export const connectionPermissionRefusal =
  "Browser permissions cannot be changed by a connected agent.";

export const clipboardPermissionRefusal =
  "Clipboard permissions cannot be granted to a page. Paste with a key chord, or use Input.insertText to enter text.";

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

type Parameters = Readonly<Record<string, unknown>>;

/** Blink reads `windowsVirtualKeyCode`; the router reads `code` and `key`. Each one counts. */
function chordKeys(parameters: Parameters): string[] {
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

function clipboardKeyEvent(parameters: Parameters): boolean {
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

const permissionMethods = new Set([
  "Browser.grantPermissions",
  "Browser.setPermission",
  "Browser.resetPermissions",
]);
const clipboardPermissionTypes = new Set(["clipboardReadWrite", "clipboardSanitizedWrite"]);
const clipboardPermissionNames = new Set(["clipboard-read", "clipboard-write"]);

/** A grant of a clipboard permission: anything but a clipboard permission set to denied. */
function clipboardPermissionGrant(method: string, parameters: Parameters): boolean {
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
      clipboardPermissionNames.has(String((descriptor as { name?: unknown }).name)) &&
      parameters.setting !== "denied"
    );
  }
  return false;
}

/** How deep `Target.sendMessageToTarget` may nest before a command is refused unread. */
const maximumNesting = 8;

/**
 * The sentence that refuses this command for its sender, or undefined when it may be sent.
 * `connection` is whether the command is sent under a connection's authority. A nested
 * `Target.sendMessageToTarget` message is read as the command it carries.
 */
export function cdpCommandRefusal(
  method: string,
  parameters: Parameters | undefined,
  connection: boolean,
  depth = 0,
): string | undefined {
  const values = parameters ?? {};
  if (connection && permissionMethods.has(method)) return connectionPermissionRefusal;
  if (clipboardPermissionGrant(method, values)) return clipboardPermissionRefusal;
  if (method === "Input.dispatchKeyEvent")
    return connection && clipboardKeyEvent(values) ? connectionClipboardRefusal : undefined;
  if (method !== "Target.sendMessageToTarget" || typeof values.message !== "string")
    return undefined;
  if (depth >= maximumNesting)
    return connection ? connectionPermissionRefusal : clipboardPermissionRefusal;
  let nested: unknown;
  try {
    nested = JSON.parse(values.message);
  } catch {
    // The router refuses a message it cannot read.
    return undefined;
  }
  if (typeof nested !== "object" || nested === null) return undefined;
  const { method: nestedMethod, params } = nested as { method?: unknown; params?: unknown };
  return typeof nestedMethod === "string"
    ? cdpCommandRefusal(
        nestedMethod,
        typeof params === "object" && params !== null ? (params as Parameters) : undefined,
        connection,
        depth + 1,
      )
    : undefined;
}
