import { useState } from "react";
import { harnessCatalogEntry } from "@opensteer/core";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { ProblemReporting } from "@opensteer/protocol";
import { problemTable, type Problem } from "@opensteer/protocol/problems";
import { Dialog } from "../../dialog.js";
import { useShell } from "../../app-shell.js";
import { useSettingsRead } from "../use-settings-read.js";
import { SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";

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

/** Said where nothing is sent: a person's own Home, and any Home with no collector set. */
export const nothingLeaves = "Nothing about these problems leaves this computer.";

/**
 * What goes where, in words that are exactly true of the body below them: what is sent, what
 * the receiver sees besides it, and what is kept.
 */
export function reportWords(reporting: ProblemReporting): readonly string[] {
  if (reporting.destination === "operator")
    return [
      `Every 15 minutes Opensteer, which runs this Cloud Computer, receives ${fullReport}. ${never}`,
      "It keeps the latest one. When a report names a problem that needs someone, it also logs this computer’s id, its version and those problems’ codes. Opensteer also keeps its own record of this computer’s setup, billing and backups.",
    ];
  if (reporting.destination === "own")
    return [
      `Every 15 minutes, the address this Home’s operator set receives ${fullReport}. ${never}`,
      "That address also sees the internet address the report comes from. What it keeps is up to whoever runs it.",
    ];
  return [nothingLeaves];
}

/** What is sent, said plainly, then the exact bytes: the same string the Home sends. */
function ReportPreview({
  reporting,
  body,
}: {
  readonly reporting: ProblemReporting;
  readonly body: string;
}) {
  return (
    <>
      {reportWords(reporting).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p>Exactly this is sent:</p>
      <pre className="problem-report__exact">{body}</pre>
    </>
  );
}

/** This Home's problems in plain words, and what it sends about them, if anything. */
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
  const view = read.data;
  if (!view) return read.error ? <SettingsError message={read.error} /> : null;
  const { problems, reporting, body } = view;
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
      {reporting.destination === "none" || body === null ? (
        <SettingsRow detail={nothingLeaves} title="Problem reports" />
      ) : (
        <SettingsRow
          detail={
            <>
              {reporting.destination === "operator"
                ? "Opensteer runs this Cloud Computer and receives its health report every 15 minutes."
                : "This Home sends its health report every 15 minutes to the address its operator set."}{" "}
              <button className="link" type="button" onClick={() => setShowing(true)}>
                See what is sent
              </button>
            </>
          }
          title={
            reporting.destination === "operator"
              ? "What Opensteer can see about this computer"
              : "Problem reports to this Home’s own address"
          }
        />
      )}
      {showing && body !== null ? (
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
