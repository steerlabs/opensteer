import { randomUUID } from "node:crypto";
import { boundedJsonSize } from "@opensteer/browser-runtime-core";
import { OpensteerError, refused, TabIdSchema, type ThreadId } from "@opensteer/core";
import {
  BrowserCdpCommandSchema,
  browserScriptScreenshotMaxBytes,
  browserHostMethods,
  type PageAgentBinding,
} from "@opensteer/protocol";
import { z } from "zod";
import { BrowserCdpConnectionEnded, type BrowserService } from "../browser/browser-service.js";
import type { CdpAuthority } from "../browser/standard-cdp-tickets.js";
import { browserReplLimits, browserTargetSchema } from "./browser-repl-messages.js";
import type {
  BrowserUseBudget,
  BrowserUseCall,
  BrowserUsePage,
  BrowserUsePort,
  BrowserUseTarget,
} from "./browser-repl-service.js";

interface AdmittedPage {
  binding: PageAgentBinding;
  threadId: ThreadId;
}

export interface BrowserUseTabAccess {
  pages(call: BrowserUseCall): AsyncIterable<BrowserUsePage>;
  bind(tabId: string, signal: AbortSignal): Promise<AdmittedPage>;
  open(
    input: { url: string; profileId?: string },
    key: string,
    signal: AbortSignal,
  ): Promise<AdmittedPage>;
}

type Relay = Awaited<ReturnType<BrowserService["attachCdpForAgent"]>>;
type RelayEvent = Parameters<Parameters<BrowserService["attachCdpForAgent"]>[1]>[0];
interface Target extends BrowserUseTarget {
  relay: Relay;
  port: BrowserUsePort<Target>;
  closed: boolean;
  listen?: (event: RelayEvent) => void;
  onEnd?: () => void;
}

const resumed = z.object({ targetId: z.string(), dialog: browserTargetSchema.shape.dialog });
const attached = z.object({ sessionId: z.string(), dialog: browserTargetSchema.shape.dialog });
const eventBudget = {
  maxBytes: browserReplLimits.eventBytes - 4096,
  maxDepth: browserReplLimits.depth - 4,
  maxEntries: browserReplLimits.jsonEntries,
};
const tooLarge = () =>
  refused(
    "resource_exhausted",
    "Browser result exceeds its byte or nesting limit. Narrow the query.",
  );
const ended = () =>
  refused(
    "conflict",
    "The browser page attachment has ended.",
    "Use pages() and openPage(tabId) to bind an available tab.",
  );

function checkReply(value: unknown, budget: BrowserUseBudget): void {
  if (boundedJsonSize(value, budget) === undefined) throw tooLarge();
}

function translate(error: unknown): never {
  if (error instanceof BrowserCdpConnectionEnded) throw ended();
  if (error instanceof OpensteerError && error.reason === "browser-reply-limit") throw tooLarge();
  throw error;
}

export function createBrowserUsePort({
  authority,
  tabs,
  browser,
}: {
  authority: CdpAuthority;
  tabs: BrowserUseTabAccess;
  browser: Pick<BrowserService, "attachCdpForAgent">;
}): BrowserUsePort<Target> {
  async function bind({ binding, threadId }: AdmittedPage, call: BrowserUseCall): Promise<Target> {
    call.signal.throwIfAborted();
    if (binding.backend !== "cdp")
      throw refused("conflict", "This tab cannot run browser scripts.");
    let target: Target | undefined;
    let root: string | undefined;
    const detached = new Set<string>();
    let closed = false;
    const stop = () => {
      closed = true;
      if (!target) return;
      target.closed = true;
      const notify = target.onEnd;
      delete target.listen;
      delete target.onEnd;
      notify?.();
    };
    let relay: Relay | undefined;
    let closing = false;
    const close = () => {
      if (!relay || closing) return;
      closing = true;
      relay.close();
    };
    try {
      relay = await browser.attachCdpForAgent(
        {
          ...authority,
          sessionId: binding.sessionId,
          scriptTabId: binding.tabId,
          scriptThreadId: threadId,
        },
        (event) => {
          if (closed) return;
          const destroyed = event.method === "Target.targetDestroyed" && event.parameters.targetId;
          const endedSession =
            event.method === "Target.detachedFromTarget" && event.parameters.sessionId;
          if ((root && destroyed === root) || (target && endedSession === target.sessionId)) {
            stop();
            close();
            return;
          }
          if (!target) {
            const id = destroyed || endedSession;
            if (typeof id === "string") {
              if (detached.size >= 32) stop();
              else detached.add(id);
            }
            return;
          }
          target.listen?.(event);
        },
        stop,
      );
      const pageReply = await (
        await relay.dispatch(
          { method: browserHostMethods.resumeTab, parameters: { surfaceId: binding.tabId } },
          { ...call, eventBudget },
        )
      ).result;
      checkReply(pageReply, call);
      const page = resumed.parse(pageReply);
      root = page.targetId;
      if (closed || detached.has(root)) throw ended();
      const channelReply = await (
        await relay.dispatch(
          {
            method: "Target.attachToTarget",
            parameters: { targetId: page.targetId, flatten: true },
          },
          call,
        )
      ).result;
      checkReply(channelReply, call);
      const channel = attached.parse(channelReply);
      if (closed || detached.has(channel.sessionId)) throw ended();
      const fields = browserTargetSchema.parse({ ...page, ...channel, tabId: binding.tabId });
      checkReply({ ...fields, handle: "0000000000000000" }, call);
      target = { ...fields, relay, port, closed };
      call.signal.throwIfAborted();
      return target;
    } catch (error) {
      close();
      translate(error);
    }
  }
  const port: BrowserUsePort<Target> = {
    async listPages(call) {
      const pages: BrowserUsePage[] = [];
      let bytes = call.maxBytes - 2;
      let entries = call.maxEntries - 1;
      if (call.maxDepth < 1 || bytes < 0 || entries < 0) throw tooLarge();
      for await (const page of tabs.pages(call)) {
        call.signal.throwIfAborted();
        const separator = Number(pages.length > 0);
        const size = boundedJsonSize(page, {
          maxDepth: call.maxDepth - 1,
          maxBytes: bytes - separator,
          maxEntries: entries,
        });
        if (size === undefined) throw tooLarge();
        bytes -= size + separator;
        entries -= 9;
        pages.push(page);
      }
      return pages;
    },
    async openPage(tabId, call) {
      if (!TabIdSchema.safeParse(tabId).success) throw refused("not_found", "Tab not found.");
      call.signal.throwIfAborted();
      try {
        return await bind(await tabs.bind(tabId, call.signal), call);
      } catch (error) {
        translate(error);
      }
    },
    async newPage(input, call) {
      call.signal.throwIfAborted();
      try {
        return await bind(await tabs.open(input, randomUUID(), call.signal), call);
      } catch (error) {
        translate(error);
      }
    },
    async command(target, method, params, sessionId, call) {
      call.signal.throwIfAborted();
      if (target.closed) throw ended();
      const parsed = BrowserCdpCommandSchema.safeParse({
        method,
        ...(params === undefined ? {} : { parameters: params }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (!parsed.success) throw refused("bad_request", "Invalid CDP command.");
      if ((method === "Opensteer.fillLogin" || method === "Opensteer.fillCard") &&
        !authority.agentBindingId.startsWith("session:"))
        throw refused(
          "forbidden",
          "Saved-login and card fills require their own approved Request.",
        );
      if (Object.values(browserHostMethods).some((reserved) => reserved === method))
        throw refused("forbidden", "Use pages(), openPage(tabId) or newPage(url) to manage tabs.");
      if (method === "Page.captureScreenshot" && sessionId === undefined)
        throw refused("bad_request", "Capture a screenshot on an attached page.");
      try {
        const budget =
          method === "Page.captureScreenshot"
            ? {
                ...call,
                maxImageBytes: Math.min(
                  call.maxImageBytes ?? browserScriptScreenshotMaxBytes,
                  Math.floor((call.maxBytes - 1024) / 4) * 3,
                ),
              }
            : call;
        if (budget.maxImageBytes !== undefined && budget.maxImageBytes < 1) throw tooLarge();
        const { result } = await target.relay.dispatch(parsed.data, budget);
        const value = await result;
        checkReply(value, call);
        return JSON.stringify(value);
      } catch (error) {
        if (
          method === "Page.captureScreenshot" &&
          error instanceof OpensteerError &&
          error.reason === "browser-reply-limit"
        )
          throw refused(
            "resource_exhausted",
            "Screenshot exceeds its image budget (up to 323 KiB per capture). Use a smaller viewport clip or JPEG via CDP.",
          );
        translate(error);
      }
    },
    release(target) {
      delete target.listen;
      delete target.onEnd;
      target.closed = true;
      target.relay.close();
    },
    subscribe(target, onEvent, onEnd, budget) {
      if (target.closed) {
        onEnd();
        return () => undefined;
      }
      target.onEnd = onEnd;
      target.listen = ({ method, parameters, sessionId }) => {
        if (
          boundedJsonSize({ method, parameters, ...(sessionId ? { sessionId } : {}) }, budget) ===
          undefined
        )
          return;
        onEvent({
          method,
          paramsJson: JSON.stringify(parameters),
          ...(sessionId ? { sessionId } : {}),
        });
      };
      return () => port.release?.(target);
    },
  };
  return port;
}
