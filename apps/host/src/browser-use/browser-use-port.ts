import { randomUUID } from "node:crypto";
import { answerTooLargeMessage, boundedJsonSize } from "@opensteer/browser-runtime-core";
import { OpensteerError, refused, TabIdSchema, type ThreadId } from "@opensteer/core";
import {
  BrowserCdpCommandSchema,
  browserScriptScreenshotMaxBytes,
  browserHostMethods,
  type PageAgentBinding,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  OperationOutcomeUnknown,
  type PooledBrowserSend,
} from "../agent-sessions/agent-session-service.js";
import { BrowserCdpConnectionEnded, type BrowserService } from "../browser/browser-service.js";
import type { CdpAuthority } from "../browser/standard-cdp-tickets.js";
import { browserReplLimits, browserTargetSchema } from "./browser-repl-messages.js";
import {
  BrowserUseCdpError,
  type BrowserUseBudget,
  type BrowserUseCall,
  type BrowserUsePage,
  type BrowserUsePort,
  type BrowserUseTarget,
} from "./browser-repl-service.js";

interface AdmittedPage {
  binding: PageAgentBinding;
  threadId: ThreadId;
}

export interface BrowserUseTabAccess {
  pages(call: BrowserUseCall): AsyncIterable<BrowserUsePage>;
  bind(tabId: string, signal: AbortSignal, browserSend?: PooledBrowserSend): Promise<AdmittedPage>;
  open(
    input: { url: string; profileId?: string },
    key: string,
    signal: AbortSignal,
    browserSend?: PooledBrowserSend,
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
const endedAfterSubmit = () =>
  new OperationOutcomeUnknown(
    "The browser page attachment ended after a command was sent. Check the page before trying again.",
  );

function logAttachmentEnded(detail: {
  readonly tabId?: string;
  readonly sessionId?: string;
  readonly method?: string;
  readonly reason: string;
  readonly afterSubmit?: boolean;
}): void {
  console.warn("browser.use.attachment.ended", JSON.stringify(detail));
}

/** A7: the answer arrived over its limit, so the command ran: a failure naming its size. */
function checkReply(value: unknown, budget: BrowserUseBudget, method?: string): void {
  if (boundedJsonSize(value, budget) === undefined)
    throw refused(
      "resource_exhausted",
      answerTooLargeMessage(value, budget.maxBytes, budget, method),
    );
}

function translate(
  error: unknown,
  context?: {
    readonly tabId?: string;
    readonly sessionId?: string;
    readonly method?: string;
    readonly browserSend?: PooledBrowserSend;
    readonly onEnded?: () => void;
  },
): never {
  if (error instanceof BrowserCdpConnectionEnded) {
    const afterSubmit = context?.browserSend?.hasSubmitted?.() === true;
    logAttachmentEnded({
      ...(context?.tabId ? { tabId: context.tabId } : {}),
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context?.method ? { method: context.method } : {}),
      reason: error.message || "BrowserCdpConnectionEnded",
      ...(afterSubmit ? { afterSubmit } : {}),
    });
    context?.onEnded?.();
    throw afterSubmit ? endedAfterSubmit() : ended();
  }
  // A7: the browser's answer arrived over its limit: the command ran, and it fails with the
  // runtime's words (its size, the limit, what to ask for instead).
  if (error instanceof OpensteerError && error.reason === "browser-reply-limit")
    throw refused("resource_exhausted", error.message);
  if (error instanceof OpensteerError && error.reason === "browser-cdp-protocol-error")
    throw new BrowserUseCdpError(-32000, error.message);
  throw error;
}

export function createBrowserUsePort({
  authority,
  tabs,
  browser,
}: {
  authority: CdpAuthority;
  tabs: BrowserUseTabAccess;
  browser: Pick<BrowserService, "attachCdpForAgent"> &
    Partial<Pick<BrowserService, "pooledScriptPageWitness">>;
}): BrowserUsePort<Target> {
  async function bind(
    { binding, threadId }: AdmittedPage,
    call: BrowserUseCall,
    expectedPooledWitness?: string,
  ): Promise<Target> {
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
          ...(call.browserSend ? { browserSend: call.browserSend } : {}),
          ...(expectedPooledWitness ? { expectedPooledWitness } : {}),
        },
        (event) => {
          if (closed) return;
          const destroyed = event.method === "Target.targetDestroyed" && event.parameters.targetId;
          const endedSession =
            event.method === "Target.detachedFromTarget" && event.parameters.sessionId;
          if ((root && destroyed === root) || (target && endedSession === target.sessionId)) {
            logAttachmentEnded({
              tabId: binding.tabId,
              sessionId: binding.sessionId,
              reason: destroyed ? "Target.targetDestroyed" : "Target.detachedFromTarget",
            });
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
      if (closed || detached.has(root))
        throw call.browserSend?.hasSubmitted?.() ? endedAfterSubmit() : ended();
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
      if (closed || detached.has(channel.sessionId))
        throw call.browserSend?.hasSubmitted?.() ? endedAfterSubmit() : ended();
      const fields = browserTargetSchema.parse({ ...page, ...channel, tabId: binding.tabId });
      checkReply({ ...fields, handle: "0000000000000000" }, call);
      const attachedRelay = relay;
      const initialWitness = attachedRelay.pooledWitness;
      const bound: Target =
        initialWitness !== undefined
          ? {
              ...fields,
              relay: attachedRelay,
              port,
              closed,
              get pooledWitness(): string {
                return attachedRelay.pooledWitness ?? initialWitness;
              },
            }
          : {
              ...fields,
              relay: attachedRelay,
              port,
              closed,
            };
      target = bound;
      call.signal.throwIfAborted();
      return bound;
    } catch (error) {
      close();
      translate(error, {
        tabId: binding.tabId,
        sessionId: binding.sessionId,
        ...(call.browserSend ? { browserSend: call.browserSend } : {}),
      });
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
        const args = call.browserSend ? ([call.browserSend] as const) : ([] as const);
        return await bind(await tabs.bind(tabId, call.signal, ...args), call);
      } catch (error) {
        translate(error, {
          tabId,
          ...(call.browserSend ? { browserSend: call.browserSend } : {}),
        });
      }
    },
    async newPage(input, call) {
      call.signal.throwIfAborted();
      try {
        const args = call.browserSend ? ([call.browserSend] as const) : ([] as const);
        return await bind(await tabs.open(input, randomUUID(), call.signal, ...args), call);
      } catch (error) {
        translate(error, call.browserSend ? { browserSend: call.browserSend } : undefined);
      }
    },
    async rebind(previous, call) {
      const { pooledWitness, relay } = previous;
      const tabId = TabIdSchema.parse(previous.tabId);
      const afterSubmit = call.browserSend?.hasSubmitted?.() === true;
      if (
        !call.browserSend ||
        !pooledWitness ||
        (await browser.pooledScriptPageWitness?.(authority.ownerId, relay.session.id, tabId)) !==
          pooledWitness
      ) {
        logAttachmentEnded({
          tabId,
          sessionId: relay.session.id,
          reason: "rebind-witness-mismatch",
          ...(afterSubmit ? { afterSubmit } : {}),
        });
        throw afterSubmit ? endedAfterSubmit() : ended();
      }
      try {
        const admitted = await tabs.bind(tabId, call.signal, call.browserSend);
        if (admitted.binding.sessionId !== relay.session.id || admitted.binding.reloaded) {
          logAttachmentEnded({
            tabId,
            sessionId: relay.session.id,
            reason: admitted.binding.reloaded ? "rebind-reloaded" : "rebind-session-changed",
            ...(afterSubmit ? { afterSubmit } : {}),
          });
          throw afterSubmit ? endedAfterSubmit() : ended();
        }
        return await bind(admitted, call, pooledWitness);
      } catch (error) {
        translate(error, {
          tabId,
          sessionId: relay.session.id,
          ...(call.browserSend ? { browserSend: call.browserSend } : {}),
        });
      }
    },
    async command(target, method, params, sessionId, call) {
      call.signal.throwIfAborted();
      if (target.closed) {
        const afterSubmit = call.browserSend?.hasSubmitted?.() === true;
        logAttachmentEnded({
          tabId: target.tabId,
          sessionId: target.relay.session.id,
          method,
          reason: "target-closed",
          ...(afterSubmit ? { afterSubmit } : {}),
        });
        throw afterSubmit ? endedAfterSubmit() : ended();
      }
      const parsed = BrowserCdpCommandSchema.safeParse({
        method,
        ...(params === undefined ? {} : { parameters: params }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      if (!parsed.success) throw refused("bad_request", "Invalid CDP command.");
      if (
        (method === "Opensteer.fillLogin" || method === "Opensteer.fillCard") &&
        !authority.agentBindingId.startsWith("session:")
      )
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
        checkReply(value, call, method);
        return JSON.stringify(value);
      } catch (error) {
        if (method === "Page.captureScreenshot" && error instanceof OpensteerError) {
          if (error.reason === "browser-screenshot-limit")
            throw refused("resource_exhausted", error.message);
          if (error.reason === "browser-reply-limit")
            throw refused(
              "resource_exhausted",
              `Screenshot exceeded the ${Math.floor(call.maxBytes / 1024)} KiB reply limit. Use a smaller viewport clip or JPEG via CDP.`,
            );
        }
        translate(error, {
          tabId: target.tabId,
          sessionId: target.relay.session.id,
          method,
          ...(call.browserSend ? { browserSend: call.browserSend } : {}),
          onEnded: () => {
            target.closed = true;
            const notify = target.onEnd;
            delete target.listen;
            delete target.onEnd;
            notify?.();
            target.relay.close();
          },
        });
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
