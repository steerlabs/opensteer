import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createCredentialResponseRedactor } from "@opensteer/access/host";
import type { RequestCancellationReason, RunId } from "@opensteer/core";
import type { CallableIntegrationTool } from "@opensteer/database";
import type { ToolCaller } from "../agents/tool-caller.js";

const toolTimeoutMs = 60_000;
export const serverInputTimeoutMs = 180_000;
type FormParams = Exclude<ElicitRequest["params"], { mode: "url" }>;

export class InputCall {
  readonly computerName: string;
  readonly callable: CallableIntegrationTool;
  readonly caller: ToolCaller;
  readonly #cancel = new AbortController();
  readonly #startedAt = Date.now();
  #secrets: string[];
  #timer: ReturnType<typeof setTimeout>;
  readonly pending = new Set<Promise<ElicitResult>>();
  readonly signal: AbortSignal;
  timedOut = false;
  cancellationReason: RequestCancellationReason = "source-closed";

  constructor(
    callable: CallableIntegrationTool,
    caller: ToolCaller,
    signal?: AbortSignal,
    secrets: string[] = [],
    computerName = "its computer",
  ) {
    this.computerName = computerName;
    this.#secrets = secrets;
    this.callable = callable;
    this.caller = caller;
    this.signal = signal ? AbortSignal.any([signal, this.#cancel.signal]) : this.#cancel.signal;
    this.#timer = setTimeout(() => this.#expire(), toolTimeoutMs);
    this.#timer.unref();
  }

  extend(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => this.#expire(),
      Math.max(0, this.#startedAt + serverInputTimeoutMs - Date.now()),
    );
    this.#timer.unref();
  }

  detach(): void {
    this.#secrets = [...this.#secrets];
  }

  remember(values: readonly string[]): void {
    this.#secrets.push(...values);
  }
  redactor() {
    return createCredentialResponseRedactor(this.#secrets);
  }

  abort(reason: RequestCancellationReason = "source-closed"): void {
    this.cancellationReason = reason;
    this.#cancel.abort();
  }

  #expire(): void {
    this.timedOut = true;
    this.abort();
  }

  async close(): Promise<void> {
    clearTimeout(this.#timer);
    this.abort(this.cancellationReason);
    await Promise.all(this.pending);
    this.#secrets = [];
  }
}

/**
 * A local server's questions during a tool call, asked of the person through the plugin execution
 * that called it. Pairing answers live only as long as the upstream client that received them.
 */
export class ServerInput {
  readonly #secrets = new WeakMap<Client, string[]>();
  readonly #calls = new Map<Client, Set<InputCall>>();
  readonly #turns = new Map<Client, Promise<void>>();

  register(client: Client): void {
    this.#secrets.set(client, []);
    // The client declares form mode only, so the SDK refuses URL-mode requests itself.
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
      const params = request.params;
      if (params.mode === "url" || params.task)
        return decline("Only flat form input during a tool call is supported.");
      const calls = this.#calls.get(client);
      // MCP elicitation names no tool call, so calls on one session take turns (see `turn`) and
      // a question belongs to the single call in flight.
      const call = calls?.size === 1 ? calls.values().next().value : undefined;
      if (!call?.caller.elicit || call.signal.aborted)
        return decline("Device input requires a single active call from a plugin execution.");
      const pending = this.#forward(call, params, extra.signal);
      call.pending.add(pending);
      void pending.finally(() => call.pending.delete(pending)).catch(() => undefined);
      return pending;
    });
  }

  /**
   * Wait for this session's earlier calls, so a server's question always has one call to belong
   * to. Returns the release; an abandoned wait releases at once.
   */
  async turn(client: Client, signal?: AbortSignal): Promise<() => void> {
    const previous = this.#turns.get(client) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const next = previous.then(() => promise);
    this.#turns.set(client, next);
    void next.then(() => {
      if (this.#turns.get(client) === next) this.#turns.delete(client);
    });
    if (signal) {
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Call cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      aborted.catch(() => undefined);
      try {
        await Promise.race([previous, aborted]);
      } catch (error) {
        resolve();
        throw error;
      }
    } else await previous;
    return resolve;
  }

  /** The person answers in Needs you through the calling plugin execution; the answer goes only to this call. */
  async #forward(call: InputCall, params: FormParams, signal: AbortSignal): Promise<ElicitResult> {
    call.extend();
    try {
      const answer = await call.caller.elicit!(
        JSON.parse(
          JSON.stringify({
            mode: "form",
            message: call.redactor().redactText(params.message),
            requestedSchema: {
              ...params.requestedSchema,
              // Choice values and constraints must still match the server's validator.
              properties: Object.fromEntries(
                Object.entries(params.requestedSchema.properties).map(([name, property]) => [
                  name,
                  {
                    ...property,
                    ...(property.title === undefined
                      ? {}
                      : { title: call.redactor().redactText(property.title) }),
                    ...(property.description === undefined
                      ? {}
                      : { description: call.redactor().redactText(property.description) }),
                  },
                ]),
              ),
            },
          }),
        ),
        AbortSignal.any([call.signal, signal]),
      );
      if (answer.action === "accept" && answer.content)
        call.remember(Object.values(answer.content).map(String));
      return answer.action === "accept"
        ? { action: "accept", content: (answer.content ?? {}) as ElicitResult["content"] }
        : { action: answer.action };
    } catch {
      return { action: "cancel" };
    }
  }

  start(
    client: Client,
    callable: CallableIntegrationTool,
    caller: ToolCaller,
    signal?: AbortSignal,
    computerName?: string,
  ): InputCall {
    const call = new InputCall(callable, caller, signal, this.#secrets.get(client), computerName);
    const calls = this.#calls.get(client) ?? new Set<InputCall>();
    calls.add(call);
    this.#calls.set(client, calls);
    return call;
  }

  forget(client: Client): void {
    const secrets = this.#secrets.get(client);
    for (const call of this.#calls.get(client) ?? []) call.detach();
    if (secrets) secrets.length = 0;
    this.#secrets.delete(client);
  }

  async finish(client: Client, call: InputCall): Promise<void> {
    const calls = this.#calls.get(client);
    calls?.delete(call);
    if (calls?.size === 0) this.#calls.delete(client);
    await call.close();
  }

  endRun(runId: RunId, generation?: number): void {
    for (const calls of this.#calls.values())
      for (const call of calls) {
        if (
          call.caller.run?.runId === runId &&
          (generation === undefined || call.caller.run.bindingGeneration === generation)
        )
          call.abort("run-ended");
      }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#calls.values()].flatMap((calls) => [...calls].map((call) => call.close())),
    );
  }
}

function decline(reason: string): ElicitResult {
  return { action: "decline", _meta: { "opensteer/reason": reason } };
}
