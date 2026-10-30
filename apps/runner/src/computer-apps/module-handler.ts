import { MacWindowVideoRelay, type MacVideoEvent } from "./mac-window-video-relay.js";
import type { RunnerTransportPolicy } from "@opensteer/runner-client";
import type { RunnerIntegrationsComputerViewResult } from "@opensteer/protocol";
import { validateJsonSchema } from "@opensteer/integration-adapters";
import { getIntegrationDefinition } from "@opensteer/integration-catalog";
import {
  isComputerAppDefinition,
  type ComputerAppOperation,
} from "@opensteer/integration-core/computer-app";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import {
  computerAppMaxConcurrentInvokes,
  computerAppMaxFrameBytes,
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
  RunnerIntegrationsComputerAppWindowsResultSchema,
  RunnerIntegrationsComputerViewResultSchema,
  type HostIntegrationsPasswordSignIn,
  type RunnerIntegrationsPasswordSignInEvent,
  type RunnerIntegrationsPasswordSignInResult,
  type HostIntegrationsComputerAppApprovalOutcome,
  type HostIntegrationsComputerAppApprovalKeyChallenge,
  type HostIntegrationsComputerAppApprovals,
  type HostIntegrationsComputerUse,
  type HostIntegrationsComputerView,
  type HostIntegrationsComputerAppWindows,
  type RunnerIntegrationsComputerAppWindowsResult,
  type HostIntegrationsInvoke,
  type RunnerIntegrationsComputerAppApprovalAnswer,
  type RunnerIntegrationsComputerAppApprovalKeyProof,
  type RunnerIntegrationsComputerAppApprovalsSync,
  type RunnerIntegrationsComputerUseResult,
  type RunnerIntegrationsComputerUseEvent,
  type RunnerIntegrationsResult,
  type RunnerIntegrationsStatus,
} from "@opensteer/protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import type { RunnerLogger } from "../host/host-connection.js";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import type { ComputerUseHandler } from "./computer-use-handler.js";
import type { LocalMcpFrame, LocalMcpServers } from "./local-mcp-servers.js";
import { computerUseUnsupportedSentence } from "./macos-app-provider.js";
import {
  ComputerAppError,
  computerAppMessageMaxLength,
  type ComputerAppInvocation,
  type ComputerAppOperationInspection,
  type ComputerAppProvider,
  type ComputerAppValue,
} from "./provider.js";

export const computerAppStatusIntervalMs = 30_000;

export interface ComputerAppModuleHandlerOptions {
  /**
   * This Mac's computer use, present only when the desktop app offers it. The
   * handler never constructs one: without a bridge every computer-use frame is
   * answered `unsupported`, and a client is a socket to a server that is not
   * there.
   */
  readonly computerUse?: ComputerUseHandler;
  readonly videoTransport?: RunnerTransportPolicy;
  /**
   * The MCP servers this computer runs, present exactly when `computerUse`
   * is: a launch runs only once approved on this computer, and only the
   * desktop app asks.
   */
  readonly localMcp?: LocalMcpServers;
  readonly logger: RunnerLogger;
  readonly providers: readonly ComputerAppProvider[];
  readonly statusIntervalMs?: number;
}

interface InFlightInvoke {
  readonly abort: AbortController;
}

type Result = RunnerIntegrationsResult["result"];
type ComputerUseResult = RunnerIntegrationsComputerUseResult["result"];
type IntegrationsStatus = Pick<
  RunnerIntegrationsStatus,
  | "apps"
  | "captureSupported"
  | "displayAvailable"
  | "ownerViewVersion"
  | "type"
  | "loginText"
  | "passwordSignIn"
>;

type OutboundEvent =
  | Pick<RunnerIntegrationsPasswordSignInEvent, "type" | "event">
  | Pick<RunnerIntegrationsPasswordSignInResult, "type" | "requestId" | "result">
  | MacVideoEvent
  | Pick<RunnerIntegrationsComputerAppWindowsResult, "requestId" | "result" | "type">
  | Pick<RunnerIntegrationsComputerViewResult, "requestId" | "result" | "type">
  | LocalMcpFrame
  | IntegrationsStatus
  | Pick<RunnerIntegrationsComputerUseEvent, "event" | "type">
  | Pick<RunnerIntegrationsComputerAppApprovalAnswer, "answer" | "setupRequestId" | "type">
  | Pick<RunnerIntegrationsComputerAppApprovalKeyProof, "challengeId" | "signature" | "type">
  | Pick<RunnerIntegrationsComputerAppApprovalsSync, "type">
  | Pick<RunnerIntegrationsResult, "requestId" | "result" | "type">
  | Pick<RunnerIntegrationsComputerUseResult, "requestId" | "result" | "type">;

/** What an app is told to say when this Runner cannot name the reason. */
const providerFailureSentence = "The app could not complete this request.";
/**
 * A write whose outcome this handler cannot vouch for. Anything that ends a
 * write after the provider started it — a deadline, an exception, an answer
 * too large to carry — may have happened, and a caller told "failed" would
 * run it again.
 */
const writeMayHaveHappened: Result = {
  code: "outcome-unknown",
  kind: "error",
  message: "The request may already have taken effect.",
};
/**
 * The helper bounds an observation so it fits this frame, so this is a guard
 * rather than a path an agent is expected to take. It still says the one thing
 * that helps: ask the Mac again, because an observation is never repaired.
 */
const oversizedObservationSentence = "The observation was too large; observe again.";
/** A listing is bounded by what was asked for, so asking for less is the remedy. */
const oversizedAnswerSentence = "The Mac's answer was too large; ask for fewer results.";
const computerUseFailureSentence = "The Mac could not complete this request.";
/**
 * This Runner's own capacity, said as what it is. It is not `busy`: that code
 * means another task holds the app, and the Host says so to the model.
 */
const computerUseCapacitySentence =
  "The Mac is already running as many computer use requests as it can; try again when one finishes.";
/** What `ComputerUseErrorSchema` allows a refusal's sentence to be. */
const computerUseMessageMaxLength = 1_000;

/** Owns one attached `integrations` stream and every app call running on it. */
export class ComputerAppModuleHandler {
  readonly #computerUse: ComputerUseHandler | undefined;
  readonly #videoTransport: RunnerTransportPolicy | undefined;
  #video: MacWindowVideoRelay | undefined;
  readonly #localMcp: LocalMcpServers | undefined;
  readonly #logger: RunnerLogger;
  readonly #providers: readonly ComputerAppProvider[];
  readonly #providersByDefinitionId: ReadonlyMap<string, ComputerAppProvider>;
  readonly #statusIntervalMs: number;
  readonly #inFlight = new Map<string, InFlightInvoke>();
  /**
   * Calls whose provider promise has not settled, answered or not.
   *
   * Being answered and being finished are two different things. A provider that
   * ignores its `AbortSignal` goes on running after a cancel, a deadline or a
   * detach has already sent that call's result, and counting only the calls
   * still awaiting an answer would admit a new one on top of it — enough
   * cancels and a computer runs unbounded overlapping work. The concurrency
   * bound is about what this computer is doing, so the slot is held by the
   * provider's own promise and this count outlives any one stream.
   */
  #executing = 0;
  #detachComputerUseEvents: (() => void) | undefined;
  #detachApprovalEvents: (() => void) | undefined;
  #detachPasswordEvents: (() => void) | undefined;
  #detachGrantEvents: (() => void) | undefined;
  #inspectionWaiting: RunnerModuleStream | undefined;
  #inspection: Promise<void> = Promise.resolve();
  #lastStatus: string | undefined;
  #publishedStatus: IntegrationsStatus | undefined;
  #statusTimer: ReturnType<typeof setInterval> | undefined;
  #stream: RunnerModuleStream | undefined;

  constructor(options: ComputerAppModuleHandlerOptions) {
    this.#computerUse = options.computerUse;
    this.#videoTransport = options.videoTransport;
    this.#localMcp = options.localMcp;
    this.#logger = options.logger;
    this.#providers = options.providers;
    this.#providersByDefinitionId = new Map(
      options.providers.map((provider) => [provider.definitionId, provider]),
    );
    this.#statusIntervalMs = options.statusIntervalMs ?? computerAppStatusIntervalMs;
  }

  get maxPayloadBytes(): number {
    return computerAppMaxFrameBytes;
  }

  attach(stream: RunnerModuleStream): void {
    this.#stopAttachedStream();
    this.#stream = stream;
    this.#computerUse?.negotiateLoginText(stream.loginText === 1);
    if (this.#computerUse && this.#videoTransport)
      this.#video = new MacWindowVideoRelay(
        this.#computerUse,
        this.#videoTransport,
        (event) => this.#send(stream, event),
        (event, fields) => this.#logger.info(event, fields),
      );
    this.#detachComputerUseEvents = this.#computerUse?.onEvent((event) => {
      const { kind: _kind, ...helperEvent } = event;
      void this.#send(stream, {
        event: helperEvent,
        type: "runner.integrations.computer-use-event",
      }).catch((error: unknown) => {
        this.#logger.error("Computer use event could not be sent", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    });
    // The person's answers, and desktop main asking for the whole list, go to
    // the Host on this stream: approvals travel on the Mac's own connection.
    this.#detachApprovalEvents = this.#computerUse?.onApprovalEvent((event) => {
      // The person's own answer is what lets a server run here; the Host's
      // outcome, which follows, grants nothing on this computer.
      if (event.kind === "answer" && event.server) this.#localMcp?.allow(event.server);
      const frame: OutboundEvent =
        event.kind === "answer"
          ? {
              answer: event.answer.answer,
              setupRequestId: event.answer.setupRequestId,
              type: "runner.integrations.computer-app-approval-answer",
            }
          : { type: "runner.integrations.computer-app-approvals-sync" };
      void this.#send(stream, frame).catch((error: unknown) => {
        this.#logger.error("Computer app approval could not be sent", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.#detachGrantEvents = this.#computerUse?.onGrantsChanged(() => {
      this.#invalidatePasswordStatus(stream);
      this.#queueInspection(stream);
    });
    this.#detachPasswordEvents = this.#computerUse?.onPasswordEvent((event) => {
      if (stream.passwordSignIn === 1)
        void this.#send(stream, {
          type: "runner.integrations.password-sign-in-event",
          event,
        }).catch(() => undefined);
    });
    this.#localMcp?.attach((frame) => this.#send(stream, frame));
    this.#inspection = Promise.resolve();
    this.#lastStatus = undefined;
    this.#queueInspection(stream);
    this.#statusTimer = setInterval(() => this.#queueInspection(stream), this.#statusIntervalMs);
    this.#statusTimer.unref();
  }

  detach(): void {
    this.#stopAttachedStream();
  }

  async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) throw new Error("The integrations module accepts JSON messages only");
    if (frame.byteLength > computerAppMaxFrameBytes) {
      throw new Error("Computer app control message exceeds its size limit");
    }
    const message = HostToIntegrationsModuleMessageSchema.parse(JSON.parse(frame.toString("utf8")));
    switch (message.type) {
      case "host.integrations.mac-owner.input-reset":
      case "host.integrations.mac-owner.input":
      case "host.integrations.display.resolve":
      case "host.integrations.display.start":
      case "host.integrations.display.demand":
      case "host.integrations.display.refresh":
      case "host.integrations.display.stop":
      case "host.integrations.display.input-reset":
      case "host.integrations.display.input":
        this.#video?.handle(message);
        return;
      case "host.integrations.password-sign-in":
        void this.#passwordSignIn(message).catch(() => {
          this.#logger.error("Password sign-in response could not be sent");
        });
        return;
      case "host.integrations.invoke":
        await this.#registerInvoke(message);
        return;
      case "host.integrations.computer-app-windows":
        this.#registerComputerView(message);
        return;
      case "host.integrations.computer-view":
        this.#registerComputerView(message);
        return;
      case "host.integrations.computer-use":
        await this.#registerComputerUse(message);
        return;
      case "host.integrations.cancel":
        this.#inFlight
          .get(message.requestId)
          ?.abort.abort(new Error("Computer app call cancelled"));
        return;
      case "host.integrations.computer-app-approvals":
      case "host.integrations.computer-app-approval-outcome":
        this.#relayApprovals(message);
        return;
      case "host.integrations.computer-app-approval-key-challenge":
        this.#proveApprovalKey(message);
        return;
      case "host.integrations.mcp.open":
        if (this.#localMcp) await this.#localMcp.open(message);
        else await this.#refuseMcp(message.sessionId);
        return;
      case "host.integrations.mcp.message":
        this.#localMcp?.message(message);
        return;
      case "host.integrations.mcp.close":
        await this.#localMcp?.close(message);
        return;
      case "host.auxiliary.challenge":
      case "host.auxiliary.welcome":
      case "host.auxiliary.rejected":
      case "host.auxiliary.lease-renewed":
        throw new Error("The integrations module received an out-of-sequence handshake message");
    }
  }

  async #passwordSignIn(message: HostIntegrationsPasswordSignIn): Promise<void> {
    const stream = this.#stream;
    if (!stream) return;
    if (this.#inFlight.has(message.requestId)) return;
    const abort = new AbortController();
    this.#inFlight.set(message.requestId, { abort });
    try {
      const result =
        stream.passwordSignIn === 1 && this.#computerUse
          ? await this.#computerUse.passwordControl(
              message.command,
              Date.now() + message.timeoutMs,
              abort.signal,
            )
          : { type: "unavailable" as const };
      if (this.#stream === stream && !abort.signal.aborted)
        await this.#send(stream, {
          type: "runner.integrations.password-sign-in-result",
          requestId: message.requestId,
          result,
        });
    } finally {
      if (this.#inFlight.get(message.requestId)?.abort === abort)
        this.#inFlight.delete(message.requestId);
    }
  }

  #registerComputerView(
    message: HostIntegrationsComputerView | HostIntegrationsComputerAppWindows,
  ): void {
    const stream = this.#stream;
    if (!stream || this.#inFlight.has(message.requestId)) return;
    const abort = new AbortController();
    this.#inFlight.set(message.requestId, { abort });
    // Listing an app's windows only reads what is open — the helper never
    // starts an app or asks it for a window to list it — so a start page's
    // lists for every app never wait on, or are refused for, agent work.
    const occupies =
      message.type === "host.integrations.computer-view" && message.operation === "open";
    const admitted = !occupies || this.#executing < computerAppMaxConcurrentInvokes;
    const receivedAt = Date.now();
    if (admitted) {
      if (occupies) this.#executing++;
    }
    void (async () => {
      let result:
        | RunnerIntegrationsComputerViewResult["result"]
        | RunnerIntegrationsComputerAppWindowsResult["result"];
      const timer = setTimeout(() => abort.abort(), message.timeoutMs);
      timer.unref();
      try {
        if (!this.#computerUse)
          result = { kind: "error", code: "unsupported", message: computerUseUnsupportedSentence };
        else if (!admitted)
          result = { kind: "error", code: "unavailable", message: "That computer is busy." };
        else if (message.type === "host.integrations.computer-app-windows")
          result = {
            kind: "ok",
            value: await this.#computerUse.runViewWindows(message, abort.signal, receivedAt),
          };
        else
          result = {
            kind: "ok",
            value: await this.#computerUse.runView(message, abort.signal, receivedAt),
          };
      } catch (error) {
        const code =
          message.type === "host.integrations.computer-app-windows"
            ? error instanceof ComputerUseBridgeError
              ? error.code
              : "failed"
            : error instanceof ComputerUseBridgeError && error.code === "unsupported"
              ? "unsupported"
              : error instanceof ComputerUseBridgeError && error.code === "no-session"
                ? "ended"
                : error instanceof ComputerUseBridgeError && error.code === "permission-required"
                  ? "permission-required"
                  : "unavailable";
        result = {
          kind: "error",
          code,
          message:
            error instanceof Error ? error.message.slice(0, 1000) : computerUseFailureSentence,
        };
      } finally {
        clearTimeout(timer);
        if (admitted) {
          if (occupies) this.#executing--;
        }
      }
      if (this.#inFlight.get(message.requestId)?.abort !== abort || this.#stream !== stream) return;
      this.#inFlight.delete(message.requestId);
      const response = { ...stream.fence, requestId: message.requestId, result };
      if (message.type === "host.integrations.computer-app-windows")
        await this.#send(
          stream,
          RunnerIntegrationsComputerAppWindowsResultSchema.parse({
            ...response,
            type: "runner.integrations.computer-app-windows-result",
          }),
        );
      else
        await this.#send(
          stream,
          RunnerIntegrationsComputerViewResultSchema.parse({
            ...response,
            type: "runner.integrations.computer-view-result",
          }),
        );
    })().catch((error: unknown) =>
      this.#logger.error("Owner view result could not be sent", { reason: String(error) }),
    );
  }

  #proveApprovalKey(message: HostIntegrationsComputerAppApprovalKeyChallenge): void {
    const stream = this.#stream;
    const computerUse = this.#computerUse;
    if (!stream || !computerUse) return;
    void computerUse
      .proveApprovalKey({
        challengeId: message.challengeId,
        expiresAt: message.expiresAt,
        keyId: message.keyId,
        nonce: message.nonce,
        runnerId: message.runnerId,
      })
      .then((proof) =>
        this.#send(stream, {
          ...proof,
          type: "runner.integrations.computer-app-approval-key-proof",
        }),
      )
      .catch((error: unknown) => {
        this.#logger.info("Computer app approval key could not be verified", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Hands an approval frame to desktop main, which shows and answers it. It
   * is not awaited: the Host is owed nothing for it, and a desktop that is not
   * there asks for the whole list again when it connects.
   */
  #relayApprovals(
    message: HostIntegrationsComputerAppApprovals | HostIntegrationsComputerAppApprovalOutcome,
  ): void {
    const computerUse = this.#computerUse;
    if (!computerUse) return;
    const relayed =
      message.type === "host.integrations.computer-app-approvals"
        ? computerUse.relayApprovals({
            approvalKeyId: message.approvalKeyId,
            approvals: message.approvals,
          })
        : computerUse.relayApprovalOutcome({
            outcome: message.outcome,
            setupRequestId: message.setupRequestId,
          });
    void relayed.catch((error: unknown) => {
      this.#logger.info("Computer app approvals did not reach the desktop app", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #registerInvoke(message: HostIntegrationsInvoke): Promise<void> {
    const stream = this.#stream;
    if (!stream) throw new Error("The integrations module stream is detached");
    if (this.#inFlight.has(message.requestId)) {
      this.#logger.info("Ignoring a duplicate computer app request", {
        requestId: message.requestId,
      });
      return;
    }
    const provider = this.#providersByDefinitionId.get(message.definitionId);
    const definition = getIntegrationDefinition(message.definitionId);
    if (!provider || !definition || !isComputerAppDefinition(definition)) {
      await this.#sendResult(
        stream,
        message.requestId,
        unsupported("This app is not available here."),
        null,
      );
      return;
    }
    const operation = definition.config.operations.find(({ name }) => name === message.operation);
    if (!operation) {
      await this.#sendResult(
        stream,
        message.requestId,
        unsupported("This operation is not supported."),
        null,
      );
      return;
    }
    if (message.contract !== computerAppOperationContract(operation)) {
      await this.#sendResult(
        stream,
        message.requestId,
        unsupported("This operation comes from a different Opensteer version."),
        null,
      );
      return;
    }
    if (operation.effect === "write" && message.access === "read") {
      await this.#sendResult(
        stream,
        message.requestId,
        {
          code: "failed",
          kind: "error",
          message: "This app is read only.",
        },
        null,
      );
      return;
    }
    if (validateJsonSchema(operation.inputSchema, message.arguments).length > 0) {
      await this.#sendResult(
        stream,
        message.requestId,
        {
          code: "invalid-arguments",
          kind: "error",
          message: "The arguments do not match this operation.",
        },
        null,
      );
      return;
    }
    if (this.#executing >= computerAppMaxConcurrentInvokes) {
      await this.#sendResult(
        stream,
        message.requestId,
        {
          code: "busy",
          kind: "error",
          message: "This app is busy with other requests.",
        },
        null,
      );
      return;
    }

    const abort = new AbortController();
    this.#inFlight.set(message.requestId, { abort });
    void this.#runInvoke(stream, provider, operation, message, abort).catch((error: unknown) => {
      this.#logger.error("Computer app result could not be sent", {
        reason: error instanceof Error ? error.message : String(error),
        requestId: message.requestId,
      });
    });
  }

  async #runInvoke(
    stream: RunnerModuleStream,
    provider: ComputerAppProvider,
    operation: ComputerAppOperation,
    message: HostIntegrationsInvoke,
    abort: AbortController,
  ): Promise<void> {
    const deadline = setTimeout(
      () => abort.abort(new Error("Computer app call timed out")),
      message.timeoutMs,
    );
    deadline.unref();
    // The work and the answer are held apart from here on. The race below
    // decides the answer, which is sent exactly once and at once; the slot this
    // call occupies belongs to `work`, and is given back only when the provider
    // itself is done — see `#executing`.
    this.#executing += 1;
    const releaseSlot = (): void => {
      this.#executing -= 1;
    };
    const work = invokeProvider(provider, message, abort.signal, {
      access: message.access,
      contract: message.contract,
      deadline: Date.now() + message.timeoutMs,
      effect: operation.effect,
    });
    void work.then(releaseSlot, releaseSlot);
    let result: Result;
    try {
      const value = await Promise.race([work, rejectedWhenAborted(abort.signal)]);
      result = { kind: "ok", value };
    } catch (error) {
      result = this.#invokeError(error, operation.effect, abort.signal.aborted);
    } finally {
      clearTimeout(deadline);
    }

    const active = this.#inFlight.get(message.requestId);
    if (active?.abort !== abort) return;
    this.#inFlight.delete(message.requestId);
    await this.#sendResult(stream, message.requestId, result, operation.effect);
    if (result.kind === "error" && result.code === "permission-required") {
      this.#queueInspection(stream);
    }
  }

  #invokeError(error: unknown, effect: ComputerAppOperation["effect"], aborted: boolean): Result {
    if (aborted) {
      return effect === "write"
        ? writeMayHaveHappened
        : { code: "failed", kind: "error", message: "Timed out." };
    }
    if (error instanceof ComputerAppError) {
      return {
        code: error.code,
        kind: "error",
        message: boundedMessage(error.message),
      };
    }
    this.#logger.error("Computer app provider failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return effect === "write"
      ? writeMayHaveHappened
      : { code: "failed", kind: "error", message: providerFailureSentence };
  }

  /**
   * One computer-use frame, which shares everything an invoke has — this
   * stream's fence, the concurrency bound, cancellation by request id — and
   * differs only in where it goes and what it may answer.
   */
  async #registerComputerUse(message: HostIntegrationsComputerUse): Promise<void> {
    // The Host's deadline counts from here: every hop after this one is given
    // what is left of it.
    const receivedAt = Date.now();
    const stream = this.#stream;
    if (!stream) throw new Error("The integrations module stream is detached");
    if (this.#inFlight.has(message.requestId)) {
      this.#logger.info("Ignoring a duplicate computer use request", {
        requestId: message.requestId,
      });
      return;
    }
    const computerUse = this.#computerUse;
    if (!computerUse) {
      await this.#sendComputerUseResult(stream, message.requestId, {
        code: "unsupported",
        kind: "error",
        message: computerUseUnsupportedSentence,
      });
      return;
    }
    if (occupiesSlot(message.operation) && this.#executing >= computerAppMaxConcurrentInvokes) {
      await this.#sendComputerUseResult(stream, message.requestId, {
        code: "failed",
        kind: "error",
        message: computerUseCapacitySentence,
      });
      return;
    }
    const abort = new AbortController();
    this.#inFlight.set(message.requestId, { abort });
    void this.#runComputerUse(stream, computerUse, message, abort, receivedAt).catch(
      (error: unknown) => {
        this.#logger.error("Computer use result could not be sent", {
          reason: error instanceof Error ? error.message : String(error),
          requestId: message.requestId,
        });
      },
    );
  }

  async #runComputerUse(
    stream: RunnerModuleStream,
    computerUse: ComputerUseHandler,
    message: HostIntegrationsComputerUse,
    abort: AbortController,
    receivedAt: number,
  ): Promise<void> {
    // No timer here: the deadline travels with the call, every hop answers by
    // it, and the bridge client gives up on a call that outlives it. A timer
    // of this module's own would answer before the Mac could say what it did.
    // The slot belongs to the work, exactly as it does for an invoke: the
    // helper finishes the batch it started whatever this end decides, so a
    // cancelled `act` must not free a slot for a second batch in the same app.
    const slot = occupiesSlot(message.operation);
    if (slot) this.#executing += 1;
    const releaseSlot = (): void => {
      if (slot) this.#executing -= 1;
    };
    const work = computerUse.run(message, abort.signal, receivedAt);
    void work.then(releaseSlot, releaseSlot);
    let result: ComputerUseResult;
    try {
      const value = await Promise.race([work, rejectedWhenAborted(abort.signal)]);
      result = { kind: "ok", value };
    } catch (error) {
      result = this.#computerUseError(error, message.operation, abort.signal.aborted);
    }

    const active = this.#inFlight.get(message.requestId);
    if (active?.abort !== abort) return;
    if (abort.signal.aborted && message.operation === "act" && result.kind === "error") {
      await this.#sendComputerUseResult(stream, message.requestId, result, message.operation);
      // Written native actions still own their slot. Forward their final
      // receipt on this exact stream for the Host's audit collector only.
      try {
        const value = await work;
        if (this.#inFlight.get(message.requestId)?.abort === abort)
          await this.#sendComputerUseResult(
            stream,
            message.requestId,
            { kind: "ok", value },
            message.operation,
          );
      } catch {
        // The cancellation acknowledgement already reported the unknown outcome.
      } finally {
        if (this.#inFlight.get(message.requestId)?.abort === abort)
          this.#inFlight.delete(message.requestId);
      }
      return;
    }
    this.#inFlight.delete(message.requestId);
    await this.#sendComputerUseResult(stream, message.requestId, result, message.operation);
    if (result.kind === "error" && result.code === "permission-required") {
      this.#queueInspection(stream);
    }
  }

  #computerUseError(
    error: unknown,
    operation: HostIntegrationsComputerUse["operation"],
    aborted: boolean,
  ): ComputerUseResult {
    if (aborted) {
      // `act` is the one operation that changes the app, and the helper does
      // not stop mid-batch for this end, so a cancelled one may already have
      // happened. It is never retried on that answer.
      return operation === "act"
        ? {
            code: "outcome-unknown",
            kind: "error",
            message: "The actions may already have taken effect.",
          }
        : { code: "failed", kind: "error", message: "The request was cancelled." };
    }
    if (error instanceof ComputerUseBridgeError) {
      return { code: error.code, kind: "error", message: boundedSentence(error.message) };
    }
    this.#logger.error("Computer use failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { code: "failed", kind: "error", message: computerUseFailureSentence };
  }

  /**
   * One inspection waiting its turn answers every request to look again made
   * before it starts, so a burst of them — refusals, the person coming back
   * to the desktop — reads each app once.
   */
  #queueInspection(stream: RunnerModuleStream): void {
    if (this.#inspectionWaiting === stream) return;
    this.#inspectionWaiting = stream;
    this.#inspection = this.#inspection
      .then(() => {
        if (this.#inspectionWaiting === stream) this.#inspectionWaiting = undefined;
        return this.#inspect(stream);
      })
      .catch((error: unknown) => {
        this.#logger.error("Computer app inspection failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  #invalidatePasswordStatus(stream: RunnerModuleStream): void {
    const current = this.#publishedStatus;
    if (!current || (!current.loginText && !current.passwordSignIn)) return;
    const { loginText: _loginText, passwordSignIn: _passwordSignIn, ...base } = current;
    const capabilities = this.#computerUse?.passwordsSnapshot();
    const status: IntegrationsStatus = {
      ...base,
      ...(stream.passwordSignIn === 1 && capabilities?.authority === 1
        ? { passwordSignIn: 1 }
        : {}),
    };
    this.#publishedStatus = status;
    this.#lastStatus = undefined;
    void this.#send(stream, status).catch(() => undefined);
  }

  async #inspect(stream: RunnerModuleStream): Promise<void> {
    if (this.#stream !== stream) return;
    const apps = await Promise.all(
      this.#providers.map(async (provider) => {
        let operations: readonly ComputerAppOperationInspection[];
        try {
          operations = await provider.inspect();
        } catch (error) {
          this.#logger.error("Computer app provider could not be inspected", {
            definitionId: provider.definitionId,
            reason: error instanceof Error ? error.message : String(error),
          });
          const definition = getIntegrationDefinition(provider.definitionId);
          operations =
            definition && isComputerAppDefinition(definition)
              ? definition.config.operations.map((operation) => ({
                  detail: "This app could not be inspected.",
                  operation: operation.name,
                  remedy: null,
                  state: "unavailable" as const,
                }))
              : [];
        }
        return { definitionId: provider.definitionId, operations: [...operations] };
      }),
    );
    if (this.#stream !== stream) return;
    const capabilities =
      this.#computerUse && (stream.loginText === 1 || stream.passwordSignIn === 1)
        ? await this.#computerUse.passwordsCapabilities()
        : undefined;
    const passwords = {
      ...(stream.loginText === 1 && capabilities?.receiver
        ? { loginText: capabilities.receiver }
        : {}),
      ...(stream.passwordSignIn === 1 && capabilities?.authority === 1
        ? { passwordSignIn: 1 as const }
        : {}),
    };
    const ownerViewVersion = this.#computerUse?.ownerViewVersion();
    if (this.#stream !== stream) return;
    const fingerprint = JSON.stringify({ apps, ownerViewVersion, ...passwords });
    if (fingerprint === this.#lastStatus) return;
    const status: IntegrationsStatus = {
      apps,
      ...passwords,
      ...(ownerViewVersion === undefined ? {} : { ownerViewVersion }),
      // Desktop bundles this Runner with a helper that speaks the capture
      // method, and replaces any older helper before a session can open.
      ...(this.#computerUse ? { displayAvailable: ownerViewVersion === 3 } : {}),
      type: "runner.integrations.status",
    };
    this.#publishedStatus = status;
    await this.#send(stream, status);
    if (this.#stream === stream && this.#publishedStatus === status) this.#lastStatus = fingerprint;
  }

  /**
   * `ran` is the effect of the operation the provider ran, or null for a
   * refusal made before any provider was touched.
   */
  async #sendResult(
    stream: RunnerModuleStream,
    requestId: HostIntegrationsInvoke["requestId"],
    result: Result,
    ran: ComputerAppOperation["effect"] | null,
  ): Promise<void> {
    if (this.#stream !== stream) return;
    const event = { requestId, result, type: "runner.integrations.result" } as const;
    // The event schema's own refinement measures the serialised frame against
    // `computerAppMaxFrameBytes`, so one parse answers both questions a result
    // raises: is it a frame this module may send, and does it fit. A read too
    // large for either is the same thing to the agent — ask for less. A write
    // that ran has happened however large its answer was.
    const fits = IntegrationsModuleEventSchema.safeParse({
      ...stream.fence,
      module: "integrations",
      ...event,
    }).success;
    await this.#send(
      stream,
      fits
        ? event
        : {
            requestId,
            result:
              ran === "write"
                ? writeMayHaveHappened
                : { code: "failed", kind: "error", message: "Narrow the request." },
            type: "runner.integrations.result",
          },
    );
  }

  async #sendComputerUseResult(
    stream: RunnerModuleStream,
    requestId: HostIntegrationsComputerUse["requestId"],
    result: ComputerUseResult,
    operation?: HostIntegrationsComputerUse["operation"],
  ): Promise<void> {
    if (this.#stream !== stream) return;
    const event = { requestId, result, type: "runner.integrations.computer-use-result" } as const;
    const fits = IntegrationsModuleEventSchema.safeParse({
      ...stream.fence,
      module: "integrations",
      ...event,
    }).success;
    await this.#send(
      stream,
      fits
        ? event
        : {
            requestId,
            result:
              operation === "act"
                ? {
                    code: "outcome-unknown",
                    kind: "error",
                    // The Host adds what an unconfirmed act means and what to do next.
                    message: "The observation after these actions was too large to return.",
                  }
                : {
                    code: "failed",
                    kind: "error",
                    message:
                      operation === "observe"
                        ? oversizedObservationSentence
                        : oversizedAnswerSentence,
                  },
            type: "runner.integrations.computer-use-result",
          },
    );
  }

  /** No desktop app here, so nothing is approved to run. */
  async #refuseMcp(sessionId: string): Promise<void> {
    const stream = this.#stream;
    if (!stream) return;
    await this.#send(stream, {
      error: {
        code: "unapproved",
        message: "MCP servers run only where the Opensteer desktop app approves them.",
      },
      sessionId,
      type: "runner.integrations.mcp.closed",
    });
  }

  async #send(stream: RunnerModuleStream, event: OutboundEvent): Promise<void> {
    if (this.#stream !== stream) return;
    const message = IntegrationsModuleEventSchema.parse({
      ...stream.fence,
      module: "integrations",
      ...event,
    });
    await stream.send(JSON.stringify(message), false);
  }

  #stopAttachedStream(): void {
    this.#video?.close();
    this.#video = undefined;
    this.#detachComputerUseEvents?.();
    this.#detachComputerUseEvents = undefined;
    this.#detachApprovalEvents?.();
    this.#detachApprovalEvents = undefined;
    this.#detachPasswordEvents?.();
    this.#detachPasswordEvents = undefined;
    this.#detachGrantEvents?.();
    this.#detachGrantEvents = undefined;
    this.#localMcp?.detach();
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = undefined;
    this.#stream = undefined;
    this.#lastStatus = undefined;
    this.#publishedStatus = undefined;
    for (const invoke of this.#inFlight.values()) {
      invoke.abort.abort(new Error("Computer app module detached"));
    }
    // The requests are gone; the work they started may not be. `#executing` is
    // deliberately left alone, so the next stream on this handler sees the
    // slots a provider that ignored its abort is still occupying.
    this.#inFlight.clear();
    // The socket owns even opens that have not answered yet. Ending it fences
    // that whole lifetime before a replacement stream can start work.
    this.#computerUse?.releaseSessions();
  }
}

/**
 * Starts the provider's work as a promise, so a provider that throws before its
 * first `await` still holds — and then releases — the slot it was given.
 */
async function invokeProvider(
  provider: ComputerAppProvider,
  message: HostIntegrationsInvoke,
  signal: AbortSignal,
  invocation: ComputerAppInvocation,
): Promise<ComputerAppValue> {
  return await provider.invoke(message.operation, message.arguments, signal, invocation);
}

/**
 * Whether a computer-use operation counts against the concurrency bound.
 *
 * `close` gives a Mac back; refusing it because the Mac is busy would keep a
 * session open for no gain.
 */
function occupiesSlot(operation: HostIntegrationsComputerUse["operation"]): boolean {
  return operation !== "close";
}

function unsupported(message: string): Result {
  return { code: "unsupported", kind: "error", message };
}

function boundedMessage(message: string): string {
  const trimmed = message.trim();
  return (trimmed || providerFailureSentence).slice(0, computerAppMessageMaxLength);
}

/**
 * A Mac's own sentence, passed through inside the bound its schema states
 * rather than replaced: `busy` saying another task holds the app, and
 * `app-not-allowed` naming why, are the whole value of those refusals.
 */
function boundedSentence(message: string): string {
  const trimmed = message.trim();
  return (trimmed || computerUseFailureSentence).slice(0, computerUseMessageMaxLength);
}

function rejectedWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
