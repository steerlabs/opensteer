import type { RunnerConfig } from "@opensteer/config";
import { allowsPlaintextRunnerTransport } from "@opensteer/core";
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  agentControlResponseMaxSerializedBytes,
  agentToolPayloadMaxSerializedBytes,
  type AgentControlRequest,
  type AgentControlResponse,
  type RunAgentControlPlan,
} from "@opensteer/protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";

const maxRequestBytes = agentToolPayloadMaxSerializedBytes;
const maxResponseBytes = agentControlResponseMaxSerializedBytes;
const requestTimeoutMilliseconds = 30_000;

export class HttpAgentControlClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: () => string;
  readonly #url: URL;

  constructor(options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly plan: RunAgentControlPlan;
    /** The Host token current at each request; defaults to the plan's. */
    readonly token?: () => string;
    readonly transport: Pick<RunnerConfig, "mode">;
  }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    const planToken = options.plan.token;
    this.#token = options.token ?? (() => planToken);
    this.#url = validateUrl(new URL(options.plan.url), options.transport);
  }

  async request(input: AgentControlRequest, signal: AbortSignal): Promise<AgentControlResponse> {
    const request = AgentControlRequestSchema.parse(input);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
      throw new Error("Agent control request exceeds its size limit");
    }
    let response: Response;
    try {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(requestTimeoutMilliseconds),
      ]);
      response = await this.#fetch(this.#url, {
        body,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token()}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      if (signal.aborted) throw signal.reason ?? new Error("Agent control request was aborted");
      throw new Error("Agent control request could not reach the Host", {
        cause: new Error("Network transport failed"),
      });
    }
    const payload = await readBoundedJson(response, {
      emptyValue: null,
      invalidJsonError: (cause) =>
        new Error("Host returned an invalid agent control response", { cause }),
      maximumBytes: maxResponseBytes,
      sizeError: () => new Error("Agent control response exceeds its size limit"),
    });
    if (!response.ok) {
      const message = errorMessage(payload);
      throw new Error(message ?? `Host rejected the agent control request (${response.status})`);
    }
    const parsed = AgentControlResponseSchema.parse(payload);
    if (parsed.requestId !== request.requestId) {
      throw new Error("Host returned an agent control response for another request");
    }
    if (parsed.type !== expectedResponseType(request.type)) {
      throw new Error("Host returned the wrong agent control response type");
    }
    return parsed;
  }
}

function validateUrl(url: URL, transport: Pick<RunnerConfig, "mode">): URL {
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Agent control URL cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:" && !allowsPlaintextRunnerTransport(transport.mode, url)) {
    throw new Error("Agent control transport must use HTTPS outside an allowed loopback placement");
  }
  return url;
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length <= 2_000 ? message : undefined;
}

function expectedResponseType(type: AgentControlRequest["type"]): AgentControlResponse["type"] {
  switch (type) {
    case "workspace.create":
      return "workspace.create.result";
    case "environment.list":
      return "environment.list.result";
    case "workspace.list":
      return "workspace.list.result";
    case "workspace.inspect":
      return "workspace.inspect.result";
    case "workspace.mount":
      return "workspace.mount.result";
    case "thread.read":
      return "thread.read.result";
    case "thread.list":
      return "thread.list.result";
    case "thread.delegate":
      return "thread.delegate.result";
    case "assignment.cancel":
      return "assignment.cancel.result";
    case "person.notify":
      return "person.notify.result";
    case "thread.message":
      return "thread.message.result";
    case "thread.write":
      return "thread.write.result";
    case "request.list":
      return "request.list.result";
    case "request.withdraw":
      return "request.withdraw.result";
    case "browser.profile.create":
      return "browser.profile.create.result";
    case "browser.profile.list":
      return "browser.profile.list.result";
    case "sign-in":
      return "sign-in.result";
    case "browser.sign-in":
      return "browser.sign-in.result";
    case "browser.access.request":
      return "browser.access.request.result";
    case "machine.full-disk-access.request":
      return "machine.full-disk-access.request.result";
    case "browser.session.open":
      return "browser.session.open.result";
    case "browser.tab.read":
      return "browser.tab.read.result";
    case "browser.tab.write":
      return "browser.tab.write.result";
    case "browser.session.list":
      return "browser.session.list.result";
    case "browser.session.close":
      return "browser.session.close.result";
    case "trigger.control":
      return "trigger.control.result";
  }
}
