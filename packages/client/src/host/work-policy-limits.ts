import { threadAccessModeAtMost, type ThreadAccessMode } from "@opensteer/core";
import {
  orgWords,
  workPolicyAllowsGrant,
  type WorkPolicy,
} from "@opensteer/control-plane-protocol";

/**
 * What a work Home's policy rules out where a person grants an agent access, each with
 * the reason shown beside the choice; null where the choice is open. Consent and the
 * grant editor take the Home's effective policy when it reports one. Without one (every
 * Home today, and every personal Home always) nothing is ruled out.
 */
export interface WorkPolicyLimits {
  mode(mode: ThreadAccessMode): string | null;
  readonly everything: string | null;
  readonly tasks: string | null;
}

const open: WorkPolicyLimits = { mode: () => null, everything: null, tasks: null };

export function workPolicyLimits(policy: WorkPolicy | undefined): WorkPolicyLimits {
  if (!policy) return open;
  const notAllowed = orgWords("org.work.notAllowed");
  return {
    mode: (mode) => (threadAccessModeAtMost(mode, policy.externalMaxMode) ? null : notAllowed),
    everything: workPolicyAllowsGrant(policy, { scope: "everything" }) ? null : notAllowed,
    tasks: workPolicyAllowsGrant(policy, { scope: "selected", tasks: true }) ? null : notAllowed,
  };
}
