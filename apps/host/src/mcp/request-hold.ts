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
  readonly onError: (error: unknown) => void;
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
    const executionEnded = ended();
    const pastDeadline = new Error("Request hold deadline reached");
    let stopped = false;
    let admitted = false;
    let reported = false;
    const stopRun = async (reason: "limit" | "queued-input") => {
      const stop = await this.options.store.stopHeldRun(claims, reason);
      if (!stop) throw executionEnded;
      stopped = true;
      this.options.onStopped(stop);
    };
    for (;;) {
      input.signal.throwIfAborted();
      try {
        const snapshot = await this.options.store.requests.holdSnapshot(
          id.data,
          claims.runId,
          input.steersAtAdmission,
        );
        if (!snapshot) return null;
        if (["completed", "failed", "interrupted"].includes(snapshot.run.status))
          throw executionEnded;
        if (!stopped) {
          if (snapshot.run.phase !== "turn" || snapshot.run.voiceSessionId !== null)
            return admitted ? { record: input.result } : null;
          admitted = true;
          if (snapshot.queued) {
            await stopRun("queued-input");
          } else if (Date.now() < deadline) {
            const outcome = await withTimeout(
              this.options.continuations.outcome(snapshot.request),
              deadline - Date.now(),
              { signal: input.signal, timeoutError: () => pastDeadline },
            );
            if (outcome) {
              const record = outcomeRecord(input.tool, input.result, outcome);
              input.signal.throwIfAborted();
              const delivery = await this.options.store.requests.markToolDelivered(id.data, claims);
              if (delivery === "refused") throw executionEnded;
              return { record, text: outcome.text };
            }
            if (snapshot.steered) return { record: input.result };
          }
        }
        if (!stopped && Date.now() >= deadline) await stopRun("limit");
      } catch (error) {
        if (error === executionEnded || input.signal.aborted) throw error;
        if (error === pastDeadline) continue;
        // The Request is open, so a failed read must not hand a live Run back its turn.
        if (!reported) {
          reported = true;
          this.options.onError(error);
        }
      }
      const remaining = deadline - Date.now();
      await delay(stopped || remaining <= 0 ? 500 : Math.min(500, remaining), input.signal);
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
  const record: Record<string, unknown> = { ...pending, status: request.status };
  delete record.guidance;
  delete record.nextAction;
  return record;
}
