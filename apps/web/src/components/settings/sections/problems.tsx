import { useState } from "react";
import { harnessCatalogEntry } from "@opensteer/core";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { ProblemReporting } from "@opensteer/protocol";
import { problemTable, type Problem } from "@opensteer/protocol/problems";
import { Dialog } from "../../dialog.js";
import { act, failureWords } from "../../use-action.js";
import { useShell } from "../../app-shell.js";
import { useSettingsRead } from "../use-settings-read.js";
import { SettingsError, SettingsGroup, SettingsRow, SettingsSwitch } from "../primitives.js";

const operationWords = {
  "agent-operation": "an agent’s action",
  "automation-firing": "an automation",
  "chat-reply": "a chat reply",
} as const;

/** A problem's fields, said plainly; each is an enum or a number from the one table. */
export function problemDetail(problem: Problem): string {
  const { fields } = problem;
  const parts: string[] = [];
  if (fields.engine)
    parts.push(
      fields.engine === "other"
        ? "Another engine"
        : (harnessCatalogEntry(fields.engine)?.label ?? fields.engine),
    );
  if (fields.operation) parts.push(operationWords[fields.operation]);
  if (fields.service) parts.push(`The ${fields.service} service`);
  if (fields.disk) parts.push(fields.disk === "over-95" ? "More than 95% full" : "85–95% full");
  if (fields.updateTarget)
    parts.push(fields.updateTarget === "desktop" ? "The desktop app" : "This Home");
  if (problem.count > 1) parts.push(`${problem.count} times`);
  parts.push(problemTable[problem.code].next);
  return parts.join(" · ");
}

const fullReport =
  "this Home’s kind and version; where this Home knows them, its disk as a range, each service’s health and its last backup and update with their times to the minute; and each problem’s code, its fixed details, how many times it happened and when, to the minute";
const never = "Never a name, a page, a task, a file, an account or an error’s own words.";

/**
 * What goes where, in words that are exactly true of the body below them (R3): what is sent,
 * what the receiver sees besides it, and what is kept.
 */
export function reportWords(reporting: ProblemReporting): readonly string[] {
  if (reporting.mode === "operator")
    return [
      `Every 15 minutes Opensteer, which runs this Cloud Computer, receives ${fullReport}. ${never}`,
      "It keeps only the latest one. Opensteer also keeps its own record of this computer’s setup, billing and backups.",
    ];
  if (reporting.destination === "own")
    return [
      `Every 15 minutes while this is on, the address this Home’s operator set receives ${fullReport}. ${never}`,
      "That address also sees the internet address the report comes from. What it keeps is up to whoever runs it.",
    ];
  if (reporting.destination === "opensteer")
    return [
      "Once a day while this is on, Opensteer receives this Home’s kind and Opensteer version, and the code of each problem it has with roughly how many times it happened (1, 2–9, 10–99 or 100 and more). No times, and no account or id. " +
        never,
      "Opensteer also sees the internet address it comes from, which its servers’ request logs may keep for a while. The Opensteer account keeps only how many reports named each code on each day, and logs nothing of a report.",
    ];
  return ["This Home has no address to send reports to, so nothing is sent."];
}

/** What is sent, said plainly, then the exact bytes: the same string the Home sends. */
function ReportPreview({
  reporting,
  body,
}: {
  readonly reporting: ProblemReporting;
  readonly body: string | null;
}) {
  return (
    <>
      {reportWords(reporting).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {body === null ? null : (
        <>
          <p>Exactly this is sent:</p>
          <pre className="problem-report__exact">{body}</pre>
        </>
      )}
    </>
  );
}

function reportingDetail(reporting: ProblemReporting): string {
  if (reporting.mode === "operator")
    return "Opensteer runs this Cloud Computer and receives its health report every 15 minutes.";
  if (reporting.destination === "none") return "This Home has no address to send reports to.";
  const where = destinationWords(reporting);
  const when = reporting.destination === "opensteer" ? "once a day" : "every 15 minutes";
  return reporting.mode === "on"
    ? `Sent to ${where} ${when}. Off stops it.`
    : `Off: nothing is sent. On sends a report to ${where} ${when}.`;
}

function destinationWords(reporting: ProblemReporting): string {
  return reporting.destination === "own" ? "the address this Home’s operator set" : "Opensteer";
}

/** This Home's problems in plain words, and what it sends (or would send) about them. */
export function ProblemsGroup() {
  const { hostClient } = useShell();
  const read = useSettingsRead(
    async () => unwrapRpcResult(await hostClient.rpc["problems.get"]({})),
    "problems",
    false,
    undefined,
    "problems",
  );
  const [showing, setShowing] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = read.data;
  if (!view) return read.error ? <SettingsError message={read.error} /> : null;
  const { problems, reporting, body } = view;
  const choose = (send: boolean) => {
    setPending(send);
    setError(null);
    void act(hostClient, { label: "change this", done: "changed" }, () =>
      hostClient.setProblemReports(send),
    )
      .then(() => read.reload())
      .catch((cause: unknown) => setError(failureWords(cause)))
      .finally(() => setPending(null));
  };
  const switchLabel =
    reporting.destination === "own"
      ? "Send problem reports to this Home’s own address"
      : "Send problem reports to Opensteer";
  return (
    <SettingsGroup heading="Problems" headingId="settings-general-problems">
      {problems.length === 0 ? (
        <SettingsRow detail="Opensteer has found nothing wrong on this Home." title="No problems" />
      ) : (
        problems.map((problem) => (
          <SettingsRow
            detail={problemDetail(problem)}
            key={`${problem.code} ${JSON.stringify(problem.fields)}`}
            title={problemTable[problem.code].words}
          />
        ))
      )}
      <SettingsRow
        action={
          reporting.mode === "operator" ? undefined : (
            <SettingsSwitch
              checked={pending ?? reporting.mode === "on"}
              disabled={pending !== null || reporting.destination === "none"}
              label={switchLabel}
              onChange={choose}
            />
          )
        }
        detail={
          <>
            {reportingDetail(reporting)}{" "}
            <button className="link" type="button" onClick={() => setShowing(true)}>
              {reporting.mode === "operator"
                ? "See what Opensteer receives"
                : "See what would be sent"}
            </button>
          </>
        }
        title={
          reporting.mode === "operator" ? "What Opensteer can see about this computer" : switchLabel
        }
      />
      <SettingsError message={error} />
      {showing ? (
        <Dialog
          labelledBy="problem-report"
          title="The problem report"
          onClose={() => setShowing(false)}
        >
          <ReportPreview reporting={reporting} body={body} />
        </Dialog>
      ) : null}
    </SettingsGroup>
  );
}
