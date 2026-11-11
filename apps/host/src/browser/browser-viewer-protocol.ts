import type { PersonFillVersion } from "@opensteer/protocol";
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
  popups = false,
  negotiation: {
    readonly basicInput: boolean;
    readonly surfaceState: boolean;
    /** The person fill version the viewer understands, or 0. */
    readonly autofill?: 0 | PersonFillVersion;
  } = { basicInput: false, surfaceState: false },
): BrowserServerMessage {
  if (message.type === "browser.snapshot") {
    const {
      basicInput: _basicInput,
      surfaceState: _surfaceState,
      navigationAttributionVersion: _navigationAttributionVersion,
      editingVersion: _editingVersion,
      personFillVersion: _personFillVersion,
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
    if (negotiation.basicInput && message.type === "browser.snapshot")
      message = { ...message, basicInput: 1 };
    if (negotiation.surfaceState && message.type === "browser.snapshot")
      message = { ...message, surfaceState: 1 };
    if (passkeys) message = { ...message, passkeys, passkeyConsumerToken: consumerToken };
    if (popups) message = { ...message, consumerToken };
    const personFill = Math.min(_personFillVersion ?? 0, negotiation.autofill ?? 0);
    if (personFill === 1 || personFill === 2)
      message = { ...message, personFillVersion: personFill };
  }
  if (message.type !== "browser.snapshot" && message.type !== "browser.surfaces.changed")
    return message;
  return {
    ...message,
    surfaces: message.surfaces.map(
      ({ canGoBack: _canGoBack, canGoForward: _canGoForward, state, ...surface }) =>
        negotiation.surfaceState && state !== undefined ? { ...surface, state } : surface,
    ),
  };
}
