import { OpensteerError, RequestIdSchema, type Request } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { PasswordSignInRequestResponseSchema } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { delay } from "@opensteer/shared/delay";
import type { ContinuationService } from "../agents/continuation-service.js";
import type { RunCaller } from "./agent-caller.js";

type HoldStore = Pick<OpensteerStore, "stopHeldRun"> & {
  readonly requests: Pick<
    OpensteerStore["requests"],
    "holdSnapshot" | "markToolDelivered" | "personSteerCount"
  >;
};

interface RequestHoldOptions {
  readonly store: HoldStore;
  readonly continuations: Pick<ContinuationService, "outcome">;
  readonly onStopped: (
    stop: NonNullable<Awaited<ReturnType<OpensteerStore["stopHeldRun"]>>>,
  ) => void;
}

export class RequestHold {
  readonly options: RequestHoldOptions;

  constructor(options: RequestHoldOptions) {
    this.options = options;
  }

  /** Read before the handler runs, so a steer arriving while it works still counts. */
  admit(caller: RunCaller): Promise<number> {
    return this.options.store.requests.personSteerCount(caller.claims.runId);
  }

  async wait(input: {
    readonly caller: RunCaller;
    readonly result: Record<string, unknown>;
    readonly tool: string;
    readonly admittedAt: number;
    readonly steersAtAdmission: number;
    readonly limitMs: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly record: Record<string, unknown>; readonly text?: string } | null> {
    const id = RequestIdSchema.safeParse(input.result.requestId);
    if (!id.success) return null;
    const { claims } = input.caller;
    const deadline = input.admittedAt + input.limitMs;
    let stopped = false;
    let admitted = false;
    const deadlineError = new Error("Request hold deadline reached");
    const stopRun = async (reason: "limit" | "queued-input") => {
      const stop = await this.options.store.stopHeldRun(claims, reason);
      if (!stop) throw ended();
      stopped = true;
      this.options.onStopped(stop);
    };
    for (;;) {
      input.signal.throwIfAborted();
      const snapshot = await this.options.store.requests.holdSnapshot(
        id.data,
        claims.runId,
        input.steersAtAdmission,
      );
      if (!snapshot) return null;
      if (["completed", "failed", "interrupted"].includes(snapshot.run.status)) throw ended();
      if (!stopped && (snapshot.run.phase !== "turn" || snapshot.run.voiceSessionId !== null))
        return admitted ? { record: input.result } : null;
      admitted = true;
      if (!stopped && (snapshot.queued || Date.now() >= deadline)) {
        await stopRun(snapshot.queued ? "queued-input" : "limit");
      }
      if (!stopped) {
        let outcome: Awaited<ReturnType<ContinuationService["outcome"]>>;
        try {
          outcome = await withTimeout(
            this.options.continuations.outcome(snapshot.request),
            Math.max(0, deadline - Date.now()),
            {
              signal: input.signal,
              timeoutError: () => deadlineError,
            },
          );
        } catch (error) {
          if (error !== deadlineError) throw error;
          await stopRun("limit");
          continue;
        }
        if (Date.now() >= deadline) {
          await stopRun("limit");
          continue;
        }
        if (outcome) {
          const record = outcomeRecord(input.tool, input.result, outcome);
          input.signal.throwIfAborted();
          const delivery = await this.options.store.requests.markToolDelivered(id.data, claims);
          if (delivery === "refused") throw ended();
          return { record, text: outcome.text };
        }
        if (snapshot.steered) return { record: input.result };
      }
      await delay(stopped ? 500 : Math.min(500, Math.max(0, deadline - Date.now())), input.signal);
    }
  }
}

function ended(): OpensteerError {
  return new OpensteerError({ code: "forbidden", message: "The Request's execution has ended" });
}

function outcomeRecord(
  tool: string,
  pending: Record<string, unknown>,
  outcome: {
    readonly request: Request;
    readonly loginRef?: string;
    readonly publicCard?: { readonly brand: string; readonly lastFour: string };
  },
): Record<string, unknown> {
  const { request, loginRef } = outcome;
  const response =
    request.payload.kind === "browser.password-sign-in" && request.status === "fulfilled"
      ? PasswordSignInRequestResponseSchema.parse(
          request.response.kind === "external" ? request.response.value : undefined,
        )
      : undefined;
  if (tool === "sign_in") {
    if (
      response?.outcome === "authorized" &&
      loginRef &&
      request.payload.kind === "browser.password-sign-in"
    )
      return { status: "ready", site: request.payload.site, loginRef, account: response.account };
    return {
      requestId: request.id,
      status: request.status === "declined" ? "declined" : "resolved",
    };
  }
  if (tool === "use_card" && request.payload.kind === "browser.password-sign-in") {
    const site = request.payload.site;
    if (response?.outcome === "authorized" && loginRef && outcome.publicCard)
      return { status: "ready", site, cardRef: loginRef, ...outcome.publicCard };
    if (
      response?.outcome === "expired" ||
      response?.outcome === "interrupted" ||
      response?.outcome === "session-closed"
    )
      return { status: "unavailable", site, reason: response.outcome };
    return { status: request.status === "declined" ? "declined" : "resolved", site };
  }
  return { ...pending, status: request.status };
}
