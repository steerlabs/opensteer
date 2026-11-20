import {
  BrowserRuntimeError,
  type AttachTicketVerifier,
  type BrowserControllerSink,
} from "@opensteer/browser-runtime-core";
import { browserHostMethods } from "@opensteer/protocol";
import { z } from "zod";
import type { AgentAdmission } from "../app/agent-admission.js";

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

const stoppedSentence =
  "Agents were stopped on this Mac from the Opensteer menu bar. Resume there to use its tabs again.";

function stopped(): BrowserRuntimeError {
  return new BrowserRuntimeError("forbidden", stoppedSentence, { reason: "device-stopped" });
}

interface PendingOpen {
  generation: number | null;
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

/**
 * The menu bar's Stop for this Mac's browsers. A tab an agent opens is
 * refused while stopped, and one being opened when Stop begins is cancelled,
 * or ended if it finished opening in a generation that has since closed. A
 * session the person shares with an agent stays theirs: their own input and
 * Watch go through, while each agent command is refused at the moment it
 * would reach the page. Nothing the person opened is closed.
 */
export class AgentBrowserGate {
  readonly #admission: AgentAdmission;
  readonly #pending = new Map<string, PendingOpen>();
  readonly #agentTabs = new Map<GatedAttachment, AgentBrowserTab>();
  readonly #listeners = new Set<() => void>();

  constructor(admission: AgentAdmission) {
    this.#admission = admission;
  }

  /** Live tabs an agent opened on this Mac. */
  get agentTabs(): number {
    return this.#agentTabs.size;
  }

  agentTabDetails(): readonly AgentBrowserTab[] {
    return [...this.#agentTabs.values()];
  }

  /** The runtime verifies every attach ticket and every agent tab open through this. */
  verifier(inner: AttachTicketVerifier): AttachTicketVerifier {
    return {
      verify: async (token, expectation) => {
        const claims = await inner.verify(token, expectation);
        if (claims.creationOrigin !== "agent") return claims;
        if (!this.#admission.open) throw stopped();
        const pending = this.#pending.get(token);
        if (pending) {
          pending.generation = this.#admission.generation;
          pending.tab = {
            sessionId: claims.sessionId,
            profile: claims.identity.kind === "profile-local",
          };
        }
        return claims;
      },
    };
  }

  /** One attach, cancelled if Stop begins while an agent's open is under way. */
  async attach<Attachment extends GatedAttachment>(
    ticket: string,
    sink: Pick<BrowserControllerSink, "sendServer">,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<Attachment>,
  ): Promise<Attachment> {
    const entry: PendingOpen = { generation: null, tab: null };
    this.#pending.set(ticket, entry);
    const cancel = new AbortController();
    const unsubscribe = this.#admission.subscribe(() => {
      if (entry.generation !== null && !this.#admission.current(entry.generation))
        cancel.abort(stopped());
    });
    let attachment: Attachment;
    try {
      attachment = await run(signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal);
    } finally {
      unsubscribe();
      if (this.#pending.get(ticket) === entry) this.#pending.delete(ticket);
    }
    const agentOpened = entry.generation !== null;
    if (agentOpened && !this.#admission.current(entry.generation!)) {
      await attachment.close().catch(() => undefined);
      throw stopped();
    }
    return this.#guard(attachment, sink, agentOpened ? entry.tab : null);
  }

  async attachStandard<Attachment extends { signal: AbortSignal; close(): void }>(
    signal: AbortSignal,
    open: (signal: AbortSignal) => Promise<Attachment>,
  ): Promise<Attachment> {
    if (!this.#admission.open) throw stopped();
    const generation = this.#admission.generation;
    const cancellation = new AbortController();
    const life = AbortSignal.any([signal, cancellation.signal]);
    const unsubscribe = this.#admission.subscribe(() => {
      if (!this.#admission.current(generation)) cancellation.abort(stopped());
    });
    try {
      const attachment = await open(life);
      const close = () => { unsubscribe(); attachment.close(); };
      if (life.aborted) {
        close();
        life.throwIfAborted();
      }
      if (attachment.signal.aborted) unsubscribe();
      else {
        life.addEventListener("abort", close, { once: true });
        attachment.signal.addEventListener("abort", () => {
          unsubscribe();
          life.removeEventListener("abort", close);
        }, { once: true });
      }
      return attachment;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #guard<Attachment extends GatedAttachment>(
    attachment: Attachment,
    sink: Pick<BrowserControllerSink, "sendServer">,
    agentTab: AgentBrowserTab | null,
  ): Attachment {
    const handle = attachment.handle.bind(attachment);
    attachment.handle = (frame) => {
      if (this.#admission.open) return handle(frame);
      const refused = agentFrame(frame);
      if (!refused) return handle(frame);
      if (!refused.requestId) return Promise.resolve();
      return sink.sendServer({
        type: "cdp.error",
        requestId: refused.requestId,
        error: stopped().toProtocolError(),
      });
    };
    if (!agentTab) return attachment;
    const close = attachment.close.bind(attachment);
    attachment.close = () => {
      if (this.#agentTabs.delete(attachment)) this.#emit();
      return close();
    };
    this.#agentTabs.set(attachment, agentTab);
    this.#emit();
    return attachment;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
