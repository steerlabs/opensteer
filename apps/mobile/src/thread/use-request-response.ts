import type { CardChoice } from "@opensteer/protocol";
import {
  browserSiteLabel,
  browserSignInProblemMessage,
  HostClientRequestError,
  mutationIdempotencyKey,
  type HostClient,
  type PasswordSignInAccount,
  type SurfaceModel,
} from "@opensteer/client/host";
import { requestOptionDeclines, type RequestResponse } from "@opensteer/core";
import type { BrowserSignInDecision } from "@opensteer/protocol/browser-sources";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { authenticatePasswordApproval } from "./password-approval-auth.js";
import { nextRequestSubmission } from "./request-form-model.js";
import { updateRequestSession, useRequestSession, type RequestSession } from "./request-session.js";
import type { ThreadMutationGate } from "./thread-mutation-gate.js";

/**
 * Whatever went wrong, the answer may still have landed: a timeout or a lost
 * reply looks the same from here as a refusal that never reached the Host.
 */
export const unconfirmedDetail = "Could not confirm your answer was sent.";

function requestFailureDetail(error: unknown): string {
  return error instanceof HostClientRequestError
    ? operationDetail(error, unconfirmedDetail)
    : unconfirmedDetail;
}

export interface RequestResponder {
  /** The Host took an answer this client sent by its own command. */
  readonly admitted: () => void;
  readonly session: RequestSession;
  /** Choices and forms: a retry is only ever the response just chosen. */
  readonly submit: (response: RequestResponse, busyId: string) => Promise<void>;
  readonly respondSignIn: (decision: BrowserSignInDecision, busyId: string) => Promise<void>;
  readonly respondPassword: (approval?: {
    readonly account: PasswordSignInAccount | CardChoice;
    readonly remember: boolean;
  }) => Promise<void>;
  /** A step this client takes itself before the Host hears, under the same claim. */
  readonly attempt: (
    busyId: string,
    options: { readonly shareWithAi: boolean },
    act: () => Promise<void>,
    describe?: (error: unknown) => string,
  ) => Promise<void>;
}

/**
 * Sends a Request's answers from whichever surface holds it.
 *
 * A successful dispatch only means the Host admitted the answer; the Runner may
 * still fail to take it and leave the same Request pending. So nothing here
 * records "answered": the Request leaving the snapshot is what removes it.
 */
export function useRequestResponse(input: {
  readonly canRespond: boolean;
  /** Rechecks the Thread's own state at the tap boundary, before dispatch. */
  readonly canStartResponse: () => boolean;
  readonly gate: ThreadMutationGate;
  readonly hostClient: HostClient;
  /** The Host admitted the answer, so a sheet showing it can go. */
  readonly onAdmitted?: () => void;
  readonly surface: SurfaceModel;
}): RequestResponder {
  const { canRespond, canStartResponse, gate, hostClient, onAdmitted, surface } = input;
  const { request } = surface;
  const session = useRequestSession(request, hostClient.getSnapshot().user?.id ?? null);
  const aiSharing = useAiSharing();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const answerable = surface.denied === null && request.status === "pending";
  const stillAnswerable = useRef(answerable);
  stillAnswerable.current = answerable;

  const admitted = (): void => {
    if (mounted.current) onAdmitted?.();
  };

  const fail = (detail: string): void => {
    updateRequestSession(session, { failure: detail });
    if (!mounted.current) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    void AccessibilityInfo.announceForAccessibility(detail);
  };

  const attempt: RequestResponder["attempt"] = async (
    busyId,
    options,
    act,
    describe = requestFailureDetail,
  ) => {
    if (session.responding || !answerable || !canRespond || !canStartResponse()) return;
    if (options.shareWithAi && !(await authorizeAiSharing(aiSharing, hostClient))) return;
    if (!mounted.current || session.responding || !canStartResponse()) return;
    const claim = gate.acquire("request");
    if (claim === null) return;
    updateRequestSession(session, { failure: null, pendingId: busyId, responding: true });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await act();
    } catch (error) {
      fail(describe(error));
    } finally {
      gate.release(claim);
      updateRequestSession(session, { pendingId: null, responding: false });
    }
  };

  const submit: RequestResponder["submit"] = (response, busyId) => {
    const option =
      response.kind === "choice" && request.presentation.kind === "choice"
        ? request.presentation.options.find(({ id }) => id === response.optionId)
        : undefined;
    const declined =
      (response.kind === "external" && response.value?.["decision"] === "declined") ||
      (option !== undefined && requestOptionDeclines(option));
    return attempt(busyId, { shareWithAi: !declined }, async () => {
      const submission = nextRequestSubmission(session.held, response, () =>
        mutationIdempotencyKey(`request:${request.id}`),
      );
      session.held = submission;
      await hostClient.dispatch({
        idempotencyKey: submission.idempotencyKey,
        requestId: request.id,
        response: submission.response,
        type: "request.respond",
      });
      if (session.held === submission) session.held = null;
      admitted();
    });
  };

  // A sign-in has its own command: the answer names a Chrome and may need that
  // Chrome to finish, so the Host replies with what happened.
  const respondSignIn: RequestResponder["respondSignIn"] = (decision, busyId) => {
    const { payload } = request;
    if (payload.kind !== "browser.sign-in") return Promise.resolve();
    return attempt(busyId, { shareWithAi: decision.decision !== "decline" }, async () => {
      const signature = JSON.stringify(decision);
      if (session.heldSignIn?.signature !== signature) {
        session.heldSignIn = {
          key: mutationIdempotencyKey(`browser-sign-in:${request.id}`),
          signature,
        };
      }
      const held = session.heldSignIn;
      const domain = browserSiteLabel(payload.site);
      const result = await hostClient.dispatch({
        decision,
        idempotencyKey: held.key,
        requestId: request.id,
        type: "browser.sign-in.respond",
      });
      if (session.heldSignIn === held) session.heldSignIn = null;
      const outcome = result.type === "browser.sign-in.respond" ? result.outcome : null;
      if (
        outcome === null ||
        outcome.status === "applied" ||
        outcome.problem === "session-closed"
      ) {
        if (outcome !== null && mounted.current) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          void AccessibilityInfo.announceForAccessibility(
            outcome.status === "applied"
              ? `Signed in to ${domain} with ${outcome.sourceName}.`
              : `Allowed ${domain}.`,
          );
        }
        admitted();
        return;
      }
      if (outcome.problem === "chrome-offline") {
        updateRequestSession(session, { allowed: outcome });
        if (mounted.current) {
          void AccessibilityInfo.announceForAccessibility(
            `Allowed. Open Chrome on that computer and ${domain} finishes by itself.`,
          );
        }
        return;
      }
      fail(
        browserSignInProblemMessage(outcome.problem, {
          connectHere: false,
          context: "request",
          site: payload.site,
          sourceName: outcome.sourceName,
        }),
      );
    });
  };

  // Consent is authenticated on this device; credentials stay on the vault Mac.
  const respondPassword: RequestResponder["respondPassword"] = (approval) => {
    const { payload } = request;
    if (payload.kind !== "browser.password-sign-in") return Promise.resolve();
    let authenticated = approval === undefined;
    const busyId = approval
      ? approval.remember
        ? "password-allow"
        : "password-once"
      : "password-sign-in-decline";
    return attempt(
      busyId,
      { shareWithAi: approval !== undefined },
      async () => {
        session.heldPasswordKey ??= mutationIdempotencyKey(`password-sign-in:${request.id}`);
        if (
          approval &&
          !(await authenticatePasswordApproval(payload.credential === "card" ? "card" : "login"))
        )
          return;
        authenticated = true;
        if (!mounted.current || !stillAnswerable.current) return;
        const result = await hostClient.dispatch({
          idempotencyKey: session.heldPasswordKey,
          requestId: request.id,
          type: "browser.password-sign-in.respond",
          decision: approval
            ? "brand" in approval.account
              ? {
                  kind: "approve-card",
                  cardId: approval.account.id,
                  revision: approval.account.revision,
                  permissionVersion: 7,
                }
              : {
                  kind: "approve",
                  loginId: approval.account.id,
                  revision: approval.account.revision,
                  remember: approval.remember,
                  permissionVersion: 5,
                }
            : { kind: "decline" },
        });
        if (result.type !== "browser.password-sign-in.respond") return;
        updateRequestSession(session, {
          ...(result.message ? { failure: result.message } : {}),
          ...(result.status === "pending" ? { heldPasswordKey: null } : {}),
          passwordCard: result.card ?? session.passwordCard,
        });
        if (result.status !== "pending") admitted();
      },
      (error) =>
        !authenticated && error instanceof Error ? error.message : requestFailureDetail(error),
    );
  };

  return { admitted, attempt, respondPassword, respondSignIn, session, submit };
}
