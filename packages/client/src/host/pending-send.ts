import { isPlaceContentPart } from "@opensteer/core";
import {
  ContentPartSchema,
  type ContentPart,
  type PlaceContentPart,
  type BrowserPageContentPart,
} from "@opensteer/core";
import { hostApi, type HostApiCommandInput } from "@opensteer/protocol";

export type PendingSendCommand = Extract<
  HostApiCommandInput,
  { readonly type: "thread.sendMessage" }
>;

/** The longest page address a message keeps whole; a longer one keeps only its site. */
const browserPageAddressLimit = 2048;

/**
 * The page a person includes with a message, as the content part it is sent
 * as: the exact session and tab, and the title and address it showed. It is
 * frozen when the message is kept, so a retry sends the same page even after
 * the person has moved on to another one.
 */
export function browserPagePart(page: {
  readonly sessionId: string;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly auto?: boolean | undefined;
  readonly documentId?: string | undefined;
}): BrowserPageContentPart {
  const part = ContentPartSchema.parse({
    ...(page.auto === undefined ? {} : { auto: page.auto }),
    ...(page.documentId === undefined ? {} : { documentId: page.documentId }),
    sessionId: page.sessionId,
    tabId: page.tabId,
    title: page.title.slice(0, 256),
    type: "browser-page",
    url: boundedPageAddress(page.url),
  });
  if (part.type !== "browser-page") throw new Error("A browser page part was not made.");
  return part;
}

/** A cut address would name a different page, so an over-long one keeps its site only. */
function boundedPageAddress(address: string): string {
  if (address.length <= browserPageAddressLimit) return address;
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
  } catch {
    return "";
  }
}

export interface PendingSendScope {
  readonly deploymentId: string;
  readonly userId: string;
  readonly threadId: string;
}

export interface PendingSendStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One exact command per authenticated Thread, persisted before it leaves the browser. */
export function createPendingSendStore(storage: PendingSendStorage) {
  const key = (scope: PendingSendScope): string => {
    if (!scope.deploymentId || !scope.userId || !scope.threadId) {
      throw new Error("A pending send needs its deployment, user, and thread.");
    }
    return `opensteer:pending-send:v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.threadId)}`;
  };
  const parse = (raw: string, scope: PendingSendScope): PendingSendCommand => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("The saved pending send is unreadable.");
    }
    const result = hostApi["commands.dispatch"].payload.safeParse(value);
    if (
      !result.success ||
      result.data.type !== "thread.sendMessage" ||
      result.data.threadId !== scope.threadId
    ) {
      throw new Error("The saved pending send does not match this thread.");
    }
    Reflect.deleteProperty(result.data, "screenPresentation");
    return result.data;
  };
  return {
    read(scope: PendingSendScope): PendingSendCommand | null {
      const raw = storage.getItem(key(scope));
      return raw === null ? null : parse(raw, scope);
    },
    claim(scope: PendingSendScope, command: PendingSendCommand): PendingSendCommand {
      const durable = { ...command };
      Reflect.deleteProperty(durable, "screenPresentation");
      const parsed = parse(JSON.stringify(durable), scope);
      const previous = this.read(scope);
      if (previous !== null) {
        if (JSON.stringify(previous) !== JSON.stringify(parsed)) {
          throw new Error("This thread already has a message awaiting acknowledgement.");
        }
        return previous;
      }
      storage.setItem(key(scope), JSON.stringify(parsed));
      return parsed;
    },
    clear(scope: PendingSendScope, idempotencyKey: string): void {
      const previous = this.read(scope);
      if (previous === null) return;
      if (previous.idempotencyKey !== idempotencyKey) {
        throw new Error("A different message is awaiting acknowledgement.");
      }
      storage.removeItem(key(scope));
    },
    /** Explicitly abandons an unreadable or unacknowledged local command. */
    discard(scope: PendingSendScope): void {
      storage.removeItem(key(scope));
    },
  };
}

/** Recover a draft without choosing or replacing any of its included places. */
export function messageDraftParts(content: readonly ContentPart[]): {
  readonly body: string;
  readonly attachments: readonly Extract<ContentPart, { readonly type: "artifact" }>[];
  readonly places: readonly PlaceContentPart[];
} {
  return {
    body: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    attachments: content.filter((part) => part.type === "artifact"),
    places: content.filter(isPlaceContentPart),
  };
}
