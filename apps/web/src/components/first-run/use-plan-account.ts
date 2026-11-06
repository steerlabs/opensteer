import { useCallback, useEffect, useRef, useState } from "react";
import {
  mutationIdempotencyKey,
  type HarnessSummary,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import type { HostApiCommandInput } from "@opensteer/protocol";
import type { HarnessAuthenticationOptions } from "../harness-authentication-dialog.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { createdHarnessSignInAction, nextAccountName } from "../settings/sections/ai-engines.js";
import { planSignInMethod, type SetupPlan } from "./setup-ai.js";

/** How long a new account may take to report its catalog before setup stops waiting. */
const accountSettleMilliseconds = 60_000;

/**
 * Adds an account for a plan whose engine has none yet, then opens its own
 * sign-in the moment the account can take one — the same hand-over Settings →
 * AI does, minus the choice of source, because the plan already made it.
 */
export function usePlanAccount(input: {
  readonly client: HostClient;
  readonly harnesses: readonly HarnessSummary[];
  readonly onAuthenticate:
    ((placement: ThreadPlacementOption, options?: HarnessAuthenticationOptions) => void) | null;
  readonly placements: readonly ThreadPlacementOption[];
}) {
  const { client, harnesses, onAuthenticate, placements } = input;
  const [adding, setAdding] = useState<{
    readonly planId: string;
    readonly harnessId: string | null;
  } | null>(null);
  const [error, setError] = useState<{ readonly planId: string; readonly message: string } | null>(
    null,
  );
  // A retry sends the exact original request, so a lost answer never makes a second account.
  const attempts = useRef(
    new Map<string, Extract<HostApiCommandInput, { type: "harness.create" }>>(),
  );
  // Set in the effect itself: StrictMode runs it, cleans it up and runs it
  // again, and a flag only ever cleared would ignore every answer after that.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const add = useCallback(
    (candidate: SetupPlan, environmentId: string) => {
      if (adding) return;
      setError(null);
      const taken = harnesses
        .filter(
          (harness) =>
            harness.environmentId === environmentId && harness.driverKind === candidate.driverKind,
        )
        .map((harness) => harness.name);
      const key = `${environmentId}:${candidate.id}`;
      const request =
        attempts.current.get(key) ??
        ({
          driverKind: candidate.driverKind,
          environmentId,
          idempotencyKey: mutationIdempotencyKey(`harness-create:${environmentId}:${candidate.id}`),
          name: nextAccountName(candidate.name, taken),
          sourceId: candidate.sourceId,
          stateKind: "isolated",
          type: "harness.create",
        } satisfies Extract<HostApiCommandInput, { type: "harness.create" }>);
      attempts.current.set(key, request);
      setAdding({ harnessId: null, planId: candidate.id });
      void client.dispatch(request).then(
        (result) => {
          if (!live.current) return;
          if (result.type !== "harness.create") throw new Error("AI account create mismatch.");
          attempts.current.delete(key);
          setAdding({ harnessId: result.harness.id, planId: candidate.id });
        },
        (reason: unknown) => {
          if (!live.current) return;
          setAdding(null);
          setError({ message: actionErrorMessage(reason), planId: candidate.id });
        },
      );
    },
    [adding, client, harnesses],
  );

  // Once the new account reports in, hand it to its sign-in, or stop if it is
  // already usable (a sign-in the Runner already recognises).
  useEffect(() => {
    if (!adding?.harnessId) return;
    const placement = placements.find(
      (candidate) => candidate.harnessInstanceId === adding.harnessId,
    );
    const action = createdHarnessSignInAction(placement, onAuthenticate !== null);
    if (action === "wait") return;
    setAdding(null);
    if (action === "complete" || action === "models") return;
    // Only the plan's own sign-in; an account that offers nothing but a key
    // is not what the person asked for, and Settings → AI explains it.
    const methodId = placement ? planSignInMethod(placement) : undefined;
    if (action === "authenticate" && placement && onAuthenticate && methodId) {
      onAuthenticate(placement, { methodId });
      return;
    }
    setError({
      message: placement?.detail || "This AI couldn’t get ready. Try again from Settings → AI.",
      planId: adding.planId,
    });
  }, [adding, onAuthenticate, placements]);

  useEffect(() => {
    if (!adding) return;
    const current = adding;
    const timer = setTimeout(() => {
      setAdding((value) => (value === current ? null : value));
      setError({
        message: "This AI is taking longer than expected. Try again.",
        planId: current.planId,
      });
    }, accountSettleMilliseconds);
    return () => clearTimeout(timer);
  }, [adding]);

  return { add, adding: adding?.planId ?? null, error };
}
