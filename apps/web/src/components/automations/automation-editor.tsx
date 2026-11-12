import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import {
  conversationName,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type ThreadSummary,
  type TriggerDetail,
} from "@opensteer/client/host";
import {
  triggerProgramContract,
  type TriggerProgram,
  type TriggerSource,
} from "@opensteer/triggers";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { actionErrorMessage, automationPath } from "../../ui-utils.js";
import { describeRepeating } from "@opensteer/client/host";
import { AreaLink, useAreaNavigate } from "../workspace/area-link.js";

interface Draft {
  anchorThreadId: string;
  at: string;
  expression: string;
  kind: "schedule" | "webhook" | "watch";
  language: "javascript" | "typescript";
  name: string;
  scheduleKind: "at" | "cron";
  source: string;
  timezone: string;
  toolContractVersion: TriggerProgram["toolContractVersion"];
}

/**
 * Routed page for changing an automation's program by hand, at
 * `/automations/:triggerId/edit`. Most people never come here; they ask their agent in a task.
 */
export function AutomationEditorPage() {
  const { triggerId = "" } = useParams();
  const { hostClient, openMobileNavigation } = useShell();
  const [editing, setEditing] = useState<TriggerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void hostClient.rpc["triggers.get"]({ triggerId })
      .then((result) => {
        if (current) setEditing(unwrapRpcResult(result));
      })
      .catch((reason: unknown) => {
        if (current) setLoadError(actionErrorMessage(reason));
      });
    return () => {
      current = false;
    };
  }, [hostClient, triggerId]);

  const back = (
    <AreaLink className="page__back" to={automationPath(triggerId)}>
      <Icon name="arrow-left" />
      {editing?.trigger.name ?? "Automation"}
    </AreaLink>
  );
  return (
    <div className="page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Edit code" />
      <div className="page__inner">
        <PageHeader back={back} description="Changes apply from its next run." title="Edit code" />
        {loadError ? (
          <p aria-live="assertive" className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <span>{loadError}</span>
          </p>
        ) : null}
        {!editing && !loadError ? (
          <div className="automations-list">
            <LoadingRows label="Loading automation" />
          </div>
        ) : null}
        {editing?.trigger.systemRole != null ? (
          <p className="card__empty">
            Opensteer manages this memory pass. You can inspect it and pause or resume it from its
            automation page. To stop remembering, ask your agent.
          </p>
        ) : null}
        {editing?.trigger.status === "archived" ? (
          <p className="card__empty">This automation was deleted, so it can’t be changed.</p>
        ) : null}
        {editing && editing.trigger.systemRole == null && editing.trigger.status !== "archived" ? (
          <EditorForm editing={editing} key={editing.revision.id} />
        ) : null}
      </div>
    </div>
  );
}

function EditorForm({ editing }: { readonly editing: TriggerDetail }) {
  const { hostClient, snapshot } = useShell();
  const navigate = useAreaNavigate();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(editing));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const program: TriggerProgram = {
        language: draft.language,
        source: draft.source,
        toolContractVersion: draft.toolContractVersion,
      };
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`trigger-update:${editing.trigger.id}`),
        input: {
          expectedRevisionId: editing.revision.id,
          name: draft.name.trim(),
          program,
          source: sourceFrom(draft, editing),
        },
        triggerId: editing.trigger.id,
        type: "trigger.update",
      });
      void navigate(automationPath(editing.trigger.id));
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setPending(false);
    }
  };

  const conversations = snapshot.threads.filter(({ id }) => id === editing.trigger.anchorThreadId);
  return (
    <form className="section" onSubmit={(event) => void save(event)}>
      <div className="card">
        <div className="card__form">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="text-input"
              maxLength={160}
              onChange={(event) => set("name", event.target.value)}
              placeholder="Reminder: buy groceries"
              required
              value={draft.name}
            />
          </label>
          <label className="field">
            <span className="field__label">Conversation</span>
            <select className="select-input" disabled value={draft.anchorThreadId}>
              {conversations.length === 0 ? (
                <option value={editing.trigger.anchorThreadId}>{editing.anchorThreadTitle}</option>
              ) : null}
              {conversations.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {conversationLabel(thread)}
                </option>
              ))}
            </select>
            <span className="field__hint">
              It runs on this conversation’s computer and talks to you there.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Runs</span>
            <select className="select-input" disabled value={draft.kind}>
              <option value="schedule">On a schedule</option>
              <option value="webhook">When its webhook is called</option>
              <option value="watch">Continuously, watching for changes</option>
            </select>
          </label>
          {draft.kind === "schedule" ? (
            <ScheduleFields draft={draft} set={set} />
          ) : draft.kind === "webhook" ? null : (
            <p className="field__hint">
              The program keeps running on the conversation’s computer and must not return.
            </p>
          )}
          <label className="field">
            <span className="field__label">Language</span>
            <select
              className="select-input"
              onChange={(event) => set("language", event.target.value as Draft["language"])}
              value={draft.language}
            >
              <option value="typescript">TypeScript</option>
              <option value="javascript">JavaScript</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">Program</span>
            <textarea
              className="code-editor"
              onChange={(event) => set("source", event.target.value)}
              required
              spellCheck={false}
              value={draft.source}
            />
          </label>
          <details className="automation-contract">
            <summary>How programs run</summary>
            <p>{triggerProgramContract}</p>
          </details>
        </div>
      </div>
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="form-actions">
        <AreaLink className="btn" to={automationPath(editing.trigger.id)}>
          Cancel
        </AreaLink>
        <button className="btn btn--primary" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function ScheduleFields({
  draft,
  set,
}: {
  readonly draft: Draft;
  readonly set: <Key extends keyof Draft>(key: Key, value: Draft[Key]) => void;
}) {
  return (
    <>
      <label className="field">
        <span className="field__label">Schedule</span>
        <select
          className="select-input"
          onChange={(event) => set("scheduleKind", event.target.value as Draft["scheduleKind"])}
          value={draft.scheduleKind}
        >
          <option value="at">Once, at a set time</option>
          <option value="cron">Repeating</option>
        </select>
      </label>
      {draft.scheduleKind === "at" ? (
        <label className="field">
          <span className="field__label">Time</span>
          <input
            className="text-input"
            onChange={(event) => set("at", event.target.value)}
            required
            type="datetime-local"
            value={draft.at}
          />
        </label>
      ) : (
        <>
          <label className="field">
            <span className="field__label">Cron expression</span>
            <input
              className="text-input"
              onChange={(event) => set("expression", event.target.value)}
              placeholder="0 9 * * 1-5"
              required
              spellCheck={false}
              value={draft.expression}
            />
            <span aria-live="polite" className="field__hint">
              {draft.expression.trim()
                ? describeRepeating({
                    expression: draft.expression.trim(),
                    kind: "cron",
                    timezone: draft.timezone.trim() || browserTimeZone(),
                  })
                : "Minute, hour, day of month, month and day of week."}
            </span>
          </label>
          <label className="field">
            <span className="field__label">Time zone</span>
            <input
              className="text-input"
              onChange={(event) => set("timezone", event.target.value)}
              required
              spellCheck={false}
              value={draft.timezone}
            />
          </label>
        </>
      )}
    </>
  );
}

function conversationLabel(thread: ThreadSummary): string {
  return conversationName(thread.title);
}

function sourceFrom(draft: Draft, editing: TriggerDetail): TriggerSource {
  if (draft.kind === "webhook") return { kind: "webhook" };
  if (draft.kind === "watch") return { kind: "watch" };
  // A schedule's payload is not editable here; editing keeps what it carried.
  const previous =
    editing.revision.source.kind === "schedule" ? editing.revision.source.schedule : null;
  const payload = previous?.payload === undefined ? {} : { payload: previous.payload };
  if (draft.scheduleKind === "at") {
    return {
      kind: "schedule",
      schedule: { at: new Date(draft.at).toISOString(), kind: "at", ...payload },
    };
  }
  return {
    kind: "schedule",
    schedule: {
      expression: draft.expression.trim(),
      kind: "cron",
      timezone: draft.timezone.trim(),
      ...payload,
    },
  };
}

function draftFrom(detail: TriggerDetail): Draft {
  const schedule =
    detail.revision.source.kind === "schedule" ? detail.revision.source.schedule : null;
  return {
    anchorThreadId: detail.trigger.anchorThreadId,
    at: schedule?.kind === "at" ? toLocalDateTime(schedule.at) : defaultAt(),
    expression: schedule?.kind === "cron" ? schedule.expression : "0 9 * * *",
    kind: detail.trigger.kind,
    language: detail.revision.program.language,
    name: detail.trigger.name,
    scheduleKind: schedule?.kind ?? "cron",
    source: detail.revision.program.source,
    timezone: schedule?.kind === "cron" ? schedule.timezone : browserTimeZone(),
    toolContractVersion: detail.revision.program.toolContractVersion,
  };
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function defaultAt(): string {
  return toLocalDateTime(new Date(Date.now() + 60 * 60 * 1_000).toISOString());
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
