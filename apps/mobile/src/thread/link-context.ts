import { createContext, useContext, type ReactNode } from "react";

/** One choice in a held link's menu, in the hold menu's own shape. */
export interface LinkAction {
  readonly group: number;
  readonly id: string;
  readonly image: string;
  readonly title: string;
}

/** A link as written: where it goes and the words it shows, which Copy keeps together. */
export interface HeldLink {
  readonly href: string;
  readonly label: string;
}

/**
 * How a conversation's links open. Absent, a link goes to the system, as it
 * always has; a tap and a hold read the Host's view of this phone at that
 * moment, so a streaming transcript never re-renders for it.
 */
export interface ConversationLinks {
  readonly open: (url: string) => void;
  /** What holding the link offers; empty where a hold keeps doing what it did. */
  readonly menu: (link: HeldLink) => readonly LinkAction[];
  readonly act: (link: HeldLink, id: string) => void;
  /** Words a hold selects, around which a hold that begins on a link offers its places. */
  readonly Hold: (props: { readonly children: ReactNode }) => ReactNode;
}

export const ConversationLinksContext = createContext<ConversationLinks | null>(null);

export function useConversationLinks(): ConversationLinks | null {
  return useContext(ConversationLinksContext);
}

/**
 * A link inside something held: where the press began, so a hold that started
 * on a link offers the link's places rather than the message's actions.
 */
export interface LinkHold {
  /** The press began on this link; `at` is the touch's own time, shared by every handler of it. */
  readonly press: (link: HeldLink, at: number) => void;
  /** Held long enough to open its menu, where the platform does not do so itself. */
  readonly hold: (link: HeldLink) => void;
}

export const LinkHoldContext = createContext<LinkHold | null>(null);
