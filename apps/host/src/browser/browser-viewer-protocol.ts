import type { BrowserServerMessage } from "@opensteer/protocol/browser";

type Snapshot = Extract<BrowserServerMessage, { type: "browser.snapshot" }>;
export function browserViewerEditingVersion(
  snapshot: Pick<Snapshot, "editingVersion" | "clipboard">,
  requested: 1 | 2 | undefined,
): 1 | 2 | undefined {
  const version = snapshot.editingVersion;
  return requested === 2
    ? version
    : requested === 1 && (version === 1 || (version === 2 && snapshot.clipboard))
      ? 1
      : undefined;
}

export function browserViewerMessage(
  message: BrowserServerMessage,
  editing: 1 | 2 | undefined = undefined,
): BrowserServerMessage {
  if (message.type === "browser.snapshot") {
    const { editingVersion: _editingVersion, clipboard: _clipboard, ...baseline } = message;
    message =
      editing === 2 ? message : editing === 1 ? { ...baseline, editingVersion: 1 } : baseline;
  }
  if (message.type !== "browser.snapshot" && message.type !== "browser.surfaces.changed")
    return message;
  return {
    ...message,
    surfaces: message.surfaces.map(
      ({ canGoBack: _canGoBack, canGoForward: _canGoForward, ...surface }) => surface,
    ),
  };
}
