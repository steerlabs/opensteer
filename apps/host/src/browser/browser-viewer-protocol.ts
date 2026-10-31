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
  passkeys?: "native" | "notice",
  consumerToken?: string,
): BrowserServerMessage {
  if (message.type === "browser.snapshot") {
    const {
      navigationAttributionVersion: _navigationAttributionVersion,
      editingVersion: _editingVersion,
      clipboard: _clipboard,
      passkeys: _passkeys,
      passkeyConsumerToken: _passkeyConsumerToken,
      ...baseline
    } = message;
    message =
      editing === 2
        ? {
            ...baseline,
            editingVersion: message.editingVersion,
            ...(message.clipboard === undefined ? {} : { clipboard: message.clipboard }),
          }
        : editing === 1
          ? { ...baseline, editingVersion: 1 }
          : baseline;
    if (passkeys) message = { ...message, passkeys, passkeyConsumerToken: consumerToken };
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
