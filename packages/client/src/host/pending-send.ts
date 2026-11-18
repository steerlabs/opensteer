import type { z } from "zod";
import { isPlaceContentPart } from "@opensteer/core";
import {
  ContentPartSchema,
  type PlaceContentPart,
  type ContentPart,
  type BrowserPageContentPart,
} from "@opensteer/core";
import { type HostApiCommandInput } from "@opensteer/protocol";

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

/** Recover a draft without choosing or replacing any of its included places. */
export function messageDraftParts(content: readonly z.input<typeof ContentPartSchema>[]): {
  readonly body: string;
  readonly attachments: readonly Extract<ContentPart, { readonly type: "artifact" }>[];
  readonly places: readonly PlaceContentPart[];
} {
  const parsed = content.map((part) => ContentPartSchema.parse(part));
  return {
    body: parsed.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    attachments: parsed.filter((part) => part.type === "artifact"),
    places: parsed.filter(isPlaceContentPart),
  };
}
