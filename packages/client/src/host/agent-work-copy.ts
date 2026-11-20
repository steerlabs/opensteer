/**
 * Every word the person reads about a connected agent's own work: its task, its operations,
 * the tab it uses, the Request it opens, and who it is. Web and phone both read these.
 * `{name}` marks a value filled in by `workWords`.
 */
export const agentWorkCopy = {
  "work.someAgent": "A connected agent",
  "work.working": "{agent} is working",
  "work.waiting": "{agent} needs you",
  "work.idle": "{agent} is idle",
  "work.stopped": "Stopped by you",
  "work.ended.revoked": "Ended: {agent} was disconnected",
  "work.ended.expired": "Ended: {agent}’s access expired",
  "work.ended.narrowed": "Ended: {agent} can no longer use what this task used",
  "work.ended.idle": "Ended: {agent} went quiet",
  "work.stop": "Stop {agent}",
  "work.stopDetail": "Ends {agent}’s work on this task. It stays connected.",
  "work.noComposer": "{agent} works this task itself. You can’t write to it here.",
  "work.header": "Connected agent · {origin}",
  "work.headerLocal": "Connected agent · an app on this computer",
  "work.subtitle": "{agent} · {what}",
  "work.activity": "Activity",
  "work.activityEmpty": "Nothing yet.",
  "work.activityUnavailable": "This Opensteer doesn’t list an agent’s actions yet.",

  "op.tab_list": "Listed tabs in {target}",
  "op.tab_open": "Opened a tab in {target}",
  "op.tab_close": "Closed a tab in {target}",
  "op.browser_use": "Ran a script on {target}",
  "op.computer_use": "Used {target}",
  "op.plugin_call": "Used {target}",
  "op.other": "{tool} on {target}",
  "op.onDevice": "{action} on {device}",
  "op.by.structural-read": "Reading only",
  "op.by.full-access": "Full access",
  "op.by.reviewer": "Allowed by Auto",
  "op.by.person": "Allowed by you",
  "op.refused.person": "You didn’t allow it",
  "op.refused.other": "Not allowed: {message}",
  "op.outcome.completed": "Done",
  "op.outcome.failed": "Failed",
  "op.outcome.refused": "Not allowed",
  "op.outcome.unknown": "Outcome unknown",
  "op.outcome.unknownDetail":
    "Opensteer lost contact before it heard back, so it can’t say whether this happened. Check before trying again.",
  "op.state.pending": "Waiting for you",
  "op.state.running": "Running…",
  "op.calls": "What it ran",

  "tab.using": "{agent} is using this page for “{task}”",
  "tab.usingNoTask": "{agent} is using this page",
  "tab.shared": "You and {agent} are using this page, for “{task}”",
  "tab.sharedNoTask": "You and {agent} are using this page",
  "tab.stopped": "Stopped by you",

  "ask.title": "{agent}: {question}",
  "ask.says": "{agent} says (its own words, not checked):",
  "ask.calls": "Show exactly what it will run",
  "ask.hideCalls": "Hide what it will run",
  "ask.allow": "Allow once",
  "ask.deny": "Don’t allow",
  "ask.after": "{agent} is told your answer. Allowing this once doesn’t give it any more access.",
  "ask.expired": "This request expired. {agent} was told no one answered.",
  "ask.allowed": "You allowed this once.",
  "ask.denied": "You didn’t allow this.",
  "ask.withdrawn": "No longer needed.",
  "ask.withdrawn.stopped": "No longer needed: you stopped {agent}.",
  "ask.withdrawn.revoked": "No longer needed: {agent} was disconnected.",
  "ask.withdrawn.narrowed": "No longer needed: {agent} can no longer use {target}.",

  "who.selfAsserted": "says it is",
  "who.local": "an app on this computer",
  "who.consentWarning": "Only approve if you started this yourself.",
  "who.withdrawn": "No longer verified since {date}",
  "who.withdrawnDetail":
    "Opensteer no longer lists {agent} as verified. Disconnect it unless you trust it.",
  "who.disconnect": "Disconnect",
} as const;

export type AgentWorkCopyId = keyof typeof agentWorkCopy;

export function workWords(
  id: AgentWorkCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return agentWorkCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}
