import {
  standardCdpPageMethods,
  standardCdpRootTargetMethods,
} from "./standard-cdp-page-methods.js";

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

/**
 * The domains a connected agent's CDP acts through on its own pages, for the sentence that
 * refuses anything else.
 */
const pageDomains = [...new Set([...standardCdpPageMethods].map((method) => method.split(".")[0]!))]
  .sort((left, right) => left.localeCompare(right))
  .join(", ");

/** The sentence that refuses a method outside the standard lists to a connection's work. */
export function connectionMethodRefusal(method: string): string {
  return `${method} is not available to a connected agent. Its CDP acts on its own pages through the ${pageDomains} domains, and at the browser root only through Target and Browser.getVersion.`;
}

export const connectionNestedAutoAttachRefusal =
  "A connected agent sends Target.setAutoAttach to the page itself, not inside Target.sendMessageToTarget.";

/**
 * Work under a connection's authority may send only what a standard `browser_connect` client may:
 * the standard root list and the standard page list. Opensteer's own methods (`Opensteer.*`) are
 * not Chromium's and keep their own admission. A nested `Target.sendMessageToTarget` message is
 * read as the page command it carries; a nested auto-attach is refused, since its children could
 * not be limited before they attach.
 */
export function connectionCdpRefusal(
  method: string,
  parameters: Parameters | undefined,
  onPage: boolean,
  depth = 0,
): string | undefined {
  if (method.startsWith("Opensteer.")) return undefined;
  const listed = onPage
    ? standardCdpPageMethods.has(method)
    : method === "Browser.getVersion" || standardCdpRootTargetMethods.has(method);
  if (!listed) return connectionMethodRefusal(method);
  if (method === "Target.setAutoAttach" && depth > 0) return connectionNestedAutoAttachRefusal;
  const message = parameters?.message;
  if (method !== "Target.sendMessageToTarget" || typeof message !== "string") return undefined;
  if (depth >= maximumNesting) return connectionMethodRefusal(method);
  let nested: unknown;
  try {
    nested = JSON.parse(message);
  } catch {
    // The router refuses a message it cannot read.
    return undefined;
  }
  if (typeof nested !== "object" || nested === null) return undefined;
  const { method: nestedMethod, params } = nested as { method?: unknown; params?: unknown };
  if (typeof nestedMethod !== "string") return undefined;
  return connectionCdpRefusal(
    nestedMethod,
    typeof params === "object" && params !== null ? (params as Parameters) : undefined,
    true,
    depth + 1,
  );
}

/** The only children a connection's auto-attach reaches: frames in other processes and workers. */
const connectionChildTypes = ["iframe", "worker"] as const;

/** Whether a CDP target filter (first matching entry decides) admits a target type. */
function filterAdmits(filter: unknown, type: string): boolean {
  if (!Array.isArray(filter)) return true;
  for (const entry of filter) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type: entryType, exclude } = entry as { type?: unknown; exclude?: unknown };
    if (entryType === undefined || entryType === type) return exclude !== true;
  }
  return false;
}

/**
 * A connection's page auto-attach as the browser receives it: limited at the physical attachment
 * to the iframes and dedicated workers the request asked for, and never paused at start.
 */
export function connectionAutoAttachParameters(parameters: Parameters | undefined): Parameters {
  const requested = parameters?.filter;
  return {
    ...parameters,
    waitForDebuggerOnStart: false,
    filter: [
      ...connectionChildTypes
        .filter((type) => filterAdmits(requested, type))
        .map((type) => ({ type })),
      { exclude: true },
    ],
  };
}

/** Whether a `Target.sendMessageToTarget` carries an auto-attach at any depth. */
export function nestsAutoAttach(
  method: string,
  parameters: Parameters | undefined,
  depth = 0,
): boolean {
  if (method === "Target.setAutoAttach") return depth > 0;
  const message = parameters?.message;
  if (method !== "Target.sendMessageToTarget" || typeof message !== "string") return false;
  if (depth >= maximumNesting) return true;
  let nested: unknown;
  try {
    nested = JSON.parse(message);
  } catch {
    return false;
  }
  if (typeof nested !== "object" || nested === null) return false;
  const { method: nestedMethod, params } = nested as { method?: unknown; params?: unknown };
  return (
    typeof nestedMethod === "string" &&
    nestsAutoAttach(
      nestedMethod,
      typeof params === "object" && params !== null ? (params as Parameters) : undefined,
      depth + 1,
    )
  );
}
