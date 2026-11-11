import { useEffect, useState } from "react";
import {
  automationGlyph,
  automationName,
  automationShape,
  conversationName,
  describeCadence,
  formatFullMoment,
  formatMoment,
  formatNextRun,
  latestRun,
  sectionAutomations,
  taskMark,
  threadInDirectory,
  threadMark,
  unwrapRpcResult,
  watchState,
  type HostSnapshot,
  type Tone,
} from "@opensteer/client/host";
import type { TriggerSummary } from "@opensteer/triggers";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageTopbar } from "../page-header.js";
import { actionErrorMessage, automationPath, useMinuteClock } from "../../ui-utils.js";
import { AreaLink } from "../workspace/area-link.js";
import { AgentOrb, TaskMark } from "../workspace/task-mark.js";

/** Requests a first-time reader can send as written, to see what an automation is. */
const examples = [
  "Remind me at 6 PM to buy groceries",
  "Every weekday at 8 AM, summarize my unread email",
  "Check this page every morning and tell me when the price drops",
] as const;

/** Routed page listing what Opensteer does on its own, grouped by what each needs from you. */
export function AutomationsPage() {
  const { hostClient, openMobileNavigation, snapshot, writeInChat } = useShell();
  const now = useMinuteClock();
  const [summaries, setSummaries] = useState<readonly TriggerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void hostClient.rpc["triggers.list"]({})
      .then((result) => {
        if (!current) return;
        setSummaries(unwrapRpcResult(result).triggers);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (current) setError(actionErrorMessage(reason));
      });
    return () => {
      current = false;
    };
  }, [attempt, hostClient, snapshot.triggerRevision]);

  const sections = summaries ? sectionAutomations(summaries, now) : [];
  return (
    <div className="page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Automations" />
      <div className="page__inner automations-page">
        <header className="automations-head">
          <h1 className="page__title">Automations</h1>
          <button
            className="btn btn--primary btn--small"
            onClick={() => writeInChat("")}
            title="Ask Opensteer in Chat for something to happen on its own"
            type="button"
          >
            <Icon name="plus" /> New
          </button>
        </header>

        {error ? (
          <p aria-live="assertive" className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <span>{error}</span>
            <button
              className="btn btn--small"
              onClick={() => setAttempt((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
          </p>
        ) : null}

        {summaries === null && !error ? (
          <div className="automations-list">
            <LoadingRows label="Loading automations" />
          </div>
        ) : null}

        {summaries?.length === 0 ? <FirstAutomation onWrite={writeInChat} /> : null}

        {sections.map((section) => {
          const titleId = `automations-${section.id}`;
          return (
            <section aria-labelledby={titleId} className="automations-group" key={section.id}>
              <h2
                className={`automations-group__title${section.id === "attention" ? " automations-group__title--attention" : ""}`}
                id={titleId}
              >
                {section.title}
                <span className="automations-group__count">{section.items.length}</span>
              </h2>
              <div
                className={`automations-list${section.id === "attention" ? " automations-list--attention" : ""}${section.id === "system" ? " automations-list--quiet" : ""}`}
              >
                {section.items.map(({ item, problem }) => (
                  <AutomationRow
                    key={item.id}
                    machine={machineOf(snapshot, item.anchorThreadId)}
                    now={now}
                    problem={problem}
                    snapshot={snapshot}
                    summary={item}
                  />
                ))}
              </div>
              {section.id === "upcoming" ? (
                <p className="automations-group__hint">
                  Once a one-time automation has run, it leaves this list. What it said stays in its
                  conversation.
                </p>
              ) : section.id === "system" ? (
                <p className="automations-group__hint">
                  Opensteer’s own upkeep. What it learns reaches you in Chat.
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** An empty page is the place to learn what an automation is: by asking for one. */
function FirstAutomation({ onWrite }: { readonly onWrite: (text: string) => void }) {
  return (
    <section aria-labelledby="automations-first" className="automations-first">
      <h2 className="automations-first__title" id="automations-first">
        Nothing scheduled yet
      </h2>
      <p className="automations-first__text">
        Ask Opensteer to remind you of something, do a task on a schedule, or keep an eye on
        something for you. It messages you when there is something to say.
      </p>
      <div className="automations-list">
        {examples.map((example) => (
          <button
            className="automation-row automation-row--example"
            key={example}
            onClick={() => onWrite(example)}
            type="button"
          >
            <span className="automation-row__glyph">
              <Icon name="message" />
            </span>
            <span className="automation-row__name">{example}</span>
            <span className="automation-row__hint">Ask Opensteer</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * One automation in two lines: its name, then how often it runs and where it
 * talks to you. The right column says when it runs next. A healthy run says
 * nothing; trouble shows as what went wrong, and paused ones fade.
 */
function AutomationRow({
  machine,
  now,
  problem,
  snapshot,
  summary,
}: {
  readonly machine: string | null;
  readonly now: number;
  readonly problem: string | null;
  readonly snapshot: HostSnapshot;
  readonly summary: TriggerSummary;
}) {
  const shape = automationShape(summary.source);
  const paused = summary.status === "paused" && !problem;
  const system = summary.systemRole != null;
  const run = latestRun(summary.latestOccurrence, now);
  const detail = problem
    ? (summary.watch?.lastError ?? summary.latestOccurrence?.error ?? null)
    : null;
  const glyph = problem
    ? " automation-row__glyph--attention"
    : system
      ? " automation-row__glyph--system"
      : shape === "once" && !paused
        ? " automation-row__glyph--once"
        : "";
  return (
    <AreaLink
      className={`automation-row${problem ? " automation-row--attention" : ""}${paused ? " automation-row--paused" : ""}`}
      to={automationPath(summary.id)}
    >
      <span className={`automation-row__glyph${glyph}`}>
        <Icon
          name={
            problem
              ? "alert-circle"
              : summary.systemRole === "memory-nightly"
                ? "moon"
                : system
                  ? "sparkles"
                  : automationGlyph[shape]
          }
        />
      </span>
      <span className="automation-row__body">
        <span className="automation-row__name">{automationName(summary)}</span>
        <span className="automation-row__line">
          {problem ? (
            <span className="automation-row__problem">
              {problem}
              {detail ? <q>{firstLine(detail)}</q> : null}
            </span>
          ) : (
            <>
              <span>
                {paused &&
                summary.source.kind === "schedule" &&
                summary.source.schedule.kind === "at"
                  ? `Set for ${formatMoment(summary.source.schedule.at, now, true)}`
                  : describeCadence(summary.source, machine)}
              </span>
              {system ? null : <Where snapshot={snapshot} summary={summary} />}
              {run && !paused && (run.tone === "bad" || run.tone === "warn") ? (
                <State text={run.text} tone={run.tone} />
              ) : null}
            </>
          )}
        </span>
      </span>
      {problem ? (
        <span className="automation-row__fix">Fix</span>
      ) : (
        <AutomationWhen now={now} paused={paused} summary={summary} />
      )}
    </AreaLink>
  );
}

/** Where it talks to you, by the mark the sidebar gives that conversation. */
function Where({
  snapshot,
  summary,
}: {
  readonly snapshot: HostSnapshot;
  readonly summary: TriggerSummary;
}) {
  const home = summary.anchorThreadId === snapshot.homeThreadId;
  const thread = threadInDirectory(summary.anchorThreadId, snapshot);
  return (
    <span className="automation-row__where">
      {home ? (
        <AgentOrb size={16} />
      ) : (
        <TaskMark
          mark={thread ? taskMark(thread) : threadMark(summary.anchorThreadId, snapshot)}
          size={16}
        />
      )}
      {conversationName(summary.anchorThreadId, summary.anchorThreadTitle, snapshot.homeThreadId)}
    </span>
  );
}

/** The right-hand column: when it runs next, or what it is doing now. */
function AutomationWhen({
  now,
  paused,
  summary,
}: {
  readonly now: number;
  readonly paused: boolean;
  readonly summary: TriggerSummary;
}) {
  if (paused) {
    return (
      <span className="automation-when">
        <span className="automation-when__caption">Paused</span>
      </span>
    );
  }
  if (summary.watch && summary.kind === "watch") {
    const state = watchState(summary.watch.observed);
    return (
      <span className="automation-when">
        <State text={state.text} tone={state.tone === "ok" ? "accent" : state.tone} />
      </span>
    );
  }
  const latest = summary.latestOccurrence;
  if (latest?.status === "running" || latest?.status === "pending") {
    const run = latestRun(latest, now);
    return (
      <span className="automation-when">
        {run ? <State text={run.text} tone={run.tone} /> : null}
      </span>
    );
  }
  if (summary.nextFireAt) {
    const next = formatNextRun(summary.nextFireAt, now);
    const soon = Date.parse(summary.nextFireAt) - now < 60 * 60_000;
    return (
      <span className="automation-when" title={formatFullMoment(summary.nextFireAt)}>
        <time
          className={`automation-when__time${soon ? " automation-when__time--soon" : ""}`}
          dateTime={summary.nextFireAt}
        >
          {next.day}
        </time>
        <span className="automation-when__caption">{next.time}</span>
      </span>
    );
  }
  return <span />;
}

function State({ text, tone }: { readonly text: string; readonly tone: Tone }) {
  return (
    <span className={`automation-state automation-state--${tone}`}>
      <span aria-hidden className="automation-state__dot" />
      {text}
    </span>
  );
}

/** The computer an automation runs on: its conversation's work location. */
export function machineOf(
  snapshot: Pick<HostSnapshot, "environments" | "threads">,
  anchorThreadId: string,
): string | null {
  const environmentId = snapshot.threads.find(({ id }) => id === anchorThreadId)?.environmentId;
  return snapshot.environments.find(({ id }) => id === environmentId)?.name ?? null;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}
