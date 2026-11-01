import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router";
import {
  HostClientRequestError,
  conversationName,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
  type TriggerDetail,
} from "@opensteer/client/host";
import {
  triggerOccurrenceErrorMessage,
  type TriggerOccurrence,
  type TriggerSummary,
} from "@opensteer/triggers";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { Popover } from "../popover.js";
import { useToast } from "../toast.js";
import { actionErrorMessage, conversationPath, useMinuteClock } from "../../ui-utils.js";
import {
  automationShape,
  runOutcome,
  scheduleStatusWord,
  describeEvent,
  describeRepeating,
  formatFullMoment,
  formatCountdown,
  formatMoment,
  latestRun,
  placeAutomation,
  watchState,
  type Tone,
} from "@opensteer/client/host";
import { machineOf } from "./automations-page.js";
import { AreaLink, useAreaNavigate } from "../workspace/area-link.js";

/** What the editor hands the page after creating a webhook: shown once, never again. */
export interface CreatedWebhook {
  readonly secret: string;
  readonly triggerId: string;
  readonly url: string;
}

/** Routed page for one automation: what it does, when, how it has gone, and its controls. */
export function AutomationDetailPage() {
  const { triggerId = "" } = useParams();
  return <AutomationDetail key={triggerId} triggerId={triggerId} />;
}

function AutomationDetail({ triggerId }: { readonly triggerId: string }) {
  const { hostClient, openMobileNavigation, snapshot } = useShell();
  const location = useLocation();
  const now = useMinuteClock();
  const [detail, setDetail] = useState<TriggerDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const runs = useMemo(
    () => triggerRunLifecycleSignature(snapshot),
    [snapshot.runQueue, snapshot.threads],
  );

  // Everything below is read again whenever a Trigger changes or one of the
  // Runs it started moves on, so the page never shows an outcome that is over.
  useEffect(() => {
    let current = true;
    void hostClient.rpc["triggers.get"]({ triggerId })
      .then((result) => {
        if (!current) return;
        setDetail(unwrapRpcResult(result));
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        if (reason instanceof HostClientRequestError && reason.code === "not_found") {
          setMissing(true);
        } else setError(actionErrorMessage(reason));
      });
    return () => {
      current = false;
    };
  }, [attempt, hostClient, runs, snapshot.triggerRevision, triggerId]);

  const webhookState = location.state as { readonly webhook?: CreatedWebhook } | null;
  const webhook = webhookState?.webhook?.triggerId === triggerId ? webhookState.webhook : null;

  return (
    <div className="page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Automation" />
      <div className="page__inner">
        {missing ? (
          <>
            <PageHeader back={<BackToAutomations />} title="Automation not found" />
            <p className="card__empty">
              It was deleted, or it belongs to someone else. Its messages stay in their
              conversation.
            </p>
          </>
        ) : null}
        {error && !detail ? (
          <>
            <PageHeader back={<BackToAutomations />} title="Automation" />
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
          </>
        ) : null}
        {!detail && !missing && !error ? (
          <>
            <PageHeader back={<BackToAutomations />} title="Automation" />
            <div className="automations-list">
              <LoadingRows label="Loading automation" />
            </div>
          </>
        ) : null}
        {detail ? (
          <AutomationView
            client={hostClient}
            detail={detail}
            homeThreadId={snapshot.homeThreadId}
            machine={machineOf(snapshot, detail.trigger.anchorThreadId)}
            now={now}
            onChanged={setDetail}
            webhook={webhook}
          />
        ) : null}
      </div>
    </div>
  );
}

function BackToAutomations() {
  return (
    <AreaLink className="page__back" to="/automations">
      <Icon name="arrow-left" />
      Automations
    </AreaLink>
  );
}

/** The detail as a list row would describe it, so both say the same thing. */
function summaryOf(detail: TriggerDetail): TriggerSummary {
  const latest = detail.occurrences[0];
  return {
    ...detail.trigger,
    anchorThreadTitle: detail.anchorThreadTitle,
    latestOccurrence: latest
      ? {
          completedAt: latest.completedAt,
          createdAt: latest.createdAt,
          error: triggerOccurrenceErrorMessage(latest.error),
          id: latest.id,
          source: latest.event.source.kind,
          status: latest.status,
        }
      : null,
    source: detail.revision.source,
    watch: detail.activation
      ? { lastError: detail.activation.lastError, observed: detail.activation.observed }
      : null,
  };
}

function AutomationView({
  client,
  detail,
  homeThreadId,
  machine,
  now,
  onChanged,
  webhook,
}: {
  readonly client: HostClient;
  readonly detail: TriggerDetail;
  readonly homeThreadId: string | null;
  readonly machine: string | null;
  readonly now: number;
  readonly onChanged: (detail: TriggerDetail) => void;
  readonly webhook: CreatedWebhook | null;
}) {
  const navigate = useAreaNavigate();
  const toast = useToast();
  const { trigger } = detail;
  const summary = summaryOf(detail);
  const shape = automationShape(detail.revision.source);
  const archived = trigger.status === "archived";
  const placement = archived ? null : placeAutomation(summary, now);
  const problem = placement?.problem ?? null;
  const schedule =
    detail.revision.source.kind === "schedule" ? detail.revision.source.schedule : null;
  const onceAt = schedule?.kind === "at" ? schedule.at : null;
  const elapsed = onceAt !== null && Date.parse(onceAt) <= now;
  const [pending, setPending] = useState(false);
  const [changingTime, setChangingTime] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const conversation = conversationPath(trigger.anchorThreadId, homeThreadId);
  const conversationTitle = conversationName(
    trigger.anchorThreadId,
    detail.anchorThreadTitle,
    homeThreadId,
  );

  const refresh = useCallback(async () => {
    onChanged(unwrapRpcResult(await client.rpc["triggers.get"]({ triggerId: trigger.id })));
  }, [client, onChanged, trigger.id]);

  const act = async (work: () => Promise<string | null>) => {
    setPending(true);
    try {
      const done = await work();
      if (done) toast.success(done);
    } catch (reason) {
      toast.error(actionErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const setStatus = (status: "active" | "paused") =>
    act(async () => {
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-status:${trigger.id}`),
        status,
        triggerId: trigger.id,
        type: "trigger.status.set",
      });
      await refresh();
      return status === "active" ? "Resumed" : "Paused";
    });

  const runNow = () =>
    act(async () => {
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-run:${trigger.id}`),
        payload: { requestedFrom: "web" },
        triggerId: trigger.id,
        type: "trigger.run",
      });
      await refresh();
      return "Running now";
    });

  const cancelRun = (occurrenceId: string) =>
    act(async () => {
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-cancel:${trigger.id}`),
        occurrenceId,
        triggerId: trigger.id,
        type: "trigger.cancel",
      });
      await refresh();
      return "Canceled";
    });

  const remove = () =>
    act(async () => {
      setConfirmingDelete(false);
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-status:${trigger.id}`),
        status: "archived",
        triggerId: trigger.id,
        type: "trigger.status.set",
      });
      void navigate("/automations");
      return `Deleted “${trigger.name}”`;
    });

  // Choosing a new time is choosing that it should go off: a paused one is
  // resumed with it.
  const changeTime = (at: string) =>
    act(async () => {
      if (!schedule || schedule.kind !== "at") return null;
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-update:${trigger.id}`),
        input: {
          expectedRevisionId: detail.revision.id,
          source: { kind: "schedule", schedule: { ...schedule, at } },
        },
        triggerId: trigger.id,
        type: "trigger.update",
      });
      if (trigger.status === "paused") {
        await client.dispatch({
          idempotencyKey: mutationIdempotencyKey(`trigger-status:${trigger.id}`),
          status: "active",
          triggerId: trigger.id,
          type: "trigger.status.set",
        });
      }
      await refresh();
      setChangingTime(false);
      return `Moved to ${formatMoment(at, Date.now(), true)}`;
    });

  const canResume = trigger.status === "paused" && !(shape === "once" && elapsed);
  const canPause = trigger.status === "active" && shape !== "once";
  const canRun = shape !== "watch";

  return (
    <>
      <PageHeader
        back={<BackToAutomations />}
        description={statusSentence({ detail, machine, now, problem, shape })}
        title={trigger.name}
      />

      {webhook ? <WebhookReady webhook={webhook} /> : null}

      {problem ? (
        <ProblemNotice
          conversation={conversation}
          conversationTitle={conversationTitle}
          detail={detail}
          problem={problem}
        />
      ) : null}

      {archived ? null : (
        <div className="automation-actions">
          {shape === "once" ? (
            <button
              aria-expanded={changingTime}
              className={`btn btn--small${problem ? " btn--primary" : ""}`}
              disabled={pending}
              onClick={() => setChangingTime(!changingTime)}
              type="button"
            >
              <Icon name="clock" /> Change time
            </button>
          ) : null}
          {canResume ? (
            <button
              className={`btn btn--small${problem ? " btn--primary" : ""}`}
              disabled={pending}
              onClick={() => void setStatus("active")}
              type="button"
            >
              Resume
            </button>
          ) : null}
          {canRun ? (
            <button
              className="btn btn--small"
              disabled={pending}
              onClick={() => void runNow()}
              type="button"
            >
              Run now
            </button>
          ) : null}
          {canPause ? (
            <button
              className="btn btn--small"
              disabled={pending}
              onClick={() => void setStatus("paused")}
              type="button"
            >
              Pause
            </button>
          ) : null}
          <button
            aria-haspopup="dialog"
            className="btn btn--small btn--ghost btn--danger"
            disabled={pending}
            onClick={() => setConfirmingDelete(true)}
            ref={deleteRef}
            type="button"
          >
            Delete
          </button>
          {confirmingDelete && deleteRef.current ? (
            <Popover
              anchor={deleteRef.current}
              className="automation-confirm"
              label={`Delete ${trigger.name}?`}
              onClose={() => setConfirmingDelete(false)}
              role="dialog"
            >
              <p className="automation-confirm__question">Delete “{trigger.name}”?</p>
              <p className="automation-confirm__detail">
                It won’t run again, and this can’t be undone. What it already said stays in its
                conversation.
              </p>
              <div className="automation-confirm__actions">
                <button
                  className="btn btn--small btn--ghost"
                  data-autofocus
                  onClick={() => setConfirmingDelete(false)}
                  type="button"
                >
                  Keep it
                </button>
                <button
                  className="btn btn--small btn--danger"
                  onClick={() => void remove()}
                  type="button"
                >
                  Delete
                </button>
              </div>
            </Popover>
          ) : null}
        </div>
      )}

      {changingTime && onceAt !== null ? (
        <ChangeTimeForm
          current={onceAt}
          now={now}
          onCancel={() => setChangingTime(false)}
          onSave={(at) => void changeTime(at)}
          pending={pending}
        />
      ) : null}

      <dl className="automation-facts">
        <div className="automation-facts__row">
          <dt>When</dt>
          <dd>
            <When detail={detail} machine={machine} now={now} shape={shape} />
          </dd>
        </div>
        <div className="automation-facts__row">
          <dt>Conversation</dt>
          <dd>
            <AreaLink className="automation-facts__link" to={conversation}>
              <Icon name="message" />
              {conversationTitle}
            </AreaLink>
            <span className="automation-facts__note">Where it runs and talks to you</span>
          </dd>
        </div>
        {machine ? (
          <div className="automation-facts__row">
            <dt>Computer</dt>
            <dd>{machine}</dd>
          </div>
        ) : null}
        <div className="automation-facts__row">
          <dt>Created</dt>
          <dd>{formatMoment(trigger.createdAt, now)}</dd>
        </div>
        {trigger.createdByThreadId !== null ? (
          <div className="automation-facts__row">
            <dt>Created by</dt>
            <dd>
              <AreaLink
                className="automation-facts__link"
                to={conversationPath(trigger.createdByThreadId, homeThreadId)}
              >
                <Icon name="message" />
                {conversationName(
                  trigger.createdByThreadId,
                  detail.createdByThreadTitle ?? "Untitled thread",
                  homeThreadId,
                )}
              </AreaLink>
            </dd>
          </div>
        ) : null}
      </dl>

      {shape === "watch" ? null : (
        <RecentRuns
          detail={detail}
          disabled={pending || archived}
          homeThreadId={homeThreadId}
          now={now}
          onCancel={(occurrenceId) => void cancelRun(occurrenceId)}
        />
      )}

      <Advanced archived={archived} detail={detail} shape={shape} />
    </>
  );
}

/**
 * One sentence under the title: how this automation behaves, so a first-time
 * reader learns what it will do. When something is wrong, the notice below
 * says what; this sentence still says what the automation is.
 */
function statusSentence(input: {
  readonly detail: TriggerDetail;
  readonly machine: string | null;
  readonly now: number;
  readonly problem: string | null;
  readonly shape: ReturnType<typeof automationShape>;
}): string {
  const { detail, machine, now, problem, shape } = input;
  const { trigger } = detail;
  const latest = detail.occurrences[0];
  const source = detail.revision.source;
  if (trigger.status === "archived") {
    return shape === "once" && latest?.status === "succeeded"
      ? `It ran ${formatMoment(latest.completedAt ?? latest.createdAt, now, true)} and is finished.`
      : "It was deleted and won’t run again.";
  }
  if (latest?.status === "pending" || latest?.status === "running") {
    const run = latestRun(summaryOf(detail).latestOccurrence, now);
    if (run?.text === "Waiting for its computer") return "Waiting for its computer to run it.";
    if (run) return `${run.text}.`;
  }
  if (problem && source.kind === "schedule" && source.schedule.kind === "at") {
    return `It was due ${formatMoment(source.schedule.at, now, true)}.`;
  }
  if (trigger.status === "paused") {
    return trigger.pauseReason
      ? `${scheduleStatusWord(trigger.status, trigger.pauseReason)}.`
      : "Paused. It won’t run until you resume it.";
  }
  if (source.kind === "webhook") return "It runs each time its webhook is called.";
  if (source.kind === "watch") {
    return machine
      ? `It keeps running on ${machine}, watching for changes.`
      : "It keeps running, watching for changes.";
  }
  return source.schedule.kind === "cron"
    ? "It runs on its schedule until you pause or delete it."
    : "It runs once, then it’s done.";
}

/** What went wrong, the program's own words for it, and where Opensteer can help fix it. */
function ProblemNotice({
  conversation,
  conversationTitle,
  detail,
  problem,
}: {
  readonly conversation: string;
  readonly conversationTitle: string;
  readonly detail: TriggerDetail;
  readonly problem: string;
}) {
  const latest = detail.occurrences[0];
  const reported =
    detail.activation?.lastError ??
    (latest?.status === "failed" ? triggerOccurrenceErrorMessage(latest.error) : null);
  return (
    <div className="notice notice--error automation-problem" role="status">
      <Icon name="alert-circle" />
      <div className="automation-problem__body">
        <p className="automation-problem__what">{problem}</p>
        {reported ? <pre className="automation-problem__error">{reported.trim()}</pre> : null}
        <p className="automation-problem__help">
          Ask Opensteer in <AreaLink to={conversation}>{conversationTitle}</AreaLink> to look into
          it, or change it here.
        </p>
      </div>
    </div>
  );
}

/** When it runs, in words, with the next time when there is one. */
function When({
  detail,
  machine,
  now,
  shape,
}: {
  readonly detail: TriggerDetail;
  readonly machine: string | null;
  readonly now: number;
  readonly shape: ReturnType<typeof automationShape>;
}) {
  const source = detail.revision.source;
  const next = detail.trigger.nextFireAt;
  if (source.kind === "schedule" && source.schedule.kind === "at") {
    const countdown =
      detail.trigger.nextFireAt === null ? null : formatCountdown(detail.trigger.nextFireAt, now);
    return (
      <>
        <time dateTime={source.schedule.at} title={formatFullMoment(source.schedule.at)}>
          Once, {formatMoment(source.schedule.at, now, true)}
        </time>
        {countdown ? <span className="automation-facts__note">{countdown}</span> : null}
      </>
    );
  }
  if (source.kind === "schedule" && source.schedule.kind === "cron") {
    return (
      <>
        {describeRepeating(source.schedule)}
        {next ? (
          <span className="automation-facts__note">
            Next{" "}
            <time dateTime={next} title={formatFullMoment(next)}>
              {formatMoment(next, now, true)}
            </time>
          </span>
        ) : null}
      </>
    );
  }
  if (shape === "watch" && detail.activation) {
    const state = watchState(detail.activation.observed);
    return (
      <>
        {describeEvent("watch", machine)}
        <span className="automation-facts__note">
          <State text={state.text} tone={state.tone} />
        </span>
      </>
    );
  }
  return <>{describeEvent(shape === "watch" ? "watch" : "webhook", machine)}</>;
}

function State({ text, tone }: { readonly text: string; readonly tone: Tone }) {
  return (
    <span className={`automation-state automation-state--${tone}`}>
      <span aria-hidden className="automation-state__dot" />
      {text}
    </span>
  );
}

/** The new time for a one-time automation, chosen in the reader's own clock. */
function ChangeTimeForm({
  current,
  now,
  onCancel,
  onSave,
  pending,
}: {
  readonly current: string;
  readonly now: number;
  readonly onCancel: () => void;
  readonly onSave: (at: string) => void;
  readonly pending: boolean;
}) {
  const [value, setValue] = useState(() =>
    toLocalInput(Date.parse(current) > now ? Date.parse(current) : nextHour(now)),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) {
      setInvalid("Choose a date and time.");
      return;
    }
    if (at.getTime() <= Date.now()) {
      setInvalid("Choose a time that hasn’t passed yet.");
      return;
    }
    setInvalid(null);
    onSave(at.toISOString());
  };
  return (
    // The picker greys out the past; the form says why a past time is refused
    // in its own words rather than the browser's.
    <form className="automation-time" noValidate onSubmit={submit}>
      <label className="field">
        <span className="field__label">New time</span>
        <input
          aria-describedby={invalid ? "automation-time-error" : undefined}
          aria-invalid={invalid !== null}
          className="text-input"
          min={toLocalInput(now)}
          onChange={(event) => setValue(event.currentTarget.value)}
          required
          type="datetime-local"
          value={value}
        />
      </label>
      <div className="automation-time__actions">
        <button className="btn btn--small btn--ghost" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="btn btn--small btn--primary" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save time"}
        </button>
      </div>
      {invalid ? (
        <p className="form-actions__error" id="automation-time-error" role="alert">
          {invalid}
        </p>
      ) : null}
    </form>
  );
}

function nextHour(now: number): number {
  const date = new Date(now + 60 * 60 * 1_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** A `datetime-local` value: the reader's wall clock, to the minute. */
function toLocalInput(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Each run, newest first: when, how it went, and where Opensteer answered.
 * A run that is still waiting can be canceled; the program's raw output is
 * folded under each run for whoever wants it.
 */
function RecentRuns({
  detail,
  disabled,
  homeThreadId,
  now,
  onCancel,
}: {
  readonly detail: TriggerDetail;
  readonly disabled: boolean;
  readonly homeThreadId: string | null;
  readonly now: number;
  readonly onCancel: (occurrenceId: string) => void;
}) {
  return (
    <section aria-labelledby="automation-runs" className="automations-group">
      <h2 className="automations-group__title" id="automation-runs">
        Recent runs
      </h2>
      <div className="automations-list">
        {detail.occurrences.length === 0 ? (
          <p className="automations-list__empty">It hasn’t run yet.</p>
        ) : (
          detail.occurrences.map((occurrence) => (
            <RunRow
              disabled={disabled}
              downstream={detail.downstreamRuns.filter(
                ({ occurrenceId }) => occurrenceId === occurrence.id,
              )}
              homeThreadId={homeThreadId}
              key={occurrence.id}
              now={now}
              occurrence={occurrence}
              onCancel={onCancel}
            />
          ))
        )}
      </div>
    </section>
  );
}

const runGlyph = {
  canceled: { icon: "close", tone: "muted" },
  failed: { icon: "alert-circle", tone: "bad" },
  pending: { icon: "clock", tone: "warn" },
  running: { icon: "activity", tone: "accent" },
  succeeded: { icon: "check-circle", tone: "ok" },
} as const satisfies Record<TriggerOccurrence["status"], { icon: string; tone: Tone }>;

function RunRow({
  disabled,
  downstream,
  homeThreadId,
  now,
  occurrence,
  onCancel,
}: {
  readonly disabled: boolean;
  readonly downstream: TriggerDetail["downstreamRuns"];
  readonly homeThreadId: string | null;
  readonly now: number;
  readonly occurrence: TriggerOccurrence;
  readonly onCancel: (occurrenceId: string) => void;
}) {
  const glyph = runGlyph[occurrence.status];
  const reply = downstream[0];
  const error = triggerOccurrenceErrorMessage(occurrence.error);
  const output = runOutput(occurrence);
  const started = occurrence.event.source.kind === "manual" ? "You ran it" : null;
  return (
    <div className="automation-run">
      <span className={`automation-run__glyph automation-run__glyph--${glyph.tone}`}>
        <Icon name={glyph.icon} />
      </span>
      <div className="automation-run__body">
        <span className="automation-run__head">
          <time dateTime={occurrence.createdAt} title={formatFullMoment(occurrence.createdAt)}>
            {formatMoment(occurrence.createdAt, now)}
          </time>
          {started ? <span className="automation-run__source">{started}</span> : null}
        </span>
        <span className="automation-run__outcome">
          {runOutcome(
            occurrence,
            reply ? conversationName(reply.run.threadId, reply.threadTitle, homeThreadId) : null,
            reply?.run.status ?? null,
            now,
          )}
          {error ? <q className="automation-run__error">{error.trim().split("\n", 1)[0]}</q> : null}
        </span>
        {output ? (
          <details className="automation-run__output">
            <summary>Output</summary>
            <pre>{output}</pre>
          </details>
        ) : null}
      </div>
      {reply ? (
        <AreaLink
          className="btn btn--small btn--ghost"
          to={conversationPath(reply.run.threadId, homeThreadId, reply.run.seedInputId)}
        >
          Open
        </AreaLink>
      ) : null}
      {occurrence.status === "pending" ? (
        <button
          className="btn btn--small"
          disabled={disabled}
          onClick={() => onCancel(occurrence.id)}
          type="button"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

/** The program's own output, for the curious: what it printed, returned or threw. */
function runOutput(occurrence: TriggerOccurrence): string | null {
  const parts = [
    occurrence.stdout.trim(),
    occurrence.stderr.trim(),
    occurrence.result === null ? "" : JSON.stringify(occurrence.result, null, 2),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * The program, its logs and code editing: everything a reader never needs to
 * understand what an automation does, folded away for those who want it.
 */
function Advanced({
  archived,
  detail,
  shape,
}: {
  readonly archived: boolean;
  readonly detail: TriggerDetail;
  readonly shape: ReturnType<typeof automationShape>;
}) {
  const { activation, revision } = detail;
  return (
    <details className="automation-advanced">
      <summary>
        Advanced
        <span className="automation-advanced__hint">Its program, logs and code</span>
      </summary>
      <div className="automation-advanced__body">
        <div className="automation-advanced__head">
          <span>
            {revision.program.language === "typescript" ? "TypeScript" : "JavaScript"} program,
            version {revision.ordinal}
          </span>
          {archived ? null : (
            <AreaLink
              className="btn btn--small"
              to={`/automations/${encodeURIComponent(detail.trigger.id)}/edit`}
            >
              <Icon name="pencil" /> Edit code
            </AreaLink>
          )}
        </div>
        <pre className="automation-advanced__code">{revision.program.source}</pre>
        {shape === "watch" && activation ? (
          <>
            <p className="automation-advanced__head">
              Restarted {activation.restartCount} {activation.restartCount === 1 ? "time" : "times"}
            </p>
            {activation.stdoutTail ? (
              <>
                <p className="automation-advanced__label">Latest output</p>
                <pre className="automation-advanced__code">{activation.stdoutTail}</pre>
              </>
            ) : null}
            {activation.stderrTail ? (
              <>
                <p className="automation-advanced__label">Latest errors</p>
                <pre className="automation-advanced__code">{activation.stderrTail}</pre>
              </>
            ) : null}
          </>
        ) : null}
        {shape === "webhook" ? (
          <p className="automation-advanced__label">
            Its webhook address and secret were shown once, when it was created.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function WebhookReady({ webhook }: { readonly webhook: CreatedWebhook }) {
  return (
    <section aria-labelledby="automation-webhook" className="automations-group">
      <h2 className="automations-group__title" id="automation-webhook">
        Webhook ready
      </h2>
      <div className="automations-list automation-webhook">
        <p className="automations-list__empty">
          Copy both now: the secret isn’t shown again. Send it as a Bearer token with each request.
        </p>
        <CopyRow label="Address" value={webhook.url} />
        <CopyRow label="Secret" value={webhook.secret} />
      </div>
    </section>
  );
}

function CopyRow({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="automation-copy">
      <span className="automation-copy__label">{label}</span>
      <div className="copy-row">
        <code>{value}</code>
        <button
          aria-label={`Copy ${label}`}
          className="icon-btn"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            });
          }}
          type="button"
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
    </div>
  );
}

/**
 * What changes when a Run an automation started moves on: Run and Thread
 * statuses, not streaming metadata, so the detail is read again only when an
 * outcome it shows could have changed.
 */
export function triggerRunLifecycleSignature(
  snapshot: Pick<HostSnapshot, "runQueue" | "threads">,
): string {
  return JSON.stringify({
    runs: snapshot.runQueue
      .map(({ id, status, threadId }) => ({ id, status, threadId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    threads: snapshot.threads
      .map(({ id, status }) => ({ id, status }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}
