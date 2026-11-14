import type { NativeCompactionActivity } from "@opensteer/core";

export const idleCompactionTitle = "Summarize long Claude conversations";
export const idleCompactionChoices = [
  {
    value: "onReturn",
    label: "When you return",
    description: "Offer to summarize before your next message.",
  },
  {
    value: "beforeCacheExpires",
    label: "While you're away (Beta)",
    description:
      "Summarize before Claude's temporary cache expires. Uses Claude while you're away and may reduce later usage.",
  },
  {
    value: "off",
    label: "Never",
    description: "Keep full context until Claude needs to summarize.",
  },
] as const;
export const idleCompactionHelp =
  "Claude will use a shorter summary and may miss earlier details. Your messages remain readable.";
export const compactionOfferText =
  "This long conversation has been idle. Summarizing may reduce usage as you continue.";
export const compactionDisclosure =
  "Claude will use a shorter summary for future replies. Earlier messages are still here.";
export function compactionLabel(activity: NativeCompactionActivity): string {
  switch (activity.status) {
    case "running":
      return "Summarizing conversation…";
    case "failed":
      return "Couldn't create summary";
    case "stopped":
      return "Summary stopped";
    case "created":
      return (
        "Summary created" +
        (activity.reason === "idle"
          ? " · While you were away"
          : activity.reason === "before-send"
            ? " · Before your message"
            : "")
      );
  }
}

export function compactionHintRevision(
  hint: import("@opensteer/core").CompactionReturnHint | null | undefined,
  scope: string,
): string {
  return JSON.stringify(["compaction", scope, hint?.sessionRevision, hint?.sourceRunId]);
}
export function compactionOfferVisible(
  hint: import("@opensteer/core").CompactionReturnHint | null | undefined,
  hidden: boolean,
  now: number,
): boolean {
  return hint?.eligible === true && !hidden && now >= hint.eligibleAt;
}
export function scheduleCompactionReveal(
  hint: import("@opensteer/core").CompactionReturnHint | null | undefined,
  hidden: boolean,
  reveal: (now: number) => void,
): () => void {
  if (!hint?.eligible || hidden || Date.now() >= hint.eligibleAt) return () => {};
  let timer: ReturnType<typeof setTimeout>;
  const wake = () => {
    const now = Date.now();
    if (now >= hint.eligibleAt) reveal(now);
    else timer = setTimeout(wake, Math.min(hint.eligibleAt - now, 2_147_483_647));
  };
  timer = setTimeout(wake, Math.min(hint.eligibleAt - Date.now(), 2_147_483_647));
  return () => clearTimeout(timer);
}
