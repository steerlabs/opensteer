import { useState } from "react";
import { harnessCatalogEntry } from "@opensteer/core";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { ProblemReporting } from "@opensteer/protocol";
import { problemTable, type HomeHealthReport, type Problem } from "@opensteer/protocol/problems";
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

const homeWords: Readonly<Record<HomeHealthReport["home"], string>> = {
  "cloud-computer": "Cloud Computer",
  server: "Linux server",
  mac: "Mac",
  other: "Other computer",
};

/** Exactly what the report holds, field by field, then as it is sent. */
function ReportPreview({ report }: { readonly report: HomeHealthReport }) {
  const rows: [string, string][] = [
    ["Kind of Home", homeWords[report.home]],
    ["Version", report.version],
    ...(report.disk
      ? [
          [
            "Disk used",
            `${report.disk.replace("under-", "under ").replace("over-", "over ")}%`,
          ] as [string, string],
        ]
      : []),
    ...Object.entries(report.services ?? {}).map(
      ([service, health]) => [`Service ${service}`, health] as [string, string],
    ),
    ...(report.lastBackup
      ? [
          [
            "Last backup",
            `${report.lastBackup.result}${report.lastBackup.failure ? ` (${report.lastBackup.failure})` : ""}, ${report.lastBackup.at}`,
          ] as [string, string],
        ]
      : []),
    ...(report.lastUpdate
      ? [
          ["Last update", `${report.lastUpdate.result}, ${report.lastUpdate.at}`] as [
            string,
            string,
          ],
        ]
      : []),
    ...report.problems.map(
      (problem) => [`Problem ${problem.code}`, `${problem.count}`] as [string, string],
    ),
  ];
  return (
    <>
      <p>
        A code for each problem and how many times it happened, nothing else: never a page, a task,
        a file, an account, a name or an error’s own words.
      </p>
      <dl className="problem-report">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>Exactly this is sent:</p>
      <pre className="problem-report__exact">{JSON.stringify(report, null, 2)}</pre>
    </>
  );
}

function reportingDetail(reporting: ProblemReporting): string {
  if (reporting.mode === "operator")
    return "Opensteer runs this Cloud Computer and receives this report every 15 minutes.";
  if (reporting.destination === "none") return "This Home has no address to send reports to.";
  const where =
    reporting.destination === "own" ? "the address this Home’s operator set" : "Opensteer";
  return reporting.mode === "on"
    ? `Sent to ${where} every 15 minutes. Off stops it.`
    : `Off: nothing is sent. On sends this report to ${where} every 15 minutes.`;
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
  const { problems, reporting, report } = view;
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
              label="Send problem reports to Opensteer"
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
          reporting.mode === "operator"
            ? "What Opensteer can see about this computer"
            : "Send problem reports to Opensteer"
        }
      />
      <SettingsError message={error} />
      {showing ? (
        <Dialog
          labelledBy="problem-report"
          title="The problem report"
          onClose={() => setShowing(false)}
        >
          <ReportPreview report={report} />
        </Dialog>
      ) : null}
    </SettingsGroup>
  );
}
