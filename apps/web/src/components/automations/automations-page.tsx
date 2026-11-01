import { useEffect, useState } from "react";
import { conversationName, unwrapRpcResult, type HostSnapshot } from "@opensteer/client/host";
import type { TriggerSummary } from "@opensteer/triggers";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { actionErrorMessage, automationPath, useMinuteClock } from "../../ui-utils.js";
import {
  automationGlyph,
  automationShape,
  describeEvent,
  describeRepeating,
  formatCountdown,
  formatFullMoment,
  formatMoment,
  latestRun,
  sectionAutomations,
  watchState,
  type Tone,
} from "@opensteer/client/host";
import { AreaLink } from "../workspace/area-link.js";

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
      <div className="page__inner">
        <div className="automations-head">
          <PageHeader
            description="Reminders and routines Opensteer runs on its own. Ask Opensteer to add or change one."
            title="Automations"
          />
          <div className="automations-head__actions">
            <AreaLink className="btn btn--ghost btn--small" to="/automations/new">
              <Icon name="code" /> Write code
            </AreaLink>
            <button
              className="btn btn--primary btn--small"
              onClick={() => writeInChat("")}
              type="button"
            >
              <Icon name="message" /> Ask Opensteer
            </button>
          </div>
        </div>

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
              <h2 className="automations-group__title" id={titleId}>
                {section.title}
                <span className="automations-group__count">{section.items.length}</span>
              </h2>
              <div className="automations-list">
                {section.items.map(({ problem, summary }) => (
                  <AutomationRow
                    homeThreadId={snapshot.homeThreadId}
                    key={summary.id}
                    machine={machineOf(snapshot, summary.anchorThreadId)}
                    now={now}
                    problem={problem}
                    summary={summary}
                  />
                ))}
              </div>
              {section.id === "upcoming" ? (
                <p className="automations-group__hint">
                  Once a one-time automation has run, it leaves this list. What it said stays in its
                  conversation.
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
 * One automation, read left to right: what kind it is, its name, where it
 * talks to you and how it last went, and when it runs next. Paused ones fade
 * rather than gaining another label; trouble shows as what went wrong.
 */
function AutomationRow({
  homeThreadId,
  machine,
  now,
  problem,
  summary,
}: {
  readonly homeThreadId: string | null;
  readonly machine: string | null;
  readonly now: number;
  readonly problem: string | null;
  readonly summary: TriggerSummary;
}) {
  const shape = automationShape(summary.source);
  const paused = summary.status === "paused" && !problem;
  const run = latestRun(summary.latestOccurrence, now);
  const detail = problem
    ? (summary.watch?.lastError ?? summary.latestOccurrence?.error ?? null)
    : null;
  return (
    <AreaLink
      className={`automation-row${problem ? " automation-row--attention" : ""}${paused ? " automation-row--paused" : ""}`}
      to={automationPath(summary.id)}
    >
      <span
        className={`automation-row__glyph${shape === "once" && !problem && !paused ? " automation-row__glyph--once" : ""}`}
      >
        <Icon name={problem ? "alert-circle" : automationGlyph[shape]} />
      </span>
      <span className="automation-row__body">
        <span className="automation-row__name">{summary.name}</span>
        <span className="automation-row__line">
          {problem ? (
            <span className="automation-row__problem">
              {problem}
              {detail ? <q>{firstLine(detail)}</q> : null}
            </span>
          ) : (
            <>
              {summary.source.kind === "schedule" && summary.source.schedule.kind === "cron" ? (
                <span>{describeRepeating(summary.source.schedule)}</span>
              ) : null}
              {shape === "webhook" || shape === "watch" ? (
                <span>{describeEvent(shape, machine)}</span>
              ) : null}
              {paused &&
              summary.source.kind === "schedule" &&
              summary.source.schedule.kind === "at" ? (
                <span>Set for {formatMoment(summary.source.schedule.at, now, true)}</span>
              ) : null}
              <span className="automation-row__where">
                <Icon name="message" />
                {conversationName(summary.anchorThreadId, summary.anchorThreadTitle, homeThreadId)}
              </span>
              {run && !paused && shape !== "once" ? (
                <State text={run.text} tone={run.tone} />
              ) : null}
            </>
          )}
        </span>
      </span>
      <AutomationWhen now={now} paused={paused || problem !== null} summary={summary} />
      <Icon className="automation-row__chevron" name="chevron-right" />
    </AreaLink>
  );
}

/** The right-hand column: the next time it runs, or what it is doing now. */
function AutomationWhen({
  now,
  paused,
  summary,
}: {
  readonly now: number;
  readonly paused: boolean;
  readonly summary: TriggerSummary;
}) {
  if (paused) return <span />;
  if (summary.watch && summary.kind === "watch") {
    const state = watchState(summary.watch.observed);
    return (
      <span className="automation-when">
        <State text={state.text} tone={state.tone} />
      </span>
    );
  }
  const latest = summary.latestOccurrence;
  const active = latest?.status === "running" || latest?.status === "pending";
  if (summary.nextFireAt) {
    const countdown = formatCountdown(summary.nextFireAt, now);
    const once = summary.source.kind === "schedule" && summary.source.schedule.kind === "at";
    return (
      <span className="automation-when">
        <time
          className="automation-when__time"
          dateTime={summary.nextFireAt}
          title={formatFullMoment(summary.nextFireAt)}
        >
          {formatMoment(summary.nextFireAt, now)}
        </time>
        <span className="automation-when__caption">
          {once ? (countdown ?? "") : active ? "Running now" : "Next run"}
        </span>
      </span>
    );
  }
  if (active) {
    const run = latestRun(latest, now);
    return (
      <span className="automation-when">
        <span className="automation-when__time">Now</span>
        {run ? <span className="automation-when__caption">{run.text}</span> : null}
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
