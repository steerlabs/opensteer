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

type Actor = "agent" | "person";

/** One attach under way: the generation it began in, and whom its ticket says it acts for. */
interface PendingOpen {
  readonly generation: number;
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

/**
 * The menu bar's Stop for this Mac's browsers. While stopped, no agent
 * attachment exists here: Stop closes every one, and with it whatever it had
 * queued, and a new one is admitted only if the gate is still in the
 * generation it was asked in at the moment it would open. Whom an attachment
 * acts for is the Home's `actor` claim, or its `creationOrigin` from a Home
 * that does not say. The person's own attachments stay open, their input and
 * Watch flowing; only agent commands relayed on them are refused. The runtime
 * itself is never closed here.
 */
export class AgentBrowserGate {
  readonly #admission: AgentAdmission;
  readonly #pending = new Map<string, PendingOpen>();
  readonly #agentTabs = new Map<GatedAttachment, AgentBrowserTab>();
  /** The person's attachments an agent has acted in, shown as that agent's. */
  readonly #shared = new Map<GatedAttachment, AgentBrowserTab>();
  readonly #standard = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  constructor(admission: AgentAdmission) {
    this.#admission = admission;
  }

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
        if (actor !== "agent") return claims;
        // An attach compares the generation it began in; a tab open on an
        // attachment already admitted is refused while stopped.
        if (pending ? !this.#admission.current(pending.generation) : !this.#admission.open)
          throw stopped();
        return claims;
      },
    };
  }

  /** One attach, admitted for an agent only within the generation it began in. */
  async attach<Attachment extends GatedAttachment>(
    ticket: string,
    sink: Pick<BrowserControllerSink, "sendServer">,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<Attachment>,
  ): Promise<Attachment> {
    const entry: PendingOpen = { generation: this.#admission.generation, actor: null, tab: null };
    this.#pending.set(ticket, entry);
    const cancel = new AbortController();
    const unsubscribe = this.#admission.subscribe(() => {
      // A ticket still being verified is checked when its verification ends.
      if (entry.actor === "agent" && !this.#admission.current(entry.generation))
        cancel.abort(stopped());
    });
    let attachment: Attachment;
    try {
      attachment = await run(signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal);
    } finally {
      unsubscribe();
      if (this.#pending.get(ticket) === entry) this.#pending.delete(ticket);
    }
    const agent = entry.actor === "agent";
    if (agent && !this.#admission.current(entry.generation)) {
      await attachment.close().catch(() => undefined);
      throw stopped();
    }
    return this.#guard(attachment, sink, agent, entry.tab);
  }

  /**
   * A raw CDP attachment, which only an agent opens. Admitted within the
   * generation it began in, and closed by Stop like any agent attachment.
   */
  async attachStandard<Attachment extends { signal: AbortSignal; close(): void }>(
    signal: AbortSignal,
    open: (signal: AbortSignal) => Promise<Attachment>,
  ): Promise<Attachment> {
    if (!this.#admission.open) throw stopped();
    const generation = this.#admission.generation;
    const cancellation = new AbortController();
    const unsubscribe = this.#admission.subscribe(() => {
      if (!this.#admission.current(generation)) cancellation.abort(stopped());
    });
    let attachment: Attachment;
    try {
      attachment = await open(AbortSignal.any([signal, cancellation.signal]));
    } finally {
      unsubscribe();
    }
    if (!this.#admission.current(generation)) {
      attachment.close();
      throw stopped();
    }
    if (attachment.signal.aborted) return attachment;
    const close = () => {
      if (this.#standard.delete(close)) this.#emit();
      attachment.close();
    };
    this.#standard.add(close);
    attachment.signal.addEventListener(
      "abort",
      () => {
        if (this.#standard.delete(close)) this.#emit();
      },
      { once: true },
    );
    this.#emit();
    return attachment;
  }

  /**
   * Stop's teardown for this Mac's browsers: every agent attachment closes,
   * dropping what it had queued. The person's own attachments stay. Throws
   * when one did not confirm its close.
   */
  async pause(): Promise<void> {
    for (const close of this.#standard) close();
    const results = await Promise.allSettled(
      [...this.#agentTabs.keys()].map((attachment) => attachment.close()),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("An agent's browser tab did not close.");
  }

  resume(): void {}

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #guard<Attachment extends GatedAttachment>(
    attachment: Attachment,
    sink: Pick<BrowserControllerSink, "sendServer">,
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
    // The person's attachment: an agent's commands relayed on it are refused
    // while stopped, and an agent acting in it shows as using that tab.
    const handle = attachment.handle.bind(attachment);
    attachment.handle = (frame) => {
      const agent = agentFrame(frame);
      if (!agent) return handle(frame);
      if (this.#admission.open) {
        if (tab && !this.#shared.has(attachment)) {
          this.#shared.set(attachment, tab);
          this.#emit();
        }
        return handle(frame);
      }
      if (!agent.requestId) return Promise.resolve();
      return sink.sendServer({
        type: "cdp.error",
        requestId: agent.requestId,
        error: stopped().toProtocolError(),
      });
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
