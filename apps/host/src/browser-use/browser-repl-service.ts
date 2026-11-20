import { z } from "zod";
import type { Clock } from "@opensteer/shared/clock";
import {
  ReplService,
  type ComputerReplContext,
  type ReplResult,
  type ReplInvocation,
} from "../computer-use/computer-repl/computer-repl-service.js";
import {
  computerReplLimits as limits,
  ReplReplySchema,
  type ReplReply,
} from "../computer-use/computer-repl/messages.js";
import {
  BrowserReplRequestSchema,
  browserImageSchema,
  browserPageSchema,
  browserReplLimits,
  browserTargetSchema,
  type BrowserReplRequest,
} from "./browser-repl-messages.js";

export type BrowserUsePage = z.infer<typeof browserPageSchema>;
export type BrowserUseTarget = z.infer<typeof browserTargetSchema>;
export interface BrowserUseEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}
export interface BrowserUseCall {
  readonly contextKey: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
}
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
  ): Promise<unknown>;
  subscribe(target: Target, onEvent: (event: BrowserUseEvent) => void): () => void;
}

type BrowserContext<Target> = {
  nextHandle: number;
  opening: number;
  targets: Map<string, { target: Target; unsubscribe: () => void }>;
  events: { encoded: string; bytes: number; dialog: boolean }[];
  eventBytes: number;
  unacknowledged: string | undefined;
};
type BrowserInvocation = ReplInvocation<BrowserReplRequest>;

function bridgeValue(value: unknown): ReplReply["value"] {
  const encoded = JSON.stringify(value ?? null);
  if (!encoded || Buffer.byteLength(encoded) > limits.bridgeBytes)
    throw Object.assign(new Error("Browser result exceeds 1 MiB. Narrow the query."), {
      code: "bridge-limit",
    });
  return ReplReplySchema.shape.value.parse(JSON.parse(encoded));
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

const screenshotResult = z.object({ data: z.string(), cropped: z.json().optional() });

export class BrowserReplService<Target extends BrowserUseTarget = BrowserUseTarget> {
  readonly #port: BrowserUsePort<Target>;
  readonly #repl: ReplService<BrowserReplRequest>;
  readonly #contexts = new Map<string, BrowserContext<Target>>();

  constructor({ port, clock }: { port: BrowserUsePort<Target>; clock?: Clock }) {
    this.#port = port;
    this.#repl = new ReplService({
      request: BrowserReplRequestSchema,
      invoke: (request) => this.#invoke(request),
      ...(clock ? { clock } : {}),
      browser: {
        batch: ({ runId }) => this.#batch(runId),
        acknowledge: ({ runId }) => {
          const state = this.#contexts.get(runId);
          if (state) state.unacknowledged = undefined;
        },
        dispose: ({ runId }) => this.#dispose(runId),
      },
    });
  }

  execute(contextKey: string, code: string, signal?: AbortSignal): Promise<ReplResult> {
    return this.#repl.execute({ runId: contextKey, generation: 0 }, code, signal);
  }

  disposeContext(contextKey: string): void {
    this.#repl.resetGeneration(contextKey, 0);
  }

  close(): Promise<void> {
    return this.#repl.close();
  }

  #dispose(key: string): void {
    const context = this.#contexts.get(key);
    if (!context) return;
    this.#contexts.delete(key);
    for (const { unsubscribe } of context.targets.values()) {
      try {
        unsubscribe();
      } catch {
        // A closed port cannot keep the context resident.
      }
    }
  }

  #batch(key: string): string | undefined {
    const context = this.#contexts.get(key);
    if (!context) return undefined;
    if (context.unacknowledged !== undefined) return context.unacknowledged;
    if (!context.events.length) return undefined;
    context.unacknowledged = `[${context.events.map(({ encoded }) => encoded).join(",")}]`;
    context.events.length = 0;
    context.eventBytes = 0;
    return context.unacknowledged;
  }

  #event(
    context: ComputerReplContext,
    state: BrowserContext<Target>,
    handle: string,
    event: BrowserUseEvent,
  ) {
    if (this.#contexts.get(context.runId) !== state) return;
    let encoded: string;
    let bytes: number;
    try {
      const body = { handle, event };
      bytes = Buffer.byteLength(JSON.stringify(body));
      if (bytes > browserReplLimits.eventBytes) return;
      encoded = JSON.stringify({ ...body, bytes });
      bytes = Buffer.byteLength(encoded) + 1;
    } catch {
      return;
    }
    const dialog =
      event.method === "Page.javascriptDialogOpening" ||
      event.method === "Page.javascriptDialogClosed";
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

  async #open(
    request: Extract<BrowserInvocation, { operation: "browser.open" | "browser.new" }>,
  ): Promise<ReplReply> {
    const key = request.context.runId;
    let state = this.#contexts.get(key);
    if (!state) {
      state = {
        nextHandle: 0,
        opening: 0,
        targets: new Map(),
        events: [],
        eventBytes: 0,
        unacknowledged: undefined,
      };
      this.#contexts.set(key, state);
    }
    if (state.targets.size + state.opening >= browserReplLimits.handles)
      throw new Error("At most 16 page handles may be opened in a browser context.");
    state.opening++;
    try {
      const { signal, deadline } = request;
      const call = { contextKey: request.context.runId, signal, deadline };
      const target = await untilAborted(
        request.operation === "browser.open"
          ? this.#port.openPage(request.args.tabId, call)
          : this.#port.newPage(
              {
                url: request.args.url,
                ...(request.args.profileId === undefined
                  ? {}
                  : { profileId: request.args.profileId }),
              },
              call,
            ),
        signal,
      );
      signal.throwIfAborted();
      const handle = String(++state.nextHandle);
      const value = bridgeValue({ ...browserTargetSchema.parse(target), handle });
      const { context } = request;
      const bindingState = state;
      const unsubscribe = this.#port.subscribe(target, (event) =>
        this.#event(context, bindingState, handle, event),
      );
      state.targets.set(handle, { target, unsubscribe });
      return { value };
    } finally {
      state.opening--;
    }
  }

  async #invoke(request: BrowserInvocation): Promise<ReplReply> {
    const { signal, deadline } = request;
    signal.throwIfAborted();
    const call = { contextKey: request.context.runId, signal, deadline };
    switch (request.operation) {
      case "browser.pages": {
        const pages = await untilAborted(this.#port.listPages(call), signal);
        return { value: z.array(browserPageSchema).parse(bridgeValue(pages)) };
      }
      case "browser.open":
      case "browser.new":
        return this.#open(request);
      case "browser.command": {
        const binding = this.#contexts.get(request.context.runId)?.targets.get(request.target);
        if (!binding)
          throw new Error("This page handle has ended. Bind the tab again with openPage(tabId).");
        const { method, params, sessionId, screenshot } = request.args;
        const result = await untilAborted(
          this.#port.command(binding.target, method, params, sessionId, call),
          signal,
        );
        if (screenshot && method === "Page.captureScreenshot") {
          const { data, cropped } = screenshotResult.parse(result);
          if (Buffer.byteLength(data, "base64") > limits.imageBytes)
            throw Object.assign(
              new Error("Screenshot exceeds 4 MiB. Capture a smaller region with CDP."),
              { code: "output-limit" },
            );
          const image = browserImageSchema.parse({ data, mimeType: "image/png" });
          return {
            value: { mimeType: image.mimeType, ...(cropped === undefined ? {} : { cropped }) },
            content: [{ type: "image", ...image }],
          };
        }
        return { value: bridgeValue(result) };
      }
      case "browser.image":
        return { value: null, content: [{ type: "image", ...request.args }] };
      case "browser.url": {
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
        } = new URL(request.args.href);
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
            query: searchParams.toString(),
            entries: [...searchParams],
          },
        };
      }
    }
  }
}
