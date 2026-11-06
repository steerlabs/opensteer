import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createCredentialResponseRedactor } from "@opensteer/access/host";
import {
  OpensteerError,
  RequestPresentationSchema,
  RequestResponseSchema,
  type AgentEvent,
  type RequestId,
  type RequestResponse,
  type RequestCancellationReason,
  type RunId,
  type UserId,
} from "@opensteer/core";
import type { CallableIntegrationTool, RequestStore } from "@opensteer/database";
import { validateJsonSchema } from "@opensteer/integration-adapters";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { ToolCaller } from "./integration-platform-service.js";

const toolTimeoutMs = 60_000;
export const integrationInputTimeoutMs = 180_000;
type FormParams = Exclude<ElicitRequest["params"], { mode: "url" }>;

interface InputWaiter {
  readonly call: InputCall;
  readonly schema: FormParams["requestedSchema"];
  readonly resolve: (result: ElicitResult) => void;
  responding: boolean;
}

export class InputCall {
  readonly callable: CallableIntegrationTool;
  readonly caller: ToolCaller;
  readonly #cancel = new AbortController();
  readonly #startedAt = Date.now();
  readonly #secrets: string[] = [];
  #timer: ReturnType<typeof setTimeout>;
  readonly pending = new Set<Promise<ElicitResult>>();
  readonly signal: AbortSignal;
  timedOut = false;
  cancellationReason: RequestCancellationReason = "source-closed";

  constructor(callable: CallableIntegrationTool, caller: ToolCaller, signal?: AbortSignal) {
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
      Math.max(0, this.#startedAt + integrationInputTimeoutMs - Date.now()),
    );
    this.#timer.unref();
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
    this.#secrets.length = 0;
  }
}

interface IntegrationInputOptions {
  readonly requests: Pick<
    RequestStore,
    "create" | "settleIntegrationInput" | "cancelIntegrationInputs"
  >;
  readonly longRequestHold: (run: RunCapabilityClaims<string>) => Promise<boolean>;
  readonly publish: (events: readonly AgentEvent[]) => void;
}

/** Pairing answers live only as long as the upstream call that asked for them. */
export class IntegrationInput {
  readonly #calls = new Map<Client, Set<InputCall>>();
  readonly #waiters = new Map<RequestId, InputWaiter>();
  readonly #options: IntegrationInputOptions;
  constructor(options: IntegrationInputOptions) {
    this.#options = options;
  }

  register(client: Client): void {
    // The client declares form mode only, so the SDK refuses URL-mode requests itself.
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
      const params = request.params;
      if (params.mode === "url" || params.task)
        return decline("Only flat form input during a tool call is supported.");
      const calls = this.#calls.get(client);
      const call = calls?.size === 1 ? calls.values().next().value : undefined;
      if (!call?.caller.run || call.signal.aborted)
        return decline("Device input requires a single active call from a Run.");
      const pending = this.#elicit(call, params, extra.signal);
      call.pending.add(pending);
      void pending.finally(() => call.pending.delete(pending)).catch(() => undefined);
      return pending;
    });
  }

  start(
    client: Client,
    callable: CallableIntegrationTool,
    caller: ToolCaller,
    signal?: AbortSignal,
  ): InputCall {
    const call = new InputCall(callable, caller, signal);
    const calls = this.#calls.get(client) ?? new Set<InputCall>();
    calls.add(call);
    this.#calls.set(client, calls);
    return call;
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

  observe(event: AgentEvent): void {
    if (event.type === "request.cancelled")
      this.#waiters.get(event.data.requestId)?.resolve({ action: "cancel" });
    if (event.type === "request.resolved" && event.data.request.status === "withdrawn")
      this.#waiters.get(event.data.request.id)?.resolve({ action: "cancel" });
  }

  async recover(): Promise<void> {
    this.#options.publish(await this.#options.requests.cancelIntegrationInputs("source-closed"));
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#calls.values()].flatMap((calls) => [...calls].map((call) => call.close())),
    );
  }

  async respond(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<void> {
    const waiter = this.#waiters.get(input.requestId);
    if (!waiter?.call.caller.run || waiter.responding || waiter.call.signal.aborted)
      throw new OpensteerError({ code: "conflict", message: "Device input is no longer waiting" });
    const response = RequestResponseSchema.parse(input.response);
    const result = inputResult(waiter.schema, response);
    waiter.responding = true;
    try {
      const settled = await this.#options.requests.settleIntegrationInput({
        caller: waiter.call.caller.run,
        requestId: input.requestId,
        resolvedBy: input.resolvedBy,
        ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
        action: result.action,
      });
      this.#options.publish(settled.events);
      if (result.action === "accept" && response.kind === "form") {
        waiter.call.remember(Object.values(response.answers).flat());
        waiter.call.remember(Object.values(result.content ?? {}).map(String));
      }
      waiter.resolve(waiter.call.signal.aborted ? { action: "cancel" } : result);
    } catch (error) {
      waiter.responding = false;
      throw error;
    }
  }

  async #elicit(call: InputCall, params: FormParams, signal: AbortSignal): Promise<ElicitResult> {
    const run = call.caller.run;
    if (!run || !(await this.#options.longRequestHold(run)))
      return decline(
        "This AI engine cannot wait for device input; use an engine that supports long Request holds.",
      );
    const presentation = inputPresentation(call.callable.installation.title, params);
    if (!presentation) return decline("This device input form is unsupported or too large.");
    const ended = AbortSignal.any([call.signal, signal]);
    if (ended.aborted) return { action: "cancel" };
    call.extend();
    let requestId: RequestId | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const opened = await this.#options.requests.create({
        callId: `integration-input:${randomUUID()}`,
        kind: "integration.input",
        mode: "durable",
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        originatingWorkspaceId: run.workspaceId,
        targetWorkspaceId: run.workspaceId,
        payload: {
          kind: "integration.input",
          installationId: call.callable.installation.id,
          serverId: call.callable.server.id,
        },
        presentation,
        requestedBy: run.requestedBy,
        requiredActor: "requester",
      });
      requestId = opened.request.id;
      let resolve!: (result: ElicitResult) => void;
      const answer = new Promise<ElicitResult>((done) => {
        resolve = done;
      });
      this.#waiters.set(requestId, {
        call,
        schema: params.requestedSchema,
        resolve,
        responding: false,
      });
      onAbort = () => resolve({ action: "cancel" });
      ended.addEventListener("abort", onAbort, { once: true });
      this.#options.publish(opened.events);
      if (ended.aborted || opened.request.status !== "pending") resolve({ action: "cancel" });
      return await answer;
    } catch (error) {
      if (error instanceof OpensteerError) return { action: "cancel" };
      throw error;
    } finally {
      if (onAbort) ended.removeEventListener("abort", onAbort);
      if (requestId) {
        this.#waiters.delete(requestId);
        this.#options.publish(
          await this.#options.requests.cancelIntegrationInputs(call.cancellationReason, requestId),
        );
      }
    }
  }
}

function decline(reason: string): ElicitResult {
  return { action: "decline", _meta: { "opensteer/reason": reason } };
}

function inputPresentation(title: string, params: FormParams) {
  const fields = [];
  for (const [id, property] of Object.entries(params.requestedSchema.properties)) {
    if (property.type === "array" || "oneOf" in property) return null;
    const choices =
      property.type === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : "enum" in property
          ? property.enum.map((value, index) => ({
              value,
              label: ("enumNames" in property ? property.enumNames?.[index] : undefined) ?? value,
            }))
          : undefined;
    fields.push({
      id,
      label: property.title ?? id,
      prompt: property.description ?? property.title ?? id,
      secret: true,
      multiSelect: false,
      ...(choices ? { choices } : {}),
    });
  }
  const result = RequestPresentationSchema.safeParse({
    kind: "form",
    title,
    detail: params.message,
    fields,
  });
  return result.success ? result.data : null;
}

function inputResult(
  schema: FormParams["requestedSchema"],
  response: RequestResponse,
): ElicitResult {
  if (
    response.kind === "choice" &&
    (response.optionId === "declined" ||
      response.optionId === "decline" ||
      response.optionId === "cancel")
  )
    return { action: response.optionId === "cancel" ? "cancel" : "decline" };
  if (response.kind !== "form")
    throw new OpensteerError({
      code: "bad_request",
      message: "Device input requires a form or a decline/cancel decision",
    });
  const values = new Map<string, string | number | boolean>();
  for (const [id, answers] of Object.entries(response.answers)) {
    const property = schema.properties[id];
    if (!Object.hasOwn(schema.properties, id) || !property || answers.length !== 1)
      throw new OpensteerError({
        code: "bad_request",
        message: "Answer each device input field once",
      });
    const answer = answers[0]!;
    if (answer === "" && !schema.required?.includes(id)) continue;
    if (property.type === "boolean") {
      if (answer !== "true" && answer !== "false")
        throw new OpensteerError({ code: "bad_request", message: "Choose Yes or No" });
      values.set(id, answer === "true");
    } else if (property.type === "number" || property.type === "integer") {
      const number = Number(answer);
      if (answer.trim() === "" || !Number.isFinite(number))
        throw new OpensteerError({ code: "bad_request", message: "Enter a valid number" });
      values.set(id, number);
    } else values.set(id, answer);
  }
  const content = Object.fromEntries(values);
  const validated = validateJsonSchema(schema, content);
  if (validated.length > 0)
    throw new OpensteerError({
      code: "bad_request",
      message: "The device input does not match the requested form",
    });
  return { action: "accept", content };
}
