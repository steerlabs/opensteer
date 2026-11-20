import { type AttachTicketVerifier } from "@opensteer/browser-runtime-core";
import { browserHostMethods } from "@opensteer/protocol";
import { z } from "zod";

/** What this Mac knows about a tab an agent opened here. */
export interface AgentBrowserTab {
  readonly sessionId: string;
  /** A saved browser profile, rather than a fresh throwaway session. */
  readonly profile: boolean;
}

export interface GatedAttachment {
  handle(frame: string | Buffer): Promise<void>;
  close(): Promise<void>;
}

type Actor = "agent" | "person";

interface PendingOpen {
  actor: Actor | null;
  tab: AgentBrowserTab | null;
}

const hostMethods: ReadonlySet<string> = new Set(Object.values(browserHostMethods));
const CommandFrameSchema = z.object({
  type: z.string(),
  requestId: z.uuid().optional(),
  command: z.object({ method: z.string() }).optional(),
});

/**
 * What in a frame acts for an agent. Viewer messages are the person's own
 * input and Watch; the Host's tab management is the person's or the Host's,
 * and an agent's tab open carries an authority the gate's verifier reads.
 * Every other CDP command is an agent's.
 */
export function agentFrame(frame: string | Buffer): { readonly requestId: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CommandFrameSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.type.startsWith("agent.")) return { requestId: null };
  if (parsed.data.type !== "cdp.command") return null;
  if (hostMethods.has(parsed.data.command?.method ?? "")) return null;
  return { requestId: parsed.data.requestId ?? null };
}

export class AgentBrowserGate {
  readonly #pending = new Map<string, PendingOpen>();
  readonly #agentTabs = new Map<GatedAttachment, AgentBrowserTab>();
  /** The person's attachments an agent has acted in, shown as that agent's. */
  readonly #shared = new Map<GatedAttachment, AgentBrowserTab>();
  readonly #standard = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  /** Live attachments an agent opened on this Mac. */
  get agentTabs(): number {
    return this.#agentTabs.size + this.#standard.size;
  }

  /** Each browser session an agent is acting in, its own or one it shares with the person. */
  agentTabDetails(): readonly AgentBrowserTab[] {
    const seen = new Set<string>();
    return [...this.#agentTabs.values(), ...this.#shared.values()].filter((tab) => {
      if (seen.has(tab.sessionId)) return false;
      seen.add(tab.sessionId);
      return true;
    });
  }

  /** The runtime verifies every attach ticket and every agent tab open through this. */
  verifier(inner: AttachTicketVerifier): AttachTicketVerifier {
    return {
      verify: async (token, expectation) => {
        const claims = await inner.verify(token, expectation);
        const actor: Actor = claims.actor ?? claims.creationOrigin;
        const pending = this.#pending.get(token);
        if (pending) {
          pending.actor = actor;
          pending.tab = {
            sessionId: claims.sessionId,
            profile: claims.identity.kind === "profile-local",
          };
        }
        return claims;
      },
    };
  }

  async attach<Attachment extends GatedAttachment>(
    ticket: string,
    run: () => Promise<Attachment>,
  ): Promise<Attachment> {
    const entry: PendingOpen = { actor: null, tab: null };
    this.#pending.set(ticket, entry);
    try {
      return this.#track(await run(), entry.actor === "agent", entry.tab);
    } finally {
      if (this.#pending.get(ticket) === entry) this.#pending.delete(ticket);
    }
  }

  async attachStandard<Attachment extends { signal: AbortSignal; close(): void }>(
    open: () => Promise<Attachment>,
  ): Promise<Attachment> {
    const attachment = await open();
    if (attachment.signal.aborted) return attachment;
    const close = () => {
      if (this.#standard.delete(close)) this.#emit();
    };
    this.#standard.add(close);
    attachment.signal.addEventListener("abort", close, { once: true });
    this.#emit();
    return attachment;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #track<Attachment extends GatedAttachment>(
    attachment: Attachment,
    agent: boolean,
    tab: AgentBrowserTab | null,
  ): Attachment {
    const close = attachment.close.bind(attachment);
    if (agent) {
      attachment.close = () => {
        if (this.#agentTabs.delete(attachment)) this.#emit();
        return close();
      };
      this.#agentTabs.set(attachment, tab ?? { sessionId: "unknown", profile: false });
      this.#emit();
      return attachment;
    }
    const handle = attachment.handle.bind(attachment);
    attachment.handle = (frame) => {
      if (agentFrame(frame) && tab && !this.#shared.has(attachment)) {
        this.#shared.set(attachment, tab);
        this.#emit();
      }
      return handle(frame);
    };
    attachment.close = () => {
      if (this.#shared.delete(attachment)) this.#emit();
      return close();
    };
    return attachment;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
