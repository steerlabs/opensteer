import { answerTooLargeWords } from "@opensteer/browser-runtime-core";
import { OpensteerError } from "@opensteer/core";
import { z } from "zod";
import type { Clock } from "@opensteer/shared/clock";
import {
  OperationOutcomeUnknown,
  type PooledBrowserSend,
} from "../agent-sessions/agent-session-service.js";
import {
  ReplService,
  type ComputerReplContext,
  type ReplResult,
  type ReplInvocation,
} from "../computer-use/computer-repl/computer-repl-service.js";
import {
  computerReplLimits as limits,
  ReplReplySchema,
  type ReplFailure,
  type ReplReply,
} from "../computer-use/computer-repl/messages.js";
import {
  BrowserReplRequestSchema,
  browserImageSchema,
  browserJsonShapeFits,
  browserPageSchema,
  browserReplLimits,
  browserTargetSchema,
  decodedBase64Bytes,
  type BrowserReplRequest,
} from "./browser-repl-messages.js";

export type BrowserUsePage = z.infer<typeof browserPageSchema>;
export type BrowserUseTarget = z.infer<typeof browserTargetSchema> & {
  readonly pooledWitness?: string;
};
export interface BrowserUseEvent {
  readonly method: string;
  readonly paramsJson: string;
  readonly sessionId?: string;
}
export interface BrowserUseBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxImageBytes?: number;
}
export interface BrowserUseCall extends BrowserUseBudget {
  readonly contextKey: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly browserSend?: PooledBrowserSend;
}

export class BrowserUseCdpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

class BrowserBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Share the producer's ingress byte, depth and structural entry limits with the REPL. Enforce
 * them before decoding a frame, accumulating a list, or serializing a reply or event.
 * Metadata fields are bounded by the same budget. Commands return JSON (use "null" for no value).
 * On abort, stop work that has not been dispatched. Settle only when the operation has finished
 * or cancellation is confirmed. Rejecting an abort race while the underlying operation runs
 * does not acknowledge cancellation. onEnd reports closure or detachment of the bound target.
 * Only explicit Opensteer refusals and BrowserUseCdpError messages are public.
 * A port must recheck access before each command, including commands on a cached binding.
 */
export interface BrowserUsePort<Target extends BrowserUseTarget = BrowserUseTarget> {
  listPages(call: BrowserUseCall): Promise<readonly BrowserUsePage[]>;
  openPage(tabId: string, call: BrowserUseCall): Promise<Target>;
  newPage(input: { url: string; profileId?: string }, call: BrowserUseCall): Promise<Target>;
  command(
    target: Target,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    call: BrowserUseCall,
  ): Promise<string>;
  release?(target: Target): void;
  rebind?(previous: Target, call: BrowserUseCall): Promise<Target>;
  subscribe(
    target: Target,
    onEvent: (event: BrowserUseEvent) => void,
    onEnd: () => void,
    budget: BrowserUseBudget,
  ): () => void;
}

type Binding<Target> = {
  handle: string;
  target: Target;
  value: ReplReply["value"];
  unsubscribe?: () => void;
  detached?: true;
  reattaching?: Promise<Target>;
  originalTarget?: Target;
};
type BrowserContext<Target> = {
  nextHandle: number;
  opening: number;
  byTab: Map<string, Binding<Target>>;
  targets: Map<string, Binding<Target>>;
  opens: Map<string, Promise<ReplReply>>;
  events: { encoded: string; bytes: number; dialog: boolean }[];
  eventBytes: number;
  dirty: boolean;
  unacknowledged: string | undefined;
  eventTurnBytes: number;
  eventTurnCount: number;
};
type BrowserInvocation = ReplInvocation<BrowserReplRequest>;
const depth = browserReplLimits.depth;
const eventBudget = {
  maxBytes: browserReplLimits.eventBytes - 4096,
  maxDepth: depth - 4,
  maxEntries: browserReplLimits.jsonEntries,
};
const screenshotResult = z.object({ data: z.string(), cropped: z.json().optional() });
const screenshotTooLarge = () =>
  new BrowserBridgeError(
    "output-limit",
    "Screenshot exceeds its image budget (up to 323 KiB per capture). Use a smaller viewport clip or JPEG via CDP.",
  );
const replyTooLarge = () =>
  new BrowserBridgeError(
    "bridge-limit",
    "Browser result exceeds its byte or nesting limit. Narrow the query.",
  );

function publicFailure(error: unknown): ReplFailure {
  if (error instanceof OperationOutcomeUnknown)
    return { code: "outcome-unknown", message: error.message, performed: [] };
  // A7: lost contact, or a reply that did not come, leaves an effect unknown. An answer over the
  // browser's reply limit is not one of these: it arrived, so the command ran, and it is a failure
  // of that command with its size (the port's refusal, caught by the script like any other).
  if (
    error instanceof OpensteerError &&
    (error.reason === "outcome-unknown" || error.reason === "browser-tab-open-outcome-unknown")
  )
    return {
      code: "outcome-unknown",
      message:
        "A browser action did not confirm its outcome. Observe the page before trying again.",
      performed: [],
    };
  if (
    error instanceof BrowserBridgeError ||
    (error instanceof OpensteerError && error.code !== "internal")
  ) {
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof OpensteerError && error.next !== undefined ? { next: error.next } : {}),
      performed: [],
    };
  }
  if (error instanceof BrowserUseCdpError && Number.isSafeInteger(error.code))
    return { code: "cdp-error", cdpCode: error.code, message: error.message, performed: [] };
  console.error("browser.repl.port.failed", error);
  return { code: "failed", message: "Browser operation failed.", performed: [] };
}

function boundedBytes(text: string, limit: number): number | undefined {
  if (typeof text !== "string" || text.length > limit) return undefined;
  const bytes = Buffer.byteLength(text);
  return bytes <= limit ? bytes : undefined;
}

function checkMetadata(
  budget: BrowserUseBudget,
  strings: readonly string[],
  overhead: number,
): number {
  let remaining = budget.maxBytes - overhead;
  for (const text of strings) {
    if (typeof text !== "string" || text.length > remaining) throw replyTooLarge();
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 32) remaining -= 6;
      else if (code === 34 || code === 92) remaining -= 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff
      ) {
        index++;
        remaining -= 4;
      } else if (code >= 0xd800 && code <= 0xdfff) remaining -= 6;
      else remaining -= code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (remaining < 0) throw replyTooLarge();
    }
  }
  if (remaining < 0) throw replyTooLarge();
  return remaining;
}

export class BrowserReplService<Target extends BrowserUseTarget = BrowserUseTarget> {
  readonly #port: BrowserUsePort<Target>;
  readonly #repl: ReplService<BrowserReplRequest>;
  readonly #contexts = new Map<string, BrowserContext<Target>>();

  constructor({
    port,
    clock,
    workerEntry,
  }: {
    port: BrowserUsePort<Target>;
    clock?: Clock;
    workerEntry?: URL;
  }) {
    this.#port = port;
    this.#repl = new ReplService({
      request: BrowserReplRequestSchema,
      invoke: (request) => this.#invoke(request),
      ...(clock ? { clock } : {}),
      ...(workerEntry ? { workerEntry } : {}),
      browser: {
        batch: ({ runId }) => this.#batch(runId),
        acknowledge: ({ runId }) => {
          const state = this.#contexts.get(runId);
          if (state) state.unacknowledged = undefined;
        },
        dispose: ({ runId }) => this.#dispose(runId),
        error: publicFailure,
      },
    });
  }

  execute(
    contextKey: string,
    code: string,
    signal?: AbortSignal,
    bindingKey?: string,
    recheck?: () => Promise<void>,
    browserSend?: PooledBrowserSend,
  ): Promise<ReplResult> {
    return this.#repl.execute(
      { runId: contextKey, generation: 0 },
      code,
      signal,
      recheck || browserSend
        ? async (request) => {
            await recheck?.();
            return this.#invoke(request, browserSend);
          }
        : undefined,
      bindingKey,
    );
  }

  disposeContext(contextKey: string): void {
    this.#repl.resetGeneration(contextKey, 0);
  }

  close(): Promise<void> {
    return this.#repl.close();
  }

  #unsubscribe(binding: Binding<Target>): void {
    try {
      binding.unsubscribe?.();
    } catch (error) {
      console.error("browser.repl.unsubscribe.failed", error);
    }
  }

  #dispose(key: string): void {
    const context = this.#contexts.get(key);
    if (!context) return;
    this.#contexts.delete(key);
    for (const binding of context.targets.values()) this.#unsubscribe(binding);
  }

  #batch(key: string): string | undefined {
    const context = this.#contexts.get(key);
    if (!context) return undefined;
    if (context.unacknowledged !== undefined) return context.unacknowledged;
    if (!context.dirty && !context.events.length) return undefined;
    const live = JSON.stringify([...context.targets.keys()]);
    context.unacknowledged = `{"live":${live},"events":[${context.events.map(({ encoded, bytes }) => `[${bytes},${encoded}]`).join(",")}]}`;
    context.events.length = 0;
    context.eventBytes = 0;
    context.dirty = false;
    return context.unacknowledged;
  }

  #retire(
    context: ComputerReplContext,
    state: BrowserContext<Target>,
    binding: Binding<Target>,
  ): void {
    if (this.#contexts.get(context.runId) !== state || !state.targets.delete(binding.handle))
      return;
    state.byTab.delete(binding.target.tabId);
    this.#unsubscribe(binding);
    state.dirty = true;
    this.#repl.eventsAvailable(context);
  }

  #subscribe(
    context: ComputerReplContext,
    state: BrowserContext<Target>,
    binding: Binding<Target>,
  ) {
    const { target, handle } = binding;
    binding.unsubscribe = this.#port.subscribe(
      target,
      (event) => this.#event(context, state, handle, event),
      () => {
        if (target.pooledWitness && this.#port.rebind) {
          binding.detached = true;
          this.#unsubscribe(binding);
          delete binding.unsubscribe;
        } else this.#retire(context, state, binding);
      },
      eventBudget,
    );
    if (binding.detached || !state.targets.has(handle)) {
      this.#unsubscribe(binding);
      delete binding.unsubscribe;
    }
  }

  async #currentTarget(
    context: ComputerReplContext,
    state: BrowserContext<Target>,
    binding: Binding<Target>,
    call: BrowserUseCall,
  ): Promise<Target> {
    const { target } = binding;
    if (!binding.detached) return target;
    if (binding.reattaching) return binding.reattaching;
    const reattach = async () => {
      let replacement: Target | undefined;
      try {
        if (call.browserSend && target.pooledWitness)
          replacement = await this.#port.rebind?.(target, call);
        if (
          !replacement ||
          replacement.tabId !== target.tabId ||
          replacement.pooledWitness !== target.pooledWitness ||
          this.#contexts.get(context.runId) !== state
        )
          throw new BrowserBridgeError("page-ended", "This browser page handle is stale.");
        call.signal.throwIfAborted();
        binding.originalTarget ??= target;
        binding.target = replacement;
        delete binding.detached;
        this.#subscribe(context, state, binding);
        if (binding.detached)
          throw new BrowserBridgeError("page-ended", "This browser page handle is stale.");
        return replacement;
      } catch (error) {
        if (replacement) this.#port.release?.(replacement);
        this.#retire(context, state, binding);
        throw error;
      }
    };
    const reconnecting = reattach().finally(() => delete binding.reattaching);
    binding.reattaching = reconnecting;
    return reconnecting;
  }

  #event(
    context: ComputerReplContext,
    state: BrowserContext<Target>,
    handle: string,
    event: BrowserUseEvent,
  ): void {
    if (this.#contexts.get(context.runId) !== state || !state.targets.has(handle)) return;
    const dialog =
      event.method === "Page.javascriptDialogOpening" ||
      event.method === "Page.javascriptDialogClosed";
    if (!state.eventTurnCount)
      setImmediate(() => {
        state.eventTurnCount = 0;
        state.eventTurnBytes = 0;
      });
    if (
      state.eventTurnCount >= browserReplLimits.events + (dialog ? browserReplLimits.handles : 0) ||
      state.eventTurnBytes >= browserReplLimits.eventBytes * (dialog ? 2 : 1)
    )
      return;
    state.eventTurnCount++;
    if (
      typeof event.method !== "string" ||
      event.method.length > 256 ||
      (event.sessionId !== undefined &&
        (typeof event.sessionId !== "string" || event.sessionId.length > 256))
    )
      return;
    const rawBytes = boundedBytes(
      event.paramsJson,
      Math.min(
        eventBudget.maxBytes,
        browserReplLimits.eventBytes * (dialog ? 2 : 1) - state.eventTurnBytes,
      ),
    );
    if (rawBytes === undefined) return;
    state.eventTurnBytes += rawBytes;
    if (!browserJsonShapeFits(event.paramsJson, eventBudget.maxDepth)) return;
    const encoded = `[${JSON.stringify(handle)},${JSON.stringify(event.method)},${JSON.stringify(event.sessionId ?? null)},${event.paramsJson}]`;
    const bytes = Buffer.byteLength(encoded) + 12;
    if (bytes > browserReplLimits.eventBytes) return;
    state.events.push({ encoded, bytes, dialog });
    state.eventBytes += bytes;
    while (
      state.events.length > browserReplLimits.events ||
      state.eventBytes > browserReplLimits.eventBytes
    ) {
      const index = state.events.findIndex((item) => !item.dialog);
      const [removed] = state.events.splice(Math.max(0, index), 1);
      state.eventBytes -= removed!.bytes;
    }
    this.#repl.eventsAvailable(context);
  }

  #open(
    request: Extract<BrowserInvocation, { operation: "browser.open" | "browser.new" }>,
    call: BrowserUseCall,
  ): Promise<ReplReply> {
    const key = request.context.runId;
    let state = this.#contexts.get(key);
    if (!state) {
      state = {
        nextHandle: 0,
        opening: 0,
        byTab: new Map(),
        targets: new Map(),
        opens: new Map(),
        events: [],
        eventBytes: 0,
        dirty: false,
        unacknowledged: undefined,
        eventTurnBytes: 0,
        eventTurnCount: 0,
      };
      this.#contexts.set(key, state);
    }
    if (request.operation === "browser.new") return this.#bind(request, call, state);
    const { tabId } = request.args;
    const existing = state.byTab.get(tabId);
    if (existing) return Promise.resolve({ value: existing.value });
    const pending = state.opens.get(tabId);
    if (pending) return pending;
    const context = state;
    const opening = this.#bind(request, call, state).finally(() => {
      if (context.opens.get(tabId) === opening) context.opens.delete(tabId);
    });
    state.opens.set(tabId, opening);
    return opening;
  }

  async #bind(
    request: Extract<BrowserInvocation, { operation: "browser.open" | "browser.new" }>,
    call: BrowserUseCall,
    state: BrowserContext<Target>,
  ): Promise<ReplReply> {
    if (state.targets.size + state.opening >= browserReplLimits.handles)
      throw new BrowserBridgeError(
        "bridge-limit",
        "At most 16 page handles may be opened in a browser context.",
      );
    state.opening++;
    let unclaimed: Target | undefined;
    try {
      const target = (unclaimed = await (request.operation === "browser.open"
        ? this.#port.openPage(request.args.tabId, call)
        : this.#port.newPage(
            {
              url: request.args.url,
              ...(request.args.profileId === undefined
                ? {}
                : { profileId: request.args.profileId }),
            },
            call,
          )));
      call.signal.throwIfAborted();
      const { tabId, targetId, sessionId, dialog } = target;
      const metadataBytes = [
        tabId,
        targetId,
        sessionId,
        dialog?.id ?? "",
        dialog?.type ?? "",
        dialog?.message ?? "",
      ];
      checkMetadata(call, metadataBytes, 128);
      const existing = state.byTab.get(tabId);
      if (existing) return { value: existing.value };
      const handle = String(++state.nextHandle);
      const fields = browserTargetSchema.parse({ tabId, targetId, sessionId, dialog });
      const binding: Binding<Target> = {
        handle,
        target,
        value: {
          handle,
          tabId: fields.tabId,
          targetId: fields.targetId,
          sessionId: fields.sessionId,
          dialog: fields.dialog ?? null,
        },
      };
      state.targets.set(handle, binding);
      state.byTab.set(tabId, binding);
      try {
        this.#subscribe(request.context, state, binding);
      } catch (error) {
        this.#retire(request.context, state, binding);
        throw error;
      }
      if (!state.targets.has(handle) || binding.detached) {
        this.#retire(request.context, state, binding);
        throw new BrowserBridgeError(
          "page-ended",
          "This page handle has ended. Bind the tab again with openPage(tabId).",
        );
      }
      unclaimed = undefined;
      return { value: binding.value };
    } finally {
      if (unclaimed) this.#port.release?.(unclaimed);
      state.opening--;
    }
  }

  async #invoke(request: BrowserInvocation, browserSend?: PooledBrowserSend): Promise<ReplReply> {
    const { signal, deadline } = request;
    signal.throwIfAborted();
    const screenshot =
      request.operation === "browser.command" &&
      request.args.screenshot &&
      request.args.method === "Page.captureScreenshot";
    const call = {
      contextKey: request.context.runId,
      signal,
      deadline,
      maxDepth: depth - 1,
      maxEntries: browserReplLimits.jsonEntries,
      maxBytes: limits.bridgeBytes,
      ...request.replyBudget,
      ...(browserSend ? { browserSend } : {}),
    };
    switch (request.operation) {
      case "browser.pages": {
        const pages = await this.#port.listPages(call);
        signal.throwIfAborted();
        if (pages.length > browserReplLimits.events) throw replyTooLarge();
        checkMetadata(
          call,
          pages.flatMap(({ tabId, title, url, profile }) => [tabId, title, url, profile]),
          pages.length * 64,
        );
        return { value: z.array(browserPageSchema).parse(pages) };
      }
      case "browser.open":
      case "browser.new":
        return this.#open(request, call);
      case "browser.command": {
        const state = this.#contexts.get(request.context.runId);
        const binding = state?.targets.get(request.target);
        if (!state || !binding)
          throw new BrowserBridgeError(
            "page-ended",
            "This page handle has ended. Bind the tab again with openPage(tabId).",
          );
        const { method, params, sessionId } = request.args;
        const target = binding.detached
          ? await this.#currentTarget(request.context, state, binding, call)
          : binding.target;
        const original = binding.originalTarget;
        const encoded = await this.#port.command(
          target,
          method,
          original && params?.targetId === original.targetId
            ? { ...params, targetId: target.targetId }
            : params,
          original && sessionId === original.sessionId ? target.sessionId : sessionId,
          call,
        );
        signal.throwIfAborted();
        if (screenshot && typeof encoded === "string" && encoded.length > call.maxBytes)
          throw screenshotTooLarge();
        const bytes = boundedBytes(encoded, call.maxBytes);
        // A7: the answer arrived over its limit, so the command ran: it fails, naming its size.
        if (bytes === undefined || !browserJsonShapeFits(encoded, call.maxDepth))
          throw new BrowserBridgeError(
            "bridge-limit",
            answerTooLargeWords(
              bytes === undefined && typeof encoded === "string"
                ? Buffer.byteLength(encoded)
                : undefined,
              call.maxBytes,
            ),
          );
        const result: unknown = JSON.parse(encoded);
        if (screenshot) {
          const { data, cropped } = screenshotResult.parse(result);
          if (decodedBase64Bytes(data) > (call.maxImageBytes ?? browserReplLimits.screenshotBytes))
            throw screenshotTooLarge();
          if (cropped !== undefined && bytes - data.length > limits.bridgeBytes)
            throw replyTooLarge();
          const image = browserImageSchema.parse({ data, mimeType: "image/png" });
          return {
            value: { mimeType: image.mimeType, ...(cropped === undefined ? {} : { cropped }) },
            content: [{ type: "image", ...image }],
          };
        }
        return { value: ReplReplySchema.shape.value.parse(result) };
      }
      case "browser.image":
        return { value: null, content: [{ type: "image", ...request.args }] };
      case "browser.url": {
        if (request.args.href.length > limits.codeBytes) throw replyTooLarge();
        let url: URL;
        try {
          url = new URL(request.args.href);
        } catch {
          throw new BrowserBridgeError("invalid-url", "Invalid browser URL.");
        }
        const {
          href,
          origin,
          protocol,
          username,
          password,
          host,
          hostname,
          port,
          pathname,
          search,
          hash,
          searchParams,
        } = url;
        const entries: [string, string][] = [];
        for (const entry of searchParams) {
          if (entries.length >= 4096) throw replyTooLarge();
          entries.push(entry);
        }
        const remaining = checkMetadata(
          call,
          [
            href,
            origin,
            protocol,
            username,
            password,
            host,
            hostname,
            port,
            pathname,
            search,
            hash,
            ...entries.flat(),
          ],
          entries.length * 8 + 256,
        );
        if (search.length * 9 > remaining) throw replyTooLarge();
        const query = searchParams.toString();
        return {
          value: {
            href,
            origin,
            protocol,
            username,
            password,
            host,
            hostname,
            port,
            pathname,
            search,
            hash,
            query,
            entries,
          },
        };
      }
    }
  }
}
