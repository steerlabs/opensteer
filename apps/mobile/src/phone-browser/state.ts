import type {
  BrowserAttachTicketClaims,
  BrowserDialog,
  BrowserServerMessage,
} from "@opensteer/protocol/browser";
import type {
  BrowserCapabilityReference,
  BrowserChannelId,
} from "@opensteer/protocol/browser-relay";
import type { NativeTabMetadata } from "./native-port.js";

export type PhoneTabState = "live-visible" | "live-covered" | "retained" | "discarded" | "closed";
export interface PhoneTab {
  readonly id: string;
  readonly sessionId: string;
  readonly order: number;
  readonly openerId: string | null;
  metadata: NativeTabMetadata;
  lastDocumentId: string;
  state: PhoneTabState;
  dialog: BrowserDialog | null;
  lastUsed: number;
  presentationGeneration: number;
  editingContextId: string | null;
}
export interface PhoneSession {
  claims: BrowserAttachTicketClaims;
  readonly initialId: string;
  readonly storeHandle: string | null;
  allocationPermit: string;
  readonly tabs: Map<string, PhoneTab>;
  readonly channels: Set<BrowserChannelId>;
  readonly opened: Map<string, { fingerprint: string; outcome: Promise<string> }>;
  readonly closed: Set<string>;
  activeId: string | null;
  revision: number;
  closing: boolean;
}
export interface PhoneChannel {
  readonly id: BrowserChannelId;
  capability: BrowserCapabilityReference;
  readonly session: PhoneSession;
  readonly epoch: number;
  readonly claims: BrowserAttachTicketClaims;
  readonly subscriptions: Map<string, { density: number; frames: boolean; frameWindow?: 1 }>;
  /** What native reported before this channel's snapshot went out; null once it has. */
  held: BrowserServerMessage[] | null;
}
export function isLive(tab: PhoneTab): boolean {
  return tab.state === "live-visible" || tab.state === "live-covered";
}
