import { randomUUID } from "node:crypto";
import { refused, TabIdSchema } from "@opensteer/core";
import { BrowserCdpCommandSchema, browserHostMethods, type PageAgentBinding } from "@opensteer/protocol";
import { boundedJsonSize } from "@opensteer/browser-runtime-core";
import { z } from "zod";
import { BrowserCdpConnectionEnded, type BrowserService } from "../browser/browser-service.js";
import type { CdpAuthority } from "../browser/standard-cdp-tickets.js";
import { browserReplLimits, browserTargetSchema } from "./browser-repl-messages.js";
import type {
  BrowserUseBudget,
  BrowserUseCall,
  BrowserUseEvent,
  BrowserUsePage,
  BrowserUsePort,
  BrowserUseTarget,
} from "./browser-repl-service.js";

export interface BrowserUseTabAccess {
  pages(call: BrowserUseCall): AsyncIterable<BrowserUsePage>;
  bind(tabId: string, signal: AbortSignal): Promise<PageAgentBinding>;
  open(input: { url: string; profileId?: string }, key: string, signal: AbortSignal): Promise<PageAgentBinding>;
}
type Relay = Awaited<ReturnType<BrowserService["attachCdpForAgent"]>>;
type RelayEvent = Parameters<Parameters<BrowserService["attachCdpForAgent"]>[1]>[0];
interface Target extends BrowserUseTarget {
  relay: Relay;
  port: BrowserUsePort<Target>;
  closed: boolean;
  stop(): void;
  listen?: (event: RelayEvent) => void;
  onEnd?: () => void;
}
const resumed = z.object({ targetId: z.string(), dialog: browserTargetSchema.shape.dialog });
const attached = z.object({ sessionId: z.string(), dialog: browserTargetSchema.shape.dialog });
const tooLarge = () => refused("resource_exhausted", "Browser result exceeds its byte or nesting limit. Narrow the query.");
const ended = () => refused("conflict", "The browser page attachment has ended.", "Use pages() and openPage(tabId) to bind an available tab.");

function encode(value: unknown, budget: BrowserUseBudget): string {
  if (boundedJsonSize(value, budget) === undefined) throw tooLarge();
  return JSON.stringify(value);
}

export function createBrowserUsePort({ authority, tabs, browser }: {
  authority: CdpAuthority;
  tabs: BrowserUseTabAccess;
  browser: Pick<BrowserService, "attachCdpForAgent">;
}): BrowserUsePort<Target> {
  async function bind(binding: PageAgentBinding, call: BrowserUseCall): Promise<Target> {
    call.signal.throwIfAborted();
    if (binding.backend !== "cdp") throw refused("conflict", "This tab does not support the Browser Harness CDP backend.");
    let target: Target | undefined;
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (target) {
        target.closed = true;
        target.onEnd?.();
        delete target.listen;
        delete target.onEnd;
      }
    };
    const relay = await browser.attachCdpForAgent(
      { ...authority, sessionId: binding.sessionId },
      (event) => {
        if (!target || closed) return;
        if ((event.method === "Target.detachedFromTarget" && event.parameters.sessionId === target.sessionId) ||
            (event.method === "Target.targetDestroyed" && event.parameters.targetId === target.targetId)) {
          target.stop();
          return;
        }
        target.listen?.(event);
      },
      stop,
    );
    const dispose = () => {
      stop();
      relay.close();
    };
    try {
      const request = async (method: string, parameters: Record<string, unknown>) =>
        (await relay.dispatch({ method, parameters }, call)).result;
      const page = resumed.parse(await request(browserHostMethods.resumeTab, { surfaceId: binding.tabId }));
      const channel = attached.parse(await request("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
      if (closed) throw ended();
      const fields = browserTargetSchema.parse({ ...page, ...channel, tabId: binding.tabId });
      const stopTarget = () => {
        if (closed) return;
        // Detach releases held input without closing the Browser Session.
        void relay.dispatch({ method: "Target.detachFromTarget", parameters: { sessionId: channel.sessionId } }, callBudget(call)).then(({ result }) => result).catch(() => undefined).finally(() => relay.close());
        stop();
      };
      target = { ...fields, relay, port, closed, stop: stopTarget };
      call.signal.throwIfAborted();
      return target;
    } catch (error) {
      if (target) target.stop();
      else dispose();
      if (error instanceof BrowserCdpConnectionEnded) throw ended();
      throw error;
    }
  }
  const port: BrowserUsePort<Target> = {
    async listPages(call) {
      const pages: BrowserUsePage[] = [];
      let bytes = call.maxBytes - 2;
      let entries = call.maxEntries - 1;
      if (call.maxDepth < 2 || bytes < 0 || entries < 0) throw tooLarge();
      for await (const page of tabs.pages(call)) {
        call.signal.throwIfAborted();
        if (pages.length >= browserReplLimits.events || entries < 5) throw tooLarge();
        const size = boundedJsonSize(page, { ...call, maxBytes: bytes - Number(pages.length > 0) });
        if (size === undefined) throw tooLarge();
        bytes -= size + Number(pages.length > 0);
        entries -= 5;
        pages.push(page);
      }
      return pages;
    },
    async openPage(tabId, call) {
      if (!TabIdSchema.safeParse(tabId).success) throw refused("not_found", "Tab not found.");
      call.signal.throwIfAborted();
      return bind(await tabs.bind(tabId, call.signal), call);
    },
    async newPage(input, call) {
      call.signal.throwIfAborted();
      return bind(await tabs.open(input, randomUUID(), call.signal), call);
    },
    async command(target, method, params, sessionId, call) {
      call.signal.throwIfAborted();
      if (target.closed) throw ended();
      const parsed = BrowserCdpCommandSchema.safeParse({ method, parameters: params, sessionId });
      if (!parsed.success) throw refused("bad_request", "Invalid CDP command.");
      if (method === "Opensteer.fillLogin" || method === "Opensteer.fillCard")
        throw refused("forbidden", "Saved-login and card fills require their own approved Request.");
      if (method === "Page.captureScreenshot" && sessionId === undefined)
        throw refused("bad_request", "Capture a screenshot on an attached page.");
      try {
        const { result } = await target.relay.dispatch(parsed.data, call);
        return encode(await result, call);
      } catch (error) {
        if (error instanceof BrowserCdpConnectionEnded) throw ended();
        throw error;
      }
    },
    subscribe(target, onEvent, onEnd, budget) {
      if (target.closed) {
        onEnd();
        return () => undefined;
      }
      target.onEnd = onEnd;
      target.listen = ({ method, parameters, sessionId }) => {
        if (sessionId !== undefined && sessionId !== target.sessionId) return;
        if (boundedJsonSize({ method, parameters, ...(sessionId ? { sessionId } : {}) }, budget) === undefined) return;
        const event: BrowserUseEvent = { method, paramsJson: JSON.stringify(parameters), ...(sessionId ? { sessionId } : {}) };
        onEvent(event);
      };
      return () => {
        delete target.onEnd;
        target.stop();
      };
    },
  };
  return port;
}

function callBudget({ maxBytes, maxDepth, maxEntries }: BrowserUseBudget) {
  return { maxBytes, maxDepth, maxEntries };
}
