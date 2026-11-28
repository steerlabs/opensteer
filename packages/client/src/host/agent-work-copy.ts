import { plainSentence, sentenceWith, type SentencePart } from "./sentence-parts.js";

/**
 * Every word the person reads about a connected agent's own work: its task, its operations,
 * the tab it uses, the Request it opens, and who it is. Web and phone both read these.
 * `{name}` marks a value filled in by `workSentence` (for outside names) or `workWords`
 * (for Opensteer's own words and numbers).
 */
export const agentWorkCopy = {
  "work.someAgent": "A connected agent",
  "work.startedBy": "started by {agent}",
  "work.working": "{agent} is working",
  "now.workingIn": "{agent} is working in {place}",
  "now.workingInPlaces": "{agent} is working in {count} places",
  "now.workingCount": "{count} agents working",
  "now.needsYouCount": "{count} agents need you",
  "now.alsoWorking": " · {count} working",
  "work.waiting": "{agent} needs you",
  "work.idle": "{agent} is idle",
  "work.stopped": "Stopped by you",
  "work.ended.done": "You marked this task Done",
  "work.ended.revoked": "Ended: {agent} was disconnected",
  "work.ended.expired": "Ended: {agent}’s access expired",
  "work.ended.narrowed": "Ended: {agent} can no longer use what this task used",
  "work.ended.idle": "Ended: {agent} went quiet",
  "work.stop": "Stop {agent}",
  "work.watch": "Watch {agent}",
  "work.review": "Review {agent}",
  "work.stopDetail": "Ends {agent}’s work on this task. It stays connected.",
  "work.noComposer": "{agent} works this task itself. You can’t write to it here.",
  "work.header": "Connected agent · {origin}",
  "work.headerLocal": "Connected agent · an app on this computer",
  "work.subtitle": "{agent} · {what}",
  "work.activity": "Activity",
  "now.row.needsYou": "Needs you",
  "now.row.working": "Working",
  "work.activityEmpty": "Nothing yet.",
  "work.activityUnavailable": "This Opensteer doesn’t list an agent’s actions yet.",
  "work.usingNow": "Using now",
  "work.openPlace": "Open {place}",

  "op.tab_list": "Listed tabs in {target}",
  "op.tab_open": "Opened a tab in {target}",
  "op.tab_close": "Closed a tab in {target}",
  "op.browser_use": "Ran a script on {target}",
  "op.computer_use": "Used {target}",
  "op.plugin_call": "Used {target}",
  "op.browser_connect": "Took direct control of {target}",
  "op.other": "Acted on {target}",
  "op.base.tab_list": "List tabs in {target}",
  "op.base.tab_open": "Open a tab in {target}",
  "op.base.tab_close": "Close a tab in {target}",
  "op.base.browser_use": "Run a script on {target}",
  "op.base.computer_use": "Use {target}",
  "op.base.plugin_call": "Use {target}",
  "op.base.browser_connect": "Take direct control of {target}",
  "op.base.other": "Act on {target}",
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
  "op.outcome.unknown": "Uncertain",
  "op.outcome.unknownDetail":
    "Opensteer lost contact before it heard back, so it can’t say whether this happened. Check before trying again.",
  "op.outcome.notSent": "Not sent",
  "op.unsent.stopped": "You stopped this before anything was sent.",
  "op.unsent.task-done": "You marked this task Done before anything was sent.",
  "op.unsent.disconnected": "You disconnected this agent before anything was sent.",
  "op.unsent.expired": "Its access expired before anything was sent.",
  "op.unsent.narrowed": "You changed its access before anything was sent.",
  "op.ending.stopped":
    "You stopped this while it ran. Part of it may have happened. Check before trying again.",
  "op.ending.task-done":
    "You marked this task Done while this ran. Part of it may have happened. Check before trying again.",
  "op.ending.disconnected":
    "You disconnected this agent while this ran. Part of it may have happened. Check before trying again.",
  "op.ending.expired":
    "Its access expired while this ran. Part of it may have happened. Check before trying again.",
  "op.ending.narrowed":
    "You changed its access while this ran. Part of it may have happened. Check before trying again.",
  "op.ending.tab-closed":
    "You closed this tab while it ran, so Opensteer can’t say whether this happened. Check before trying again.",
  "op.state.pending": "Waiting for you",
  "op.state.running": "Running…",
  "cmd.asked": "Waiting for you",
  "cmd.approved": "You approved it",
  "cmd.approvedThen": "You approved it · {outcome}",
  "cmd.declined": "You declined it",
  "cmd.withdrawn": "The agent took it back",
  "cmd.closed": "Closed",
  "op.calls": "What it ran",

  "tab.chromeTitle": "Chrome · {title}",
  "tab.chromeDetail": "Shared from {device}",
  "tab.chromeUsedBy": "Used by {names}",
  "tab.using": "{agent} is using this page for {task}",
  "tab.usingNoTask": "{agent} is using this page",
  "tab.shared": "You and {agent} are using this page, for {task}",
  "tab.sharedNoTask": "You and {agent} are using this page",
  "tab.stopped": "Stopped by you",
  "tab.stop": "Stop",
  "tab.needsYou": "{agent} needs you",
  "tab.answer": "Answer",

  "ask.sessionTitle": "Connected agent {agent} asks in {task}",
  "ask.sessionTitleUnnamed": "A connected agent asks in {task}",
  "ask.sessionTitleWithoutTask": "Question from a connected agent",
  "ask.title": "{agent}: {question}",
  "ask.listTitle": "{agent} · {question}",
  "ask.says": "{agent} says:",
  "ask.context": "{target} · {device}",
  "ask.calls": "Show exactly what it will run",
  "ask.hideCalls": "Hide what it will run",
  "ask.allow": "Allow once",
  "ask.deny": "Don’t allow",
  "ask.after": "{agent} is told your answer. Allowing this once doesn’t give it any more access.",
  "ask.expired": "This request expired. {agent} was told no one answered.",
  "ask.allowed": "You allowed this once.",
  "ask.denied": "You didn’t allow this.",
  "ask.withdrawn": "No longer needed.",
  "ask.openPage": "Open the page",
  "ask.withdrawn.stopped": "No longer needed: you stopped {agent}.",
  "ask.withdrawn.revoked": "No longer needed: {agent} was disconnected.",
  "ask.withdrawn.narrowed": "No longer needed: {agent} can no longer use {target}.",

  "who.selfAsserted": "says it is",
  "who.saysItIs": "Says it is {name}",
  "who.verifiedAs": "Verified: {name}",
  "who.verified": "Verified",
  "who.local": "an app on this computer",
  "who.consentWarning": "Only allow this if you started it yourself.",
  "who.withdrawn": "No longer verified since {date}.",
  "who.withdrawnDetail": "Check its last action or disconnect it.",
  "who.disconnect": "Disconnect",
  "who.consentHeading": "An agent wants to connect",
  "who.claim": "It calls itself: {name}",
  "who.namedOrigin": "{role}: {name} · {origin}",
  "who.redirectOrigin": "{role}: {origin}",
  "who.thisAgent": "This connected agent",
  "who.appAt": "An app at {host}",
  "who.localApp": "An app on this computer",
  "who.unnamed": "an app with no name",
  "who.origin.verified": "Holds the access",
  "who.origin.redirect": "Returns to",
  "who.yourName": "Your name for it",
} as const;

export type AgentWorkCopyId = keyof typeof agentWorkCopy;

type ForbiddenOutsideCopyKey = "agent" | "label" | "name" | "task";
const forbiddenOutsideCopyKeys = new Set<string>(["agent", "label", "name", "task"]);

export type SafeWorkCopyValues = Readonly<Record<string, string | number>> &
  Partial<Record<ForbiddenOutsideCopyKey, never>>;

function formatWorkCopy(
  id: AgentWorkCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return agentWorkCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * One string from `agentWorkCopy` for Opensteer's own words and numbers. Outside-name keys
 * (`agent`, `label`, `name`, `task`) are forbidden here: build those as parts with `workSentence`
 * so every surface quotes and isolates them (`SentenceText`, `phoneSentence`, `isolatedPlainSentence`).
 */
export function workWords(id: AgentWorkCopyId, values: SafeWorkCopyValues = {}): string {
  for (const key of Object.keys(values)) {
    if (forbiddenOutsideCopyKeys.has(key)) {
      throw new TypeError(
        `workWords("${id}") forbids outside-name key "${key}"; use workSentence instead.`,
      );
    }
  }
  return formatWorkCopy(id, values);
}

/**
 * A work-copy sentence with outside names as `SentencePart` slots (`{ name }` / `{ address }`)
 * so web (`SentenceText`), mobile (`phoneSentence`), and plain-text surfaces quote and isolate
 * outside names from Opensteer's own words.
 */
export function workSentence(
  id: AgentWorkCopyId,
  outside: Readonly<Record<string, SentencePart>>,
  values: Readonly<Record<string, string | number>> = {},
): readonly SentencePart[] {
  const words: Record<string, string | number> = { ...values };
  const parts: Record<string, { readonly name: string } | { readonly address: string }> = {};
  for (const [key, part] of Object.entries(outside))
    if (typeof part === "string") words[key] = part;
    else parts[key] = part;
  return sentenceWith(
    (slot) =>
      formatWorkCopy(id, {
        ...words,
        ...Object.fromEntries(Object.keys(parts).map((key) => [key, slot(key)])),
      }),
    parts,
  );
}

/** The same as plain text: each name cleaned and quoted. */
export function workText(
  id: AgentWorkCopyId,
  outside: Readonly<Record<string, SentencePart>>,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return plainSentence(workSentence(id, outside, values));
}
