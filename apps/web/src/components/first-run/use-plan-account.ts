import { useCallback } from "react";
import {
  mutationIdempotencyKey,
  nextAccountName,
  type HarnessSummary,
} from "@opensteer/client/host";
import type { AddHarnessAccount } from "../account-sign-in-dialog.js";
import { planSignInMethod, type SetupPlan } from "./setup-ai.js";

/** Adds an account for a plan whose engine has none yet, signing in with the plan's own way in. */
export function usePlanAccount(input: {
  readonly addHarnessAccount: ((account: AddHarnessAccount) => void) | null;
  readonly harnesses: readonly HarnessSummary[];
}) {
  const { addHarnessAccount, harnesses } = input;
  return useCallback(
    (candidate: SetupPlan, environmentId: string, whereLabel: string) => {
      const taken = harnesses
        .filter(
          (harness) =>
            harness.environmentId === environmentId && harness.driverKind === candidate.driverKind,
        )
        .map((harness) => harness.name);
      addHarnessAccount?.({
        request: {
          driverKind: candidate.driverKind,
          environmentId,
          idempotencyKey: mutationIdempotencyKey(`harness-create:${environmentId}:${candidate.id}`),
          name: nextAccountName(candidate.name, taken),
          sourceId: candidate.sourceId,
          stateKind: "isolated",
          type: "harness.create",
        },
        selectMethod: planSignInMethod,
        title: `Add ${candidate.name} account`,
        whereLabel,
      });
    },
    [addHarnessAccount, harnesses],
  );
}
