import {
  orgWords,
  workAuditExcluded,
  workAuditRecordKinds,
  workPolicyLines,
  type EffectiveWorkPolicy,
  type WorkAuditRecord,
} from "@opensteer/control-plane-protocol";
import type { ThreadAccessMode } from "@opensteer/core";
import type { AgentGrantDraft } from "./connected-agent-view.js";
import { workPolicyLimits } from "./work-policy-limits.js";

/**
 * A work Home, as the person who owns it reads it: whose it is, what that organization decided,
 * and what leaves the Home. A personal Home reports no policy and shows none of this.
 */
export const workHomeCopy = {
  "work.nav": "Your organization",
  "work.see.cannot": "{organization} can’t watch it, answer its Requests or act for you.",
  "work.policy.devices.cloud-computer-only": "Only this Cloud Computer",
  "work.policy.devices.assignee-may-enroll": "You may connect your own devices",
  "work.enroll.notAllowed": "{organization} doesn’t allow other devices to join this work Home.",
  "work.enroll.joining":
    "This device is joining a work Home owned by {organization}. {organization} will see that it joined, never what’s on it.",
} as const;

export function workHomeWords(
  id: keyof typeof workHomeCopy,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return workHomeCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * The record kinds in the person's own voice, where the shared words speak of "the person" from
 * the organization's side. Any kind not listed here keeps the shared words.
 */
const recordWordsForThePerson: Readonly<Partial<Record<WorkAuditRecord["kind"], string>>> = {
  "owner.signed_in": "You signed in",
  "owner.signed_out": "You signed out",
};
const sharedRecordWords = new Map(workAuditRecordKinds.map(({ kind, words }) => [kind, words]));

/** What one record kind says on the Home: to the person, or in the shared words. */
export function workRecordWords(kind: WorkAuditRecord["kind"]): string | null {
  return recordWordsForThePerson[kind] ?? sharedRecordWords.get(kind) ?? null;
}

/** The quiet mark beside the Home's name, and the way to what its organization can see. */
export interface WorkHomeMark {
  readonly organization: string;
  /** "Work · Acme" */
  readonly badge: string;
  /** "What Acme can see" */
  readonly seeTitle: string;
  /** Where Settings lists that page, short whatever the organization is called. */
  readonly navLabel: string;
}

export function workHomeMark(policy: EffectiveWorkPolicy | null | undefined): WorkHomeMark | null {
  if (!policy) return null;
  const organization = policy.organizationName;
  return {
    organization,
    badge: orgWords("org.work.badge", { organization }),
    seeTitle: orgWords("org.work.see.title", { organization }),
    navLabel: workHomeWords("work.nav"),
  };
}

/** "What {organization} can see": short enough to read in a minute. */
export interface WorkHomeSeeView {
  readonly title: string;
  readonly lead: string;
  readonly decides: {
    readonly title: string;
    readonly rows: readonly { readonly title: string; readonly value: string }[];
    readonly version: string;
  };
  readonly sees: {
    readonly title: string;
    readonly items: readonly string[];
    readonly recordsTitle: string;
    /** Exactly the record kinds this Home sends, in the words each kind is given. */
    readonly records: readonly string[];
  };
  readonly never: { readonly title: string; readonly items: readonly string[] };
}

export function workHomeSeeView(policy: EffectiveWorkPolicy): WorkHomeSeeView {
  const organization = policy.organizationName;
  const [mode, tasks, everything] = workPolicyLines(policy);
  return {
    title: orgWords("org.work.see.title", { organization }),
    lead: `${orgWords("org.work.see.lead", { organization })} ${workHomeWords("work.see.cannot", { organization })}`,
    decides: {
      title: orgWords("org.work.policy", { organization }),
      rows: [
        ...[mode!, tasks!, everything!].map(({ title, value }) => ({ title, value })),
        {
          title: orgWords("org.policy.devices.title"),
          value: workHomeWords(`work.policy.devices.${policy.devices}`),
        },
      ],
      version: orgWords("org.policy.revision", { revision: policy.appliedRevision }),
    },
    sees: {
      title: orgWords("org.work.see.sees", { organization }),
      items: [orgWords("org.work.see.status"), orgWords("org.work.see.policy")],
      recordsTitle: orgWords("org.work.see.records"),
      records: policy.auditRecordKinds.flatMap((kind) => {
        const said = workRecordWords(kind);
        return said ? [said] : [];
      }),
    },
    never: {
      title: orgWords("org.work.see.never", { organization }),
      items: [...workAuditExcluded, orgWords("org.work.see.personal")],
    },
  };
}

/** Why another device can't be added here, or null where the policy allows it. */
export function workDeviceLimit(policy: EffectiveWorkPolicy | null | undefined): string | null {
  return policy?.devices === "cloud-computer-only" ? orgWords("org.work.notAllowed") : null;
}

type WorkEnrollmentPolicy = Pick<EffectiveWorkPolicy, "organizationName" | "devices">;

/** Said on a device that would join, when the policy keeps it out. */
export function workEnrollRefusal(policy: WorkEnrollmentPolicy | null | undefined): string | null {
  return policy?.devices === "cloud-computer-only"
    ? workHomeWords("work.enroll.notAllowed", { organization: policy.organizationName })
    : null;
}

/** Said on the enrolling device before it joins, when it may. */
export function workEnrollNotice(policy: WorkEnrollmentPolicy | null | undefined): string | null {
  return policy?.devices === "assignee-may-enroll"
    ? workHomeWords("work.enroll.joining", { organization: policy.organizationName })
    : null;
}

/**
 * A consent's choices as a work Home's policy allows them now: a choice a newer version rules
 * out falls back to the nearest one it allows (Supervised, Choose, no Tasks), so Allow never
 * asks for what the Home would refuse. What the person picked is kept, so a looser version
 * brings it back.
 */
export function withinWorkPolicy<
  Choice extends { readonly draft: AgentGrantDraft; readonly mode: ThreadAccessMode },
>(choice: Choice, policy: EffectiveWorkPolicy | null | undefined): Choice {
  if (!policy) return choice;
  const limits = workPolicyLimits(policy);
  const mode = limits.mode(choice.mode) === null ? choice.mode : "approval-required";
  let draft = choice.draft;
  if (draft.scope === "everything" && limits.everything !== null)
    draft = { ...draft, scope: "selected" };
  if (draft.tasks && limits.tasks !== null) draft = { ...draft, tasks: false };
  return mode === choice.mode && draft === choice.draft ? choice : { ...choice, draft, mode };
}
